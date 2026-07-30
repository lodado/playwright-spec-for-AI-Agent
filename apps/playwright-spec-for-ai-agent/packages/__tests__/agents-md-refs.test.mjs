import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

// The AGENTS.md synchronization matrix is only useful while its file references are real.
// Backtick-quoted paths may be repo-root relative (docs/…) or app relative (packages/…, scripts/…).
const appRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(appRoot, "../..");

it("every file path referenced in AGENTS.md exists", () => {
  const text = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf8");
  const refs = [...text.matchAll(/`((?:apps|packages|scripts|docs|bin)\/[\w./-]+\.(?:mjs|md|ts))`/g)].map((match) => match[1]);
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs) {
    expect(existsSync(resolve(appRoot, ref)) || existsSync(resolve(repoRoot, ref)), `missing reference: ${ref}`).toBe(true);
  }
});
