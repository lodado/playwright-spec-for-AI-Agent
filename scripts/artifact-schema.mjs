/**
 * Artifact shape contract between pipeline stages.
 *
 * Every stage reads the previous stage's JSON. Hashes (spec-hash.mjs) catch a
 * stale artifact; these checks catch a malformed or half-written one — a
 * different failure class that otherwise surfaces as `undefined is not iterable`
 * three modules deeper.
 *
 * Hand-rolled on purpose: a validator library would be this package's first
 * runtime dependency.
 */
import { readFileSync } from "node:fs";
import { AgentOutputError, UsageError } from "./errors.mjs";

export const ARTIFACT_SCHEMA_VERSION = 1;

/** Stamp identity onto an artifact right before it is written. */
export function withSchema(artifact, artifactKind) {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    artifactKind,
    ...artifact,
  };
}

function fail(path, detail, { agentOutput = false } = {}) {
  const message = `Malformed artifact ${path}: ${detail}`;
  if (agentOutput) {
    throw new AgentOutputError(message, {
      hint: "Re-run the stage that produced it; if it recurs, inspect the adapter raw output next to this file.",
    });
  }
  throw new UsageError(message, {
    hint: "Delete it and re-run the stage that produces it.",
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Future artifacts written by a newer version are rejected loudly; older ones
 * (no `schemaVersion`) are accepted, since v1 introduced the field.
 */
export function assertSchemaVersion(artifact, path) {
  const version = artifact?.schemaVersion;
  if (version === undefined) return;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    fail(path, `schemaVersion must be a number, got ${JSON.stringify(version)}`);
  }
  if (version > ARTIFACT_SCHEMA_VERSION) {
    throw new UsageError(
      `Artifact ${path} was written by a newer version (schemaVersion ${version} > ${ARTIFACT_SCHEMA_VERSION}).`,
      { hint: "Upgrade playwright-spec-for-ai-agent, or delete the artifact and re-run." }
    );
  }
}

export function assertQaSpecShape(spec, path) {
  if (!isPlainObject(spec)) fail(path, "expected a JSON object");
  assertSchemaVersion(spec, path);
  if (!Array.isArray(spec.scenarios)) {
    fail(path, "`scenarios` must be an array");
  }
  for (const [index, scenario] of spec.scenarios.entries()) {
    if (!isPlainObject(scenario)) {
      fail(path, `scenarios[${index}] must be an object`);
    }
    if (scenario.tests !== undefined && !Array.isArray(scenario.tests)) {
      fail(path, `scenarios[${index}].tests must be an array`);
    }
  }
  return spec;
}

export function assertJudgmentShape(judgment, path) {
  if (!isPlainObject(judgment)) {
    fail(path, "expected a JSON object", { agentOutput: true });
  }
  assertSchemaVersion(judgment, path);
  if (typeof judgment.status !== "string") {
    fail(path, "`status` must be a string", { agentOutput: true });
  }
  if (judgment.checks !== undefined && !Array.isArray(judgment.checks)) {
    fail(path, "`checks` must be an array", { agentOutput: true });
  }
  return judgment;
}

export function assertReviewShape(review, path) {
  if (!isPlainObject(review)) {
    fail(path, "expected a JSON object", { agentOutput: true });
  }
  assertSchemaVersion(review, path);
  if (review.criteria !== undefined && !Array.isArray(review.criteria)) {
    fail(path, "`criteria` must be an array", { agentOutput: true });
  }
  return review;
}

const ASSERTIONS = {
  "qa-spec": assertQaSpecShape,
  judgment: assertJudgmentShape,
  review: assertReviewShape,
};

/**
 * Read + parse + shape-check in one call, so no stage open-codes JSON.parse on
 * another stage's output.
 *
 * @param {string} path
 * @param {{ kind?: keyof typeof ASSERTIONS }} [options]
 */
export function readArtifact(path, { kind } = {}) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read artifact ${path}: ${error.message}`, {
      hint: "Run the stage that produces it first.",
      cause: error,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(path, `invalid JSON (${error.message})`);
  }
  const assertion = kind ? ASSERTIONS[kind] : null;
  if (assertion) assertion(parsed, path);
  else assertSchemaVersion(parsed, path);
  return parsed;
}
