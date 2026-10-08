import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Stack check, label bend-proof:reported. The Bend law proof is a harness-level fact about the
// locked MODEL/LAWS/PROOF files; this test only asserts the skill's own verdict, it does not
// restate any law.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillScripts = join(
  process.env.ORACLE_SKILL_DIR ??
    "/Users/chungheon/orca/my-Vibe-Coding-Helper/packages/frontend-oracle-design/skills/frontend-oracle-design",
  "scripts",
);
const formalDir = join(repoRoot, "scripts/__tests__/formal/refactor");
const cardPath = join(repoRoot, ".ai/oracles/refactor-modularity-r2/oracle.md");

function lawNames(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

describe("Bend law proof as the locked refactor-modularity model", () => {
  const lawsInFile = lawNames(readFileSync(join(formalDir, "LAWS.bend"), "utf8"), /^law (\w+):/gm);
  const lawsInCard = lawNames(readFileSync(cardPath, "utf8"), /^\| ([a-z][a-z_]+)\s+\| (?:safety|effect|witness)\s+\|/gm);

  it("to be 33 laws stated in LAWS.bend and the same 33 listed in the card", () => {
    expect(lawsInFile).toHaveLength(33);
    expect([...lawsInCard].sort()).toStrictEqual([...lawsInFile].sort());
  });

  it("to be status proven with ALL PROOFS CHECK when every card law is required", () => {
    const run = spawnSync(
      process.execPath,
      [
        join(skillScripts, "oracle-model.mjs"),
        "prove",
        "--dir",
        formalDir,
        ...lawsInCard.flatMap((name) => ["--require", name]),
      ],
      { encoding: "utf8", cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
    );
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout) as {
      status: string;
      laws: string[];
      stdout: string;
      untrusted: string[];
    };
    expect(result.status).toBe("proven");
    expect(result.laws).toHaveLength(33);
    expect(result.untrusted).toStrictEqual([]);
    expect(result.stdout).toContain("ALL PROOFS CHECK");
  }, 180_000);
});
