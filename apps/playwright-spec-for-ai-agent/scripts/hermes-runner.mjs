import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const REQUIRED_HERMES_AGENT_BIN = "hermes-agent";
export const HERMES_QA_COMMAND =
  process.env.HERMES_QA_COMMAND?.trim() || REQUIRED_HERMES_AGENT_BIN;

/** Disable browsing/terminal for abstract-ai and review (JSON-in, JSON-out). */
export function resolveTextOnlyDisabledToolsets(configured = process.env.HERMES_QA_DISABLED_TOOLSETS) {
  return [...new Set([
    "*",
    ...(configured ?? "").split(",").map(item => item.trim()).filter(Boolean),
  ])].join(",");
}

export const HERMES_QA_TEXT_ONLY_DISABLED_TOOLSETS = resolveTextOnlyDisabledToolsets();

/**
 * Hermes memory toolset, disabled on every QA run so the agent cannot write
 * long-term memory that would carry into a later run — QA judgments must boot
 * fresh each time, never learned from prior runs.
 */
export const HERMES_QA_STATELESS_DISABLED_TOOLSETS = "memory";

/** Browse keeps legacy boot files; text-only receives only provider auth and model config. */
const HERMES_HOME_BOOT_FILES = ["auth.json", "config.yaml", ".env", "SOUL.md"];
const HERMES_TEXT_ONLY_HOME_BOOT_FILES = ["auth.json", "config.yaml"];
const HERMES_TEXT_ONLY_ENV_KEYS = [
  "ALL_PROXY",
  "ComSpec",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
];

/**
 * Seed a throwaway HERMES_HOME so every Hermes run boots stateless: empty
 * memories/ and sessions/, so nothing from one QA run leaks into the next.
 * Only mode-specific boot files are copied from the real ~/.hermes. Returns
 * the path plus cleanup() to delete it.
 */
