import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRIPTS_DIR = join(PACKAGE_ROOT, "scripts");

export const LEGACY_COMMANDS = Object.freeze({
  spec: "extract-page-e2e-spec.mjs",
  "abstract-ai": "run-hermes-spec-abstractor.mjs",
  judge: "run-hermes-page-judge.mjs",
  review: "run-hermes-judge-review.mjs",
  slack: "slack-page-qa-report.mjs",
  nightly: "run-page-qa-nightly.mjs",
});

export function runLegacyCommand(command, args, {
  spawn = spawnSync,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const script = LEGACY_COMMANDS[command];
  if (!script) throw new RangeError(`Unknown legacy command: ${command}`);
  const result = spawn(process.execPath, [join(SCRIPTS_DIR, script), ...args], {
    stdio: "inherit",
    env,
    cwd,
  });
  return result.status ?? 1;
}
