import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  AGENT_DEFAULT_TIMEOUT_MS,
  extractAgentJson,
  extractFinalResponseText,
  finalizeAgentRun,
  prepareJsonParseSurface,
  redactSensitiveText,
  resolveTimeoutMs,
  unwrapAgentEnvelope,
  writeAgentQueryArtifact,
} from "./agent-output.mjs";
import { EnvironmentError, UsageError } from "./errors.mjs";

// Adapter-neutral helpers now live in agent-output.mjs; re-exported under their
// original names because callers and tests still import them from here.
export { redactSensitiveText };
export const extractHermesFinalResponseText = extractFinalResponseText;
export const unwrapHermesEnvelope = unwrapAgentEnvelope;
export const prepareHermesJsonParseSurface = prepareJsonParseSurface;
export function extractJsonFromHermesOutput(output, options = {}) {
  return extractAgentJson(output, { adapterLabel: "hermes", ...options });
}

export const REQUIRED_HERMES_AGENT_BIN = "hermes-agent";
export const HERMES_QA_COMMAND =
  process.env.HERMES_QA_COMMAND?.trim() || REQUIRED_HERMES_AGENT_BIN;

/**
 * --max_turns caps conversation length, not wall clock: a single turn that
 * stalls (API hang, CDP deadlock) would block a nightly forever without this.
 */
export const HERMES_QA_DEFAULT_TIMEOUT_MS = AGENT_DEFAULT_TIMEOUT_MS;

export function resolveHermesTimeoutMs() {
  return resolveTimeoutMs("HERMES_QA_TIMEOUT_MS", HERMES_QA_DEFAULT_TIMEOUT_MS);
}

/** Disable browsing/terminal for abstract-ai and review (JSON-in, JSON-out). */
export const HERMES_QA_TEXT_ONLY_DISABLED_TOOLSETS =
  process.env.HERMES_QA_DISABLED_TOOLSETS?.trim() ||
  "browser,web,terminal";

/**
 * Hermes memory toolset, disabled on every QA run so the agent cannot write
 * long-term memory that would carry into a later run — QA judgments must boot
 * fresh each time, never learned from prior runs.
 */
export const HERMES_QA_STATELESS_DISABLED_TOOLSETS = "memory";

/** Boot-critical files copied into the ephemeral home. Never memories/sessions. */
const HERMES_HOME_BOOT_FILES = ["auth.json", "config.yaml", ".env", "SOUL.md"];

/**
 * Seed a throwaway HERMES_HOME so every Hermes run boots stateless: empty
 * memories/ and sessions/, so nothing from one QA run leaks into the next.
 * Only boot-critical, non-learned files (auth, model config, persona) are
 * copied from the real ~/.hermes. Returns the path plus cleanup() to delete it.
 */
export function prepareEphemeralHermesHome() {
  const realHome = join(homedir(), ".hermes");
  const path = mkdtempSync(join(tmpdir(), "hermes-qa-home-"));
  for (const name of HERMES_HOME_BOOT_FILES) {
    const src = join(realHome, name);
    if (existsSync(src)) cpSync(src, join(path, name));
  }
  return {
    path,
    cleanup() {
      rmSync(path, { recursive: true, force: true });
    },
  };
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
    throw new EnvironmentError(
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
 * An agent that never started is an environment failure, not unusable output.
 * Hermes prints its own diagnosis and exits 0, so without this the run surfaces
 * as "did not return valid JSON" (exit 4) and sends the operator hunting for a
 * parser bug instead of an unset API key.
 */
function throwIfHermesDidNotStart(output, rawOutputPath = null) {
  const artifactHint = rawOutputPath ? ` See raw output: ${rawOutputPath}` : "";

  if (/API key was rejected|PermissionDeniedError|HTTP 403/i.test(output)) {
    throw new EnvironmentError(
      `Hermes API key was rejected or permission denied.${artifactHint}`
    );
  }

  const failedToInit = output.match(/Failed to initialize agent:\s*(.+)/i);
  if (failedToInit) {
    throw new EnvironmentError(
      `Hermes could not start: ${failedToInit[1].trim()}${artifactHint}`,
      {
        hint: "Fix the provider/model in ~/.hermes/config.yaml (or `hermes model`), then re-run. `doctor` checks this before a run.",
      }
    );
  }
}

/**
 * @param {"browse"|"text-only"} [options.mode]
 *   text-only — disable browser/terminal toolsets (abstract-ai, review)
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
    throw new UsageError(
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
  writeAgentQueryArtifact(paths, query, secrets);

  // Fresh HERMES_HOME per run: empty memories/ and sessions/ so nothing learned
  // in one QA run carries into the next. Torn down as soon as Hermes exits.
  const hermesHome = prepareEphemeralHermesHome();
  const timeout = resolveHermesTimeoutMs();
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
        env: { ...process.env, HERMES_HOME: hermesHome.path },
        timeout,
      }
    );
  } finally {
    hermesHome.cleanup();
  }

  return finalizeAgentRun(result, {
    adapterLabel: "Hermes",
    command: invocation.command,
    paths,
    secrets,
    requiredKeys,
    requiredKeyGroups,
    timeoutMs: timeout,
    timeoutHint:
      "Raise HERMES_QA_TIMEOUT_MS if Hermes legitimately needs longer.",
    inspect: throwIfHermesDidNotStart,
  });
}