export function prepareEphemeralHermesHome({
  mode = "browse",
  sourceHome = join(homedir(), ".hermes"),
  makeTemporaryHome = () => mkdtempSync(join(tmpdir(), "hermes-qa-home-")),
} = {}) {
  const path = makeTemporaryHome();
  const bootFiles = mode === "text-only" ? HERMES_TEXT_ONLY_HOME_BOOT_FILES : HERMES_HOME_BOOT_FILES;
  try {
    for (const name of bootFiles) {
      const src = join(sourceHome, name);
      if (existsSync(src)) cpSync(src, join(path, name));
    }
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    cleanup() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

export function buildHermesChildEnv(mode, hermesHome, source = process.env) {
  if (mode !== "text-only") return { ...source, HERMES_HOME: hermesHome };
  const env = Object.fromEntries(HERMES_TEXT_ONLY_ENV_KEYS.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  return { ...env, HOME: hermesHome, USERPROFILE: hermesHome, HERMES_HOME: hermesHome };
}

export function resolveHermesAgentInvocation() {
  const installRoot = join(homedir(), ".hermes", "hermes-agent");
  const localPython = join(installRoot, "venv", "bin", "python");
  const localRunner = join(installRoot, "run_agent.py");
  if (existsSync(localPython) && existsSync(localRunner)) {
    return { command: localPython, baseArgs: [localRunner] };
  }

  const localInstallBin = join(
    homedir(),
    ".hermes",
    "hermes-agent",
    "venv",
    "bin",
    REQUIRED_HERMES_AGENT_BIN
  );
  if (existsSync(localInstallBin)) {
    return { command: localInstallBin, baseArgs: [] };
  }

  return { command: REQUIRED_HERMES_AGENT_BIN, baseArgs: [] };
}

export function readHermesModelConfig() {
  const envModel = process.env.HERMES_INFERENCE_MODEL?.trim();
  if (envModel) {
    return {
      model: envModel,
      baseUrl: process.env.HERMES_INFERENCE_BASE_URL?.trim() || null,
    };
  }

  const configPath = join(homedir(), ".hermes", "config.yaml");
  if (!existsSync(configPath)) {
    return { model: null, baseUrl: null };
  }

  const text = readFileSync(configPath, "utf8");
  const readField = name => {
    const match = text.match(new RegExp(`^  ${name}:\\s*(.+)$`, "m"));
    if (!match) return null;
    return match[1].trim().replace(/^['"]|['"]$/g, "");
  };

  return {
    model: readField("default") || readField("model"),
    baseUrl: readField("base_url"),
  };
}

export function buildHermesAgentArgs(
  query,
  maxTurns,
  { disabledToolsets = null, verbose = false } = {}
) {
  const { model, baseUrl } = readHermesModelConfig();
  if (!model) {
    throw new Error(
      "Hermes model is not configured. Set model.default in ~/.hermes/config.yaml or export HERMES_INFERENCE_MODEL."
    );
  }

  const args = [
    `--query=${query}`,
    `--max_turns=${maxTurns}`,
    `--model=${model}`,
  ];
  if (baseUrl) args.push(`--base_url=${baseUrl}`);
  // Fire splits on commas unless the value is quoted: --disabled_toolsets="a,b,c"
  if (disabledToolsets) {
    args.push(`--disabled_toolsets="${disabledToolsets}"`);
  }
  if (verbose) args.push("--verbose");
  return args;
}

/**
 * Prefer the model's final answer block over Hermes startup banners.
 */
export function extractHermesFinalResponseText(output) {
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

export function unwrapHermesEnvelope(parsed) {
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

export function prepareHermesJsonParseSurface(stdout, stderr = "") {
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  const final = extractHermesFinalResponseText(combined);
  return final !== combined ? `${final}\n\n${combined}` : combined;
}

function matchesRequiredKeys(parsed, keys) {
  return keys.every(key => key in parsed);
}

export function extractJsonFromHermesOutput(
  output,
  {
    requiredKeys = ["status"],
    /** If set, any group that matches wins (e.g. [["livePlan","testUpdates"],["livePlan","spec"]]). */
    requiredKeyGroups = null,
    rawOutputPath = null,
  } = {}
) {
  const surface = extractHermesFinalResponseText(output);
  const candidates = [];

  for (const match of surface.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1]);
  }

  for (const source of [surface, output]) {
    for (let start = 0; start < source.length; start += 1) {
      if (source[start] !== "{") continue;
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
          if (depth === 0) {
            candidates.push(source.slice(start, index + 1));
            break;
          }
        }
      }
    }
  }

  const keys = Array.isArray(requiredKeys) ? requiredKeys : [requiredKeys];
  const groups = Array.isArray(requiredKeyGroups) ? requiredKeyGroups : null;

  for (const candidate of candidates.reverse()) {
    try {
      const parsed = unwrapHermesEnvelope(JSON.parse(candidate));
      if (!parsed || typeof parsed !== "object") continue;

      const ok = groups
        ? groups.some(group => matchesRequiredKeys(parsed, group))
        : matchesRequiredKeys(parsed, keys);

      if (ok) return parsed;
    } catch {
      // Keep scanning.
    }
  }

  const keyHint = groups
    ? groups.map(g => g.join("+")).join(" OR ")
    : keys.join(", ");
  const artifactHint = rawOutputPath ? ` See raw output: ${rawOutputPath}` : "";
  throw new Error(
    `Hermes did not return valid JSON (required: ${keyHint}).${artifactHint} Preview: ${surface.slice(0, 2_000)}`
  );
}

function redactHermesOutput(output) {
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
  let redacted = redactHermesOutput(text ?? "");
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

function throwIfHermesAuthRejected(output, rawOutputPath = null) {
  if (!/API key was rejected|PermissionDeniedError|HTTP 403/i.test(output)) {
    return;
  }
  const artifactHint = rawOutputPath ? ` See raw output: ${rawOutputPath}` : "";
  throw new Error(
    `Hermes API key was rejected or permission denied.${artifactHint}`
  );
}

/**
 * @param {"browse"|"text-only"} [options.mode]
 *   text-only — disable every toolset (offline semantic judgment)
 *   browse — full toolsets (judge)
 */
export function runHermes(
  query,
  maxTurns,
  {
    paths = null,
    secrets = [],
    requiredKeys = ["status"],
    requiredKeyGroups = null,
    mode = "browse",
  } = {}
) {
  if (HERMES_QA_COMMAND !== REQUIRED_HERMES_AGENT_BIN) {
    throw new Error(
      `Hermes command must be exactly ${REQUIRED_HERMES_AGENT_BIN}. Got: ${JSON.stringify(HERMES_QA_COMMAND)}`
    );
  }

  const disabledToolsets = [
    mode === "text-only" ? HERMES_QA_TEXT_ONLY_DISABLED_TOOLSETS : null,
    HERMES_QA_STATELESS_DISABLED_TOOLSETS,
  ]
    .filter(Boolean)
    .join(",");

  const invocation = resolveHermesAgentInvocation();
  const queryPath =
    paths?.hermesQuery ??
    paths?.hermesAbstractQuery ??
    paths?.hermesReviewQuery;
  if (queryPath) {
    writeFileSync(queryPath, redactSensitiveText(query, secrets));
  }

  // Fresh HERMES_HOME per run: empty memories/ and sessions/ so nothing learned
  // in one QA run carries into the next. Torn down as soon as Hermes exits.
  const hermesHome = prepareEphemeralHermesHome({ mode });
  let result;
  try {
    result = spawnSync(
      invocation.command,
      [
        ...invocation.baseArgs,
        ...buildHermesAgentArgs(query, maxTurns, { disabledToolsets }),
      ],
      {
        shell: false,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 10,
        env: buildHermesChildEnv(mode, hermesHome.path),
      }
    );
  } finally {
    hermesHome.cleanup();
  }

  if (result.error) throw result.error;

  const combinedOutput = [
    result.stdout ? `--- stdout ---\n${result.stdout}` : "",
    result.stderr ? `--- stderr ---\n${result.stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const redactedCombinedOutput = redactSensitiveText(
    combinedOutput || "no output",
    secrets
  );

  const rawPath =
    paths?.hermesRawOutput ??
    paths?.hermesAbstractRawOutput ??
    paths?.hermesReviewRawOutput;
  if (rawPath) {
    writeFileSync(rawPath, redactedCombinedOutput);
  }

  throwIfHermesAuthRejected(redactedCombinedOutput, rawPath);

  if (result.status !== 0) {
    throw new Error(
      `Hermes failed (exit ${result.status}): ${redactSensitiveText(result.stderr || result.stdout || "no output", secrets)}`
    );
  }

  const parseSurface = redactSensitiveText(
    prepareHermesJsonParseSurface(result.stdout, result.stderr),
    secrets
  );

  return extractJsonFromHermesOutput(parseSurface, {
    requiredKeys,
    requiredKeyGroups,
    rawOutputPath: rawPath,
  });
}
