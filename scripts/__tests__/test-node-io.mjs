// Node-fs-backed IO for baseline tests that call core functions directly.
// Behavior is identical to the former in-module defaults.
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";

export const ledgerIo = {
  readFile: path => readFileSync(path, "utf8"),
  appendFile: (path, text) => appendFileSync(path, text),
  exists: path => existsSync(path),
};

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

export const specDirIo = {
  readdir: dir => readdirSync(dir),
  readFile: path => readFileSync(path, "utf8"),
};
