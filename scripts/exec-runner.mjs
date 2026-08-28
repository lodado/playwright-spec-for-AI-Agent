import { spawnSync } from "node:child_process";
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

export function runExecAgent(
  query,
  _maxTurns,
  { paths = null, secrets = [], requiredKeys = ["status"], requiredKeyGroups = null } = {}
) {
  const { command, args } = resolveExecInvocation();

  writeAgentQueryArtifact(paths, query, secrets);

  const timeout = resolveExecTimeoutMs();
  const result = spawnSync(command, args, {
    shell: false,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    env: process.env,
    input: query,
    timeout,
  });

  return finalizeAgentRun(result, {
    adapterLabel: `exec (${command})`,
    command,
    paths,
    secrets,
    requiredKeys,
    requiredKeyGroups,
    timeoutMs: timeout,
    timeoutHint:
      "Raise QA_AGENT_TIMEOUT_MS if the CLI legitimately needs longer.",
  });
}
