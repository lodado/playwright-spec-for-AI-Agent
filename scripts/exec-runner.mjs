import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AGENT_DEFAULT_TIMEOUT_MS,
  finalizeAgentRun,
  resolveTimeoutMs,
  writeAgentQueryArtifact,
} from "./agent-output.mjs";
import { EnvironmentError } from "./errors.mjs";

/**
 * Generic escape hatch for whichever agent CLI a team already runs:
 *   QA_AGENT_CMD="claude -p --output-format json"
 *   QA_AGENT_CMD="codex exec --json"
 *
 * The stage prompt goes on STDIN, never argv — prompts carry staging
 * credentials in credentials-in-prompt mode, and argv is world-readable in
 * `ps`.
 */
export const EXEC_QA_DEFAULT_TIMEOUT_MS = AGENT_DEFAULT_TIMEOUT_MS;

export function resolveExecTimeoutMs() {
  return resolveTimeoutMs("QA_AGENT_TIMEOUT_MS", EXEC_QA_DEFAULT_TIMEOUT_MS);
}

/** Split a command line into argv, honoring single and double quotes. */
export function parseAgentCommand(raw) {
  const tokens = [];
  for (const match of (raw ?? "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

export function resolveExecInvocation() {
  const raw = process.env.QA_AGENT_CMD?.trim();
  if (!raw) {
    throw new EnvironmentError(
      "QA_AI_ADAPTER=exec needs QA_AGENT_CMD (the agent CLI to run).",
      {
        hint: 'Example: QA_AGENT_CMD="claude -p --output-format json" or QA_AGENT_CMD="codex exec --json". The prompt is piped on stdin.',
      }
    );
  }
  const [command, ...args] = parseAgentCommand(raw);
  return { command, args };
}

/**
 * Browser MCP servers read the CDP endpoint from their own environment
 * variable, and the harness only knows the endpoint at run time, so a static
 * MCP config file can never name it. Under `QA_AGENT_AUTH=cdp-attach` we
 * forward `BROWSER_CDP_URL` under the names those servers already read. An
 * explicitly set value always wins, so this can only fill a gap.
 */
export const CDP_ENDPOINT_ALIASES = ["PLAYWRIGHT_MCP_CDP_ENDPOINT"];

export function execChildEnv(env = process.env) {
  if (execAdapterCapabilities().auth !== "cdp-attach") return env;
  const cdpUrl = env.BROWSER_CDP_URL?.trim();
  if (!cdpUrl) return env;
  const overlay = {};
  for (const alias of CDP_ENDPOINT_ALIASES) {
    if (!env[alias]?.trim()) overlay[alias] = cdpUrl;
  }
  return Object.keys(overlay).length ? { ...env, ...overlay } : env;
}

/**
 * `credentials-in-prompt` by default: an arbitrary CLI cannot be assumed to
 * attach to a browser we authenticated. QA_AGENT_AUTH=cdp-attach opts in for a
 * CLI whose browser tools honor BROWSER_CDP_URL.
 */
export function execAdapterCapabilities() {
  const auth = process.env.QA_AGENT_AUTH?.trim();
  return {
    auth: auth === "cdp-attach" ? "cdp-attach" : "credentials-in-prompt",
    supportsMaxTurns: false,
    supportsToolsetDisable: false,
    supportsVideo: auth === "cdp-attach",
  };
}

const CHECKPOINT_SCRIPT = fileURLToPath(new URL("./qa-checkpoint.mjs", import.meta.url));

/**
 * A terminal-only CLI cannot load Hermes's plugin, so it reaches the same
 * runner-owned checkpoint server through a shell command. The note names the
 * command; the token travels only in the child's environment.
 */
function withBrowserTools(query, env, browserTools) {
  const childEnv = { ...env };
  delete childEnv.QA_BROWSER_TOOLS_URL;
  delete childEnv.QA_BROWSER_TOOLS_TOKEN;
  if (!browserTools) return { query, env: childEnv };
  childEnv.QA_BROWSER_TOOLS_URL = browserTools.url;
  childEnv.QA_BROWSER_TOOLS_TOKEN = browserTools.token;
  const note = [
    "## qa_checkpoint in this run",
    `qa_checkpoint is available as a shell command: "${process.execPath}" "${CHECKPOINT_SCRIPT}" <checkId> <full-url>`,
    "It prints JSON with evidenceRefs. Use it wherever the rules below say qa_checkpoint. qa_upload_fixture is not available.",
    "",
    "",
  ].join("\n");
  return { query: note + query, env: childEnv };
}

export function runExecAgent(
  query,
  _maxTurns,
  { paths = null, secrets = [], requiredKeys = ["status"], requiredKeyGroups = null, browserTools = null } = {}
) {
  const { command, args } = resolveExecInvocation();
  const run = withBrowserTools(query, execChildEnv(), browserTools);
  const redacted = browserTools ? [...secrets, browserTools.token] : secrets;

  writeAgentQueryArtifact(paths, run.query, redacted);

  const timeout = resolveExecTimeoutMs();
  const result = spawnSync(command, args, {
    shell: false,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    env: run.env,
    input: run.query,
    timeout,
  });

  return finalizeAgentRun(result, {
    adapterLabel: `exec (${command})`,
    command,
    paths,
    secrets: redacted,
    requiredKeys,
    requiredKeyGroups,
    timeoutMs: timeout,
    timeoutHint:
      "Raise QA_AGENT_TIMEOUT_MS if the CLI legitimately needs longer.",
  });
}
