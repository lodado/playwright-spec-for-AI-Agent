import { writeFileSync } from "node:fs";
import { AgentOutputError, EnvironmentError } from "./errors.mjs";

/**
 * Adapter-neutral agent output handling: redaction, raw-artifact writing, and
 * JSON extraction. Every backend (hermes, aside, exec, fixture, third-party)
 * shares this so the "did the agent answer with usable JSON?" contract is
 * defined once instead of inside one backend's module.
 */

/**
 * Prefer the model's final answer block over startup banners. Hermes prints
 * this banner; other backends do not, in which case the whole text is returned
 * unchanged and the caller falls back to the raw surface.
 */
export function extractFinalResponseText(output) {
  const text = output ?? "";
  const finalBlock = text.match(
    /🎯\s*FINAL RESPONSE:\s*\n-+\s*\n([\s\S]*?)(?:\n={3,}|\n📋 CONVERSATION SUMMARY|\n--- stderr ---|$)/i
  );
  if (finalBlock?.[1]?.trim()) {
    return finalBlock[1].trim();
  }

  const altBlock = text.match(
    /FINAL RESPONSE:\s*\n-+\s*\n([\s\S]*?)(?:\n={3,}|\n📋 CONVERSATION SUMMARY|$)/i
  );
  if (altBlock?.[1]?.trim()) {
    return altBlock[1].trim();
  }

  return text;
}

export function unwrapAgentEnvelope(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;

  if (typeof parsed.result === "string") {
    const trimmed = parsed.result.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return parsed;
      }
    }
  }

  if (parsed.result && typeof parsed.result === "object") {
    return parsed.result;
  }

  return parsed;
}

/** @deprecated Pass stdout/stderr to {@link extractAgentJson} instead. */
export function prepareJsonParseSurface(stdout, stderr = "") {
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  const final = extractFinalResponseText(combined);
  return final !== combined ? `${final}\n\n${combined}` : combined;
}

/** End index of the object opened at `start`, or -1 when it never closes. */
function findObjectEnd(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Candidates from one surface, latest position first. Only OUTERMOST objects
 * are collected: an inner `{"status":429}` inside a larger envelope must never
 * outrank the envelope that contains it.
 */
function collectCandidates(surface) {
  const found = [];
  for (const match of surface.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    found.push({ index: match.index ?? 0, text: match[1] });
  }
  for (let start = 0; start < surface.length; start += 1) {
    if (surface[start] !== "{") continue;
    const end = findObjectEnd(surface, start);
    if (end === -1) continue;
    found.push({ index: start, text: surface.slice(start, end + 1) });
    start = end;
  }
  return found.sort((a, b) => b.index - a.index).map(entry => entry.text);
}

function matchesRequiredKeys(parsed, keys) {
  return keys.every(key => key in parsed);
}

/**
 * A judge payload's `status` is an enum string. A trailing `{"status":429}` in
 * an HTTP error dumped on stderr satisfies `requiredKeys: ["status"]` but is
 * not a judgment — shape has to be checked, not just key presence.
 */
function defaultValidate(parsed, keys) {
  if (!keys.includes("status")) return true;
  return typeof parsed.status === "string";
}

/**
 * @param {string} output stdout (or the whole captured surface)
 * @param {object} [options]
 * @param {string} [options.stderr] captured stderr, searched only after stdout
 * @param {(parsed: object) => boolean} [options.validate] shape sanity check
 */
export function extractAgentJson(
  output,
  {
    stderr = "",
    requiredKeys = ["status"],
    /** If set, any group that matches wins (e.g. [["livePlan","testUpdates"],["livePlan","spec"]]). */
    requiredKeyGroups = null,
    rawOutputPath = null,
    adapterLabel = "agent",
    validate = null,
  } = {}
) {
  const keys = Array.isArray(requiredKeys) ? requiredKeys : [requiredKeys];
  const groups = Array.isArray(requiredKeyGroups) ? requiredKeyGroups : null;
  const allKeys = groups ? groups.flat() : keys;

  const stdoutText = output ?? "";
  const combined = [stdoutText, stderr].filter(Boolean).join("\n");
  // Highest-priority surface first: the model's own final answer beats the raw
  // stream, and stdout beats stdout+stderr (stderr carries provider noise).
  const surfaces = [
    extractFinalResponseText(stdoutText),
    stdoutText,
    extractFinalResponseText(combined),
    combined,
  ].filter((surface, index, all) => surface && all.indexOf(surface) === index);

  for (const surface of surfaces) {
    for (const candidate of collectCandidates(surface)) {
      let parsed;
      try {
        parsed = unwrapAgentEnvelope(JSON.parse(candidate));
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }

      const hasKeys = groups
        ? groups.some(group => matchesRequiredKeys(parsed, group))
        : matchesRequiredKeys(parsed, keys);
      if (!hasKeys) continue;

      const shapeOk = validate
        ? validate(parsed)
        : defaultValidate(parsed, allKeys);
      if (shapeOk) return parsed;
    }
  }

  const keyHint = groups
    ? groups.map(group => group.join("+")).join(" OR ")
    : keys.join(", ");
  const artifactHint = rawOutputPath ? ` Raw output: ${rawOutputPath}` : "";
  throw new AgentOutputError(
    `${adapterLabel} did not return valid JSON (required: ${keyHint}).${artifactHint} Preview: ${surfaces[0].slice(0, 2_000)}`,
    {
      hint: rawOutputPath
        ? `Inspect ${rawOutputPath} to see what the agent actually printed.`
        : "",
    }
  );
}

function redactProviderNoise(output) {
  return output
    .replace(/Using API key: .*/g, "Using API key: [redacted]")
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token)=)[^\s&"']+/gi,
      "$1[redacted]"
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[redacted]")
    .replace(
      /API key was rejected by the provider\.[\s\S]*$/m,
      "API key was rejected. [redacted]"
    );
}

