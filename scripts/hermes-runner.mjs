import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const REQUIRED_HERMES_AGENT_BIN = "hermes-agent";
export const HERMES_QA_COMMAND =
  process.env.HERMES_QA_COMMAND?.trim() || REQUIRED_HERMES_AGENT_BIN;

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

export function buildHermesAgentArgs(query, maxTurns) {
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
  return args;
}

export function extractJsonFromHermesOutput(output, { requiredKeys = ["status"], rawOutputPath = null } = {}) {
  const candidates = [];

  for (const match of output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1]);
  }

  for (let start = 0; start < output.length; start += 1) {
    if (output[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const char = output[index];
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
          candidates.push(output.slice(start, index + 1));
          break;
        }
      }
    }
  }

  const keys = Array.isArray(requiredKeys) ? requiredKeys : [requiredKeys];

  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed === "object" &&
        keys.every(key => key in parsed)
      ) {
        return parsed;
      }
    } catch {
      // Keep scanning.
    }
  }

  const artifactHint = rawOutputPath ? ` See raw output: ${rawOutputPath}` : "";
  throw new Error(
    `Hermes did not return valid JSON (required keys: ${keys.join(", ")}).${artifactHint} Preview: ${output.slice(0, 2_000)}`
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

export function runHermes(query, maxTurns, { paths = null, secrets = [], requiredKeys = ["status"] } = {}) {
  if (HERMES_QA_COMMAND !== REQUIRED_HERMES_AGENT_BIN) {
    throw new Error(
      `Hermes command must be exactly ${REQUIRED_HERMES_AGENT_BIN}. Got: ${JSON.stringify(HERMES_QA_COMMAND)}`
    );
  }

  const invocation = resolveHermesAgentInvocation();
  const queryPath = paths?.hermesQuery ?? paths?.hermesAbstractQuery;
  if (queryPath) {
    writeFileSync(queryPath, redactSensitiveText(query, secrets));
  }

  const result = spawnSync(
    invocation.command,
    [...invocation.baseArgs, ...buildHermesAgentArgs(query, maxTurns)],
    {
      shell: false,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10,
    }
  );

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

  const rawPath = paths?.hermesRawOutput ?? paths?.hermesAbstractRawOutput;
  if (rawPath) {
    writeFileSync(rawPath, redactedCombinedOutput);
  }

  throwIfHermesAuthRejected(redactedCombinedOutput, rawPath);

  if (result.status !== 0) {
    throw new Error(
      `Hermes failed (exit ${result.status}): ${redactSensitiveText(result.stderr || result.stdout || "no output", secrets)}`
    );
  }

  const redactedStdout = redactSensitiveText(result.stdout, secrets);
  return extractJsonFromHermesOutput(redactedStdout, {
    requiredKeys,
    rawOutputPath: rawPath,
  });
}
