/**
 * The one node:fs / process.env port. Core modules (ledger, spec hash, verdict
 * normalization, spec parsing) take their file and environment access as
 * arguments; command shells pass these Node-backed implementations in.
 */
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";

/** Port of the run ledger core (`qa-run-ledger.mjs`). */
export const ledgerIo = {
  readFile: path => readFileSync(path, "utf8"),
  appendFile: (path, text) => appendFileSync(path, text),
  exists: path => existsSync(path),
};

/** Port of the evidence checks in `normalizeBrowseDecision` (`judge-verdict.mjs`). */
export const evidenceIo = {
  readText: file => readFileSync(file, "utf8"),
  fileExists: file => {
    let stat;
    try {
      stat = statSync(file);
    } catch (error) {
      // A missing path is "does not exist", not a failure; other errors still throw.
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (!stat.isFile() || stat.size === 0) return false;
    accessSync(file, constants.R_OK);
    return true;
  },
};

/** Port of the spec directory reader (`spec-annotation-reader.mjs`). */
export const specDirIo = {
  readdir: dir => readdirSync(dir),
  readFile: path => readFileSync(path, "utf8"),
};

/** Port of `hashFile` (`spec-hash.mjs`). */
export const readFile = path => readFileSync(path, "utf8");

/** The environment, read at the shell boundary only. */
export function envValue(name) {
  return process.env[name];
}
