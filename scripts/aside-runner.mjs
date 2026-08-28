import { spawnSync } from "node:child_process";
import {
  AGENT_DEFAULT_TIMEOUT_MS,
  finalizeAgentRun,
  resolveTimeoutMs,
  writeAgentQueryArtifact,
} from "./agent-output.mjs";
import { UsageError } from "./errors.mjs";

export const REQUIRED_ASIDE_BIN = "aside";
export const ASIDE_QA_COMMAND =
  process.env.ASIDE_QA_COMMAND?.trim() || REQUIRED_ASIDE_BIN;

/**
 * Aside has no max-turns flag, so a wall-clock timeout is the only runaway
 * guard (Hermes caps at --max_turns as well as this timeout).
 */
export const ASIDE_QA_DEFAULT_TIMEOUT_MS = AGENT_DEFAULT_TIMEOUT_MS;

export function resolveAsideTimeoutMs() {
  return resolveTimeoutMs("ASIDE_QA_TIMEOUT_MS", ASIDE_QA_DEFAULT_TIMEOUT_MS);
}

/**
 * Aside has no --max_turns or --disabled_toolsets flags, so maxTurns is
 * ignored and text-only discipline relies on the query's own "do not use
 * tools" instruction. Model/effort come from Aside user settings unless
 * ASIDE_QA_MODEL / ASIDE_QA_EFFORT override them.
 */
export function buildAsideAgentArgs(query) {
  const args = ["exec"];
  const model = process.env.ASIDE_QA_MODEL?.trim();
  if (model) args.push("-m", model);
  const effort = process.env.ASIDE_QA_EFFORT?.trim();
  if (effort) args.push("--effort", effort);
  args.push(query);
  return args;
}

export function runAside(
  query,
  _maxTurns,
  { paths = null, secrets = [], requiredKeys = ["status"], requiredKeyGroups = null } = {}
) {
  if (ASIDE_QA_COMMAND !== REQUIRED_ASIDE_BIN) {
    throw new UsageError(
      `Aside command must be exactly ${REQUIRED_ASIDE_BIN}. Got: ${JSON.stringify(ASIDE_QA_COMMAND)}`
    );
  }

  writeAgentQueryArtifact(paths, query, secrets);

  const timeout = resolveAsideTimeoutMs();
  const result = spawnSync(ASIDE_QA_COMMAND, buildAsideAgentArgs(query), {
    shell: false,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    env: process.env,
    timeout,
  });

  return finalizeAgentRun(result, {
    adapterLabel: "Aside",
    command: ASIDE_QA_COMMAND,
    paths,
    secrets,
    requiredKeys,
    requiredKeyGroups,
    timeoutMs: timeout,
    timeoutHint: "Raise ASIDE_QA_TIMEOUT_MS if Aside legitimately needs longer.",
  });
}
