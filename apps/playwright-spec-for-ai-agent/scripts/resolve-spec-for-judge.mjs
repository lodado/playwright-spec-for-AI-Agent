import { existsSync, readFileSync } from "node:fs";

/**
 * Resolve the best spec JSON for Hermes judge (live > abstracted > raw).
 */
export function resolveSpecForJudge(paths) {
  for (const candidate of [
    paths.specLiveJson,
    paths.specAbstractedJson,
    paths.specJson,
  ]) {
    if (candidate && existsSync(candidate)) {
      return {
        path: candidate,
        definition: JSON.parse(readFileSync(candidate, "utf8")),
      };
    }
  }
  return null;
}