export function redactSensitiveText(text, secrets = []) {
  let redacted = redactProviderNoise(text ?? "");
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[redacted]");
    redacted = redacted.split(encodeURIComponent(secret)).join("[redacted]");
  }
  return redacted
    .replace(/([?&](?:email|password)=)[^\s&"']*/gi, "$1[redacted]")
    .replace(/("--password=)(?:\\.|[^"\\\s])+/g, "$1[redacted]")
    .replace(
      /("(?:email|password)"\s*:\s*")(?:\\.|[^"\\])*(")/gi,
      "$1[redacted]$2"
    );
}

/** Stage-specific artifact keys, one per pipeline stage. */
export function resolveAgentQueryPath(paths) {
  return (
    paths?.hermesQuery ??
    paths?.hermesAbstractQuery ??
    paths?.hermesReviewQuery ??
    null
  );
}

export function resolveAgentRawOutputPath(paths) {
  return (
    paths?.hermesRawOutput ??
    paths?.hermesAbstractRawOutput ??
    paths?.hermesReviewRawOutput ??
    null
  );
}

export function writeAgentQueryArtifact(paths, query, secrets = []) {
  const queryPath = resolveAgentQueryPath(paths);
  if (queryPath) writeFileSync(queryPath, redactSensitiveText(query, secrets));
  return queryPath;
}

/**
 * Post-spawn handling shared by every CLI-backed adapter.
 *
 * The raw artifact is written BEFORE any throw — a ten-minute run that ends in
 * a timeout must still leave the operator everything the agent printed.
 *
 * @param {import("node:child_process").SpawnSyncReturns<string>} result
 */
export function finalizeAgentRun(
  result,
  {
    adapterLabel = "agent",
    command = adapterLabel,
    paths = null,
    secrets = [],
    requiredKeys = ["status"],
    requiredKeyGroups = null,
    validate = null,
    timeoutMs = null,
    timeoutHint = "",
    /** Called with the redacted output before exit-status handling. */
    inspect = null,
  } = {}
) {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combinedOutput = [
    stdout ? `--- stdout ---\n${stdout}` : "",
    stderr ? `--- stderr ---\n${stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const redactedCombinedOutput = redactSensitiveText(
    combinedOutput || "no output",
    secrets
  );

  const rawPath = resolveAgentRawOutputPath(paths);
  if (rawPath) writeFileSync(rawPath, redactedCombinedOutput);
  const where = rawPath ? ` Partial output: ${rawPath}` : "";

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new EnvironmentError(
        `${adapterLabel} timed out after ${timeoutMs}ms.${where}`,
        { hint: timeoutHint, cause: result.error }
      );
    }
    if (result.error.code === "ENOENT") {
      throw new EnvironmentError(
        `${adapterLabel} command not found: ${command}.${where}`,
        { cause: result.error }
      );
    }
    throw new EnvironmentError(
      `${adapterLabel} could not run ${command}: ${result.error.message}.${where}`,
      { cause: result.error }
    );
  }

  inspect?.(redactedCombinedOutput, rawPath);

  if (result.status !== 0) {
    throw new EnvironmentError(
      `${adapterLabel} failed (exit ${result.status}): ${redactSensitiveText(stderr || stdout || "no output", secrets)}${where}`
    );
  }

  return extractAgentJson(redactSensitiveText(stdout, secrets), {
    stderr: redactSensitiveText(stderr, secrets),
    requiredKeys,
    requiredKeyGroups,
    validate,
    rawOutputPath: rawPath,
    adapterLabel,
  });
}

/** Wall-clock guard shared by every CLI adapter (10 minutes). */
export const AGENT_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function resolveTimeoutMs(envVar, fallback = AGENT_DEFAULT_TIMEOUT_MS) {
  const parsed = Number(process.env[envVar]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
