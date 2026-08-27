import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  extractJsonFromHermesOutput,
  prepareHermesJsonParseSurface,
  redactSensitiveText,
} from "./hermes-runner.mjs";

export const REQUIRED_ASIDE_BIN = "aside";
export const ASIDE_QA_COMMAND =
  process.env.ASIDE_QA_COMMAND?.trim() || REQUIRED_ASIDE_BIN;

/**
 * Aside has no max-turns flag, so a wall-clock timeout is the only runaway
 * guard (Hermes caps at --max_turns instead).
 */
export const ASIDE_QA_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function resolveAsideTimeoutMs() {
  const parsed = Number(process.env.ASIDE_QA_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : ASIDE_QA_DEFAULT_TIMEOUT_MS;
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
  {
    paths = null,
    secrets = [],
    requiredKeys = ["status"],
    requiredKeyGroups = null,
    mode = "browse",
  } = {}
) {
  if (ASIDE_QA_COMMAND !== REQUIRED_ASIDE_BIN) {
    throw new Error(
      `Aside command must be exactly ${REQUIRED_ASIDE_BIN}. Got: ${JSON.stringify(ASIDE_QA_COMMAND)}`
    );
  }

  const queryPath =
    paths?.hermesQuery ??
    paths?.hermesAbstractQuery ??
    paths?.hermesReviewQuery;
  if (queryPath) {
    writeFileSync(queryPath, redactSensitiveText(query, secrets));
  }

  const timeout = resolveAsideTimeoutMs();
  const result = spawnSync(ASIDE_QA_COMMAND, buildAsideAgentArgs(query), {
    shell: false,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    env: process.env,
    timeout,
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(
        `Aside timed out after ${timeout}ms (ASIDE_QA_TIMEOUT_MS to adjust).`
      );
    }
    throw result.error;
  }

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

  if (result.status !== 0) {
    throw new Error(
      `Aside failed (exit ${result.status}): ${redactSensitiveText(result.stderr || result.stdout || "no output", secrets)}`
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
