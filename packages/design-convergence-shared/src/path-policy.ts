import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DesignConvergenceError } from "./errors.js";

export const RUNTIME_ROOT_DIR = ".design-convergence";
export const RUNTIME_SUBDIRS = ["cache", "artifacts", "worktrees"] as const;
export type RuntimeSubdir = (typeof RUNTIME_SUBDIRS)[number];

function escapesRoot(relFromRoot: string): boolean {
  return (
    relFromRoot === ".." ||
    relFromRoot.startsWith(".." + sep) ||
    isAbsolute(relFromRoot)
  );
}

/**
 * Resolve a config-relative path and guarantee it stays inside rootDir. Rejects
 * absolute paths, null bytes, and `..` traversal. Pure: never touches the FS.
 */
export function resolveWithinRoot(rootDir: string, relPath: string): string {
  if (relPath.includes("\0")) {
    throw new DesignConvergenceError(
      "configuration",
      "path contains a null byte",
      {
        relPath,
      },
    );
  }
  if (isAbsolute(relPath)) {
    throw new DesignConvergenceError(
      "configuration",
      "absolute paths are not allowed",
      {
        relPath,
      },
    );
  }
  const root = resolve(rootDir);
  const abs = resolve(root, relPath);
  if (escapesRoot(relative(root, abs))) {
    throw new DesignConvergenceError(
      "configuration",
      "path escapes the project root",
      {
        relPath,
      },
    );
  }
  return abs;
}

/**
 * Resolve symlinks and reject any real path that leaves rootDir. A path that
 * does not exist yet has nothing to follow and is returned unchanged, so the
 * pure containment check in resolveWithinRoot is the only guard pre-write.
 */
export function assertRealpathWithinRoot(
  rootDir: string,
  absPath: string,
): string {
  const realRoot = realpathSync(resolve(rootDir));
  let realPath: string;
  try {
    realPath = realpathSync(absPath);
  } catch {
    return absPath;
  }
  if (escapesRoot(relative(realRoot, realPath))) {
    throw new DesignConvergenceError(
      "configuration",
      "symlink escapes the project root",
      {
        absPath,
      },
    );
  }
  return realPath;
}

/** Absolute path of a runtime output subdir under `<rootDir>/.design-convergence`. */
export function runtimeDir(rootDir: string, subdir: RuntimeSubdir): string {
  return resolve(rootDir, RUNTIME_ROOT_DIR, subdir);
}
