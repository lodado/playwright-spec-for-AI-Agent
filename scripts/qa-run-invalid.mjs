/**
 * Failed-run quarantine.
 *
 * When `judge` fails after it may have written partial artifacts, it drops a
 * `<slug>-qa-run.invalid` marker in the output directory. Downstream commands
 * (`review`, `slack`) refuse to read a quarantined run instead of reporting
 * on stale or half-written judgments. A successful judge clears the marker.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { UsageError } from "./errors.mjs";

export function markRunInvalid(paths, reason) {
  const body = {
    reason: String(reason ?? "unknown failure"),
    at: new Date().toISOString(),
  };
  writeFileSync(paths.runInvalidMarker, `${JSON.stringify(body, null, 2)}\n`);
}

export function clearRunInvalid(paths) {
  rmSync(paths.runInvalidMarker, { force: true });
}

export function assertRunNotInvalid(paths, command) {
  if (!existsSync(paths.runInvalidMarker)) return;
  // UsageError, not Error: a refusal an operator can act on must exit 2 with a
  // message, not exit 2 with a stack trace that reads like a harness crash.
  throw new UsageError(
    [
      `Refusing to run ${command}: the last judge run for this page failed and its artifacts are quarantined.`,
      `Marker: ${paths.runInvalidMarker}`,
      "Re-run `judge` for this page; a successful run clears the marker.",
    ].join("\n")
  );
}
