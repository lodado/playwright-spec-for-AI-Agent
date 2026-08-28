/**
 * Content hashing for stage-boundary drift detection.
 *
 * Each stage stamps the hash of what it consumed into what it produces, and the
 * next stage re-checks it. Without this, `judge` happily judges last night's
 * plan when `abstract-ai` failed, and `review` critiques a plan the judge never
 * saw — both silent, both indistinguishable from a real verdict.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Stable stringify: key order must not change the hash. */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter(key => value[key] !== undefined)
    .sort();
  return `{${keys
    .map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

export function hashText(text) {
  return `sha256:${createHash("sha256").update(String(text), "utf8").digest("hex")}`;
}

export function hashJson(value) {
  return hashText(canonicalize(value));
}

export function hashFile(path) {
  return hashText(readFileSync(path, "utf8"));
}

/**
 * Hash of a spec artifact's meaningful content — the stage stamps
 * (`sourceHash`, `generatedAt`, `schemaVersion`, `agentMeta`) are excluded so a
 * re-run with identical specs produces an identical hash.
 */
export function hashSpecDefinition(definition) {
  const {
    sourceHash: _sourceHash,
    generatedAt: _generatedAt,
    schemaVersion: _schemaVersion,
    agentMeta: _agentMeta,
    inputHash: _inputHash,
    ...content
  } = definition ?? {};
  return hashJson(content);
}

/** @returns {{ ok: boolean, expected: string|null, actual: string|null }} */
export function verifySourceHash(artifact, actualHash) {
  const expected = artifact?.sourceHash ?? null;
  if (!expected) return { ok: true, expected: null, actual: actualHash };
  return { ok: expected === actualHash, expected, actual: actualHash };
}

export function describeHashMismatch({ expected, actual, producer, consumer }) {
  return [
    `${consumer} input is stale: it was generated from a different ${producer} revision.`,
    `  expected ${expected}`,
    `  actual   ${actual}`,
  ].join("\n");
}
