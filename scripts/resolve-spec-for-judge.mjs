import { existsSync, readFileSync } from "node:fs";
import { hashSpecDefinition, verifySourceHash } from "./spec-hash.mjs";

/** Preference order: the most processed artifact wins, raw spec is the floor. */
const CANDIDATES = [
  ["specLiveJson", "spec-live.json"],
  ["specJson", "spec.json"],
];

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Resolve the best spec JSON for the judge (live > abstracted > raw) and report
 * whether that artifact was actually generated from the raw spec on disk.
 *
 * Staleness never throws: an artifact with no `sourceHash` (written before the
 * stamp existed) and a missing raw spec are both unverifiable, not stale. The
 * caller decides whether an actual mismatch blocks the run.
 *
 * @returns {{ path: string, definition: object, planSource: string,
 *   staleness: { ok: boolean, expected: string|null, actual: string|null } } | null}
 */
export function resolveSpecForJudge(paths) {
  const raw =
    paths.specJson && existsSync(paths.specJson)
      ? readJsonOrNull(paths.specJson)
      : null;
  const actual = raw ? hashSpecDefinition(raw) : null;

  for (const [key, planSource] of CANDIDATES) {
    const candidate = paths[key];
    if (!candidate || !existsSync(candidate)) continue;

    const definition = JSON.parse(readFileSync(candidate, "utf8"));
    const unverifiable = key === "specJson" || actual === null;

    return {
      path: candidate,
      definition,
      planSource,
      staleness: unverifiable
        ? { ok: true, expected: definition?.sourceHash ?? null, actual }
        : verifySourceHash(definition, actual),
    };
  }

  return null;
}
