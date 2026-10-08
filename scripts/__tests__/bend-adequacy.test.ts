import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Stack check, label bend-adequacy:reported. Asserts the skill's own adequacy verdict for the
// locked package; the world size is the card's Case space (4096 possible of 5120, A3 excludes 1024).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillScripts = join(
  process.env.ORACLE_SKILL_DIR ??
    "/Users/chungheon/orca/my-Vibe-Coding-Helper/packages/frontend-oracle-design/skills/frontend-oracle-design",
  "scripts",
);
const packagePath = join(repoRoot, ".ai/oracles/refactor-modularity-r2/oracle.package.json");

describe("Bend adequacy check as the locked refactor-modularity package", () => {
  it("to be status proven over 5120 worlds, 4096 valid and 1024 excluded", () => {
    const run = spawnSync(process.execPath, [join(skillScripts, "oracle-adequacy.mjs"), "check", "--package", packagePath], {
      encoding: "utf8",
      cwd: repoRoot,
      maxBuffer: 256 * 1024 * 1024,
    });
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout) as {
      status: string;
      pass: boolean;
      counts: { worlds: number; valid: number; excluded: number };
    };
    expect(result.status).toBe("proven");
    expect(result.pass).toBe(true);
    expect(result.counts.worlds).toBe(5120);
    expect(result.counts.valid).toBe(4096);
    expect(result.counts.excluded).toBe(1024);
  }, 240_000);
});
