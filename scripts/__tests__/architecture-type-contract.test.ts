import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Type Contract and O16 witnesses, label type-contract:reported. The compiler is TypeScript from the
// root devDependencies; the witnesses import the real .mjs modules (allowJs, JSDoc types) and type-fest.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const testsDir = join(repoRoot, "scripts/__tests__");

function compile(project: string) {
  const run = spawnSync(join(repoRoot, "node_modules/.bin/tsc"), ["--pretty", "false", "-p", join(testsDir, project)], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  expect(run.error, "tsc must start").toBeUndefined();
  const diagnostics = `${run.stdout}${run.stderr}`
    .split("\n")
    .filter((line) => /error TS\d+:/.test(line))
    .map((line) => line.replace(`${repoRoot}/`, "").replace(/^scripts\/__tests__\//, ""));
  return { status: run.status, diagnostics };
}

function lineAfterMarker(file: string, marker: string): number {
  const lines = readFileSync(join(testsDir, file), "utf8").split("\n");
  return lines.findIndex((line) => line.includes(marker)) + 2; // 1-based line of the statement after the marker
}

describe("type-contract checker as the canary over a witness without its protection", () => {
  it("to be one TS2578 for the unwrapped ledger entry and one TS2344 for the open status union", () => {
    const file = "types/core-contracts.canary.test-d.ts";
    const { status, diagnostics } = compile("tsconfig.type-canary.json");
    expect(status).not.toBe(0);
    // A directive error is reported at the directive; the failed Assert at the type argument.
    const unwrappedLine = lineAfterMarker(file, "CANARY-UNWRAPPED");
    const openLine = lineAfterMarker(file, "CANARY-OPEN-UNION");
    expect(diagnostics).toStrictEqual([
      `${file}(${unwrappedLine},1): error TS2578: Unused '@ts-expect-error' directive.`,
      `${file}(${openLine},41): error TS2344: Type 'false' does not satisfy the constraint 'true'.`,
    ]);
  });
});

describe("core modules as the injection boundary compiled with type-fest witnesses [O16]", () => {
  it("to be zero compiler diagnostics over every positive and negative witness", () => {
    const { status, diagnostics } = compile("tsconfig.type-contract.json");
    expect(diagnostics).toStrictEqual([]);
    expect(status).toBe(0);
  });
});
