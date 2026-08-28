import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { hashSpecDefinition } from "../spec-hash.mjs";
import {
  extractBuildId,
  needsReview,
  parseReviewOn,
  run,
  worstExitCode,
} from "../run-page-qa-nightly.mjs";

const SPEC = { scenarios: [{ scenarioId: "s1", tests: [{ title: "renders" }] }] };
const SPEC_HASH = hashSpecDefinition(SPEC);

let root: string;

function configFile(body: string) {
  writeFileSync(join(root, "playwright-spec-for-ai-agent.config.mjs"), body);
}

function outputDir(page: string) {
  const dir = join(root, "qa", page);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSpec(page: string) {
  writeFileSync(join(outputDir(page), `${page}-qa-spec.json`), JSON.stringify(SPEC));
}

function writeLivePlan(page: string, sourceHash: string) {
  writeFileSync(
    join(outputDir(page), `${page}-qa-spec-live.json`),
    JSON.stringify({ sourceHash, scenarios: SPEC.scenarios })
  );
}

function writeJudgment(page: string, judgment: Record<string, unknown>) {
  writeFileSync(
    join(outputDir(page), `${page}-hermes-judgment.json`),
    JSON.stringify({ artifactKind: "judgment", page, ...judgment })
  );
}

/** Records every spawned stage and returns the exit code the test scripted. */
function recorder(codes: Record<string, number> = {}) {
  const calls: Array<{ script: string; args: string[] }> = [];
  const spawn = (script: string, args: string[]) => {
    calls.push({ script, args });
    return codes[script] ?? 0;
  };
  return {
    spawn,
    calls,
    stages: () => calls.map(call => call.script),
  };
}

const ARGS = () => [`--project-root=${root}`, "--output-dir={root}/qa/{page}"];

beforeEach(() => {
  resetProjectConfigForTests();
  root = mkdtempSync(join(tmpdir(), "nightly-"));
  configFile(`export default {
    pages: {
      dashboard: { targetPath: "/dashboard" },
      pricing: { targetPath: "/pricing" },
    },
  };`);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProjectConfigForTests();
});

describe("worstExitCode", () => {
  it("prefers an environment failure over a verdict failure", () => {
    expect(worstExitCode([3, 1])).toBe(3);
    expect(worstExitCode([1, 3])).toBe(3);
  });

  it("prefers any failure over success, and agent-output over a verdict", () => {
    expect(worstExitCode([0, 1, 0])).toBe(1);
    expect(worstExitCode([1, 4])).toBe(4);
    expect(worstExitCode([])).toBe(0);
    expect(worstExitCode([0, 0])).toBe(0);
  });

  it("treats an unrecognised exit code as the worst outcome", () => {
    expect(worstExitCode([3, 137])).toBe(137);
  });
});

describe("--review-on", () => {
  it("defaults to fail and rejects an unknown mode", () => {
    expect(parseReviewOn([])).toBe("fail");
    expect(parseReviewOn(["--review-on=always"])).toBe("always");
    expect(parseReviewOn(["--skip-review"])).toBe("never");
    expect(() => parseReviewOn(["--review-on=maybe"])).toThrow(/Unknown --review-on/);
  });

  it("needs no review for a clean pass, but does for a failing check", () => {
    expect(needsReview({ status: "pass", checks: [{ result: "pass" }] })).toBe(false);
    expect(needsReview({ status: "pass", checks: [{ result: "fail" }] })).toBe(true);
    expect(needsReview({ status: "manual_review", checks: [] })).toBe(true);
    expect(needsReview(null)).toBe(true);
    expect(needsReview({ status: "pass" }, "always")).toBe(true);
    expect(needsReview({ status: "fail" }, "never")).toBe(false);
  });
});

describe("review gating", () => {
  it("skips the review agent when the verdict is a clean pass", async () => {
    writeSpec("dashboard");
    writeJudgment("dashboard", { status: "pass", checks: [{ item: "a", result: "pass" }] });
    const spawned = recorder();

    const code = await run([...ARGS(), "--page=dashboard"], { spawn: spawned.spawn });

    expect(code).toBe(0);
    expect(spawned.stages()).not.toContain("run-hermes-judge-review.mjs");
    expect(spawned.stages()).toContain("run-hermes-page-judge.mjs");
  });

  it("runs the review agent when the verdict failed", async () => {
    writeSpec("dashboard");
    writeJudgment("dashboard", { status: "fail", checks: [{ item: "a", result: "fail" }] });
    const spawned = recorder();

    await run([...ARGS(), "--page=dashboard"], { spawn: spawned.spawn });

    expect(spawned.stages()).toContain("run-hermes-judge-review.mjs");
  });

  it("forces the review agent under --review-on=always", async () => {
    writeSpec("dashboard");
    writeJudgment("dashboard", { status: "pass", checks: [] });
    const spawned = recorder();

    await run([...ARGS(), "--page=dashboard", "--review-on=always"], {
      spawn: spawned.spawn,
    });

    expect(spawned.stages()).toContain("run-hermes-judge-review.mjs");
  });

  it("does not review a judge run that failed", async () => {
    writeSpec("dashboard");
    const spawned = recorder({ "run-hermes-page-judge.mjs": 3 });

    const code = await run([...ARGS(), "--page=dashboard"], { spawn: spawned.spawn });

    expect(code).toBe(3);
    expect(spawned.stages()).not.toContain("run-hermes-judge-review.mjs");
  });
});

describe("abstract-ai gating", () => {
  it("skips abstract-ai when the live plan came from this exact spec", async () => {
    writeSpec("dashboard");
    writeLivePlan("dashboard", SPEC_HASH);
    writeJudgment("dashboard", { status: "pass", checks: [] });
    const spawned = recorder();

    await run([...ARGS(), "--page=dashboard"], { spawn: spawned.spawn });

    expect(spawned.stages()).not.toContain("run-hermes-spec-abstractor.mjs");
  });

  it("re-runs abstract-ai when the spec changed, or under --force-abstract", async () => {
    writeSpec("dashboard");
    writeLivePlan("dashboard", "sha256:stale");
    const stale = recorder();
    await run([...ARGS(), "--page=dashboard"], { spawn: stale.spawn });
    expect(stale.stages()).toContain("run-hermes-spec-abstractor.mjs");

    resetProjectConfigForTests();
    writeLivePlan("dashboard", SPEC_HASH);
    const forced = recorder();
    await run([...ARGS(), "--page=dashboard", "--force-abstract"], {
      spawn: forced.spawn,
    });
    expect(forced.stages()).toContain("run-hermes-spec-abstractor.mjs");
  });

  it("aborts the page when the spec stage fails", async () => {
    const spawned = recorder({ "extract-page-e2e-spec.mjs": 2 });

    const code = await run([...ARGS(), "--page=dashboard"], { spawn: spawned.spawn });

    expect(code).toBe(2);
    expect(spawned.stages()).toEqual(["extract-page-e2e-spec.mjs"]);
  });
});

describe("deploy gate", () => {
  function versionConfig() {
    configFile(`export default {
      staging: { versionUrl: "https://staging.test/version" },
      pages: { dashboard: { targetPath: "/dashboard" } },
    };`);
  }

  function versionFetch(buildId: string) {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ buildId }),
    })) as unknown as typeof fetch;
  }

  it("skips judge and review when staging still runs the build that passed", async () => {
    versionConfig();
    writeSpec("dashboard");
    writeLivePlan("dashboard", SPEC_HASH);
    writeJudgment("dashboard", {
      status: "pass",
      checks: [],
      specHash: SPEC_HASH,
      stagingBuildId: "build-42",
    });
    const spawned = recorder();

    const code = await run([...ARGS(), "--page=dashboard"], {
      spawn: spawned.spawn,
      fetch: versionFetch("build-42"),
    });

    expect(code).toBe(0);
    expect(spawned.stages()).toEqual(["extract-page-e2e-spec.mjs"]);
  });

  it("judges anyway on a new build, on --force-judge, or when the endpoint is down", async () => {
    versionConfig();
    writeSpec("dashboard");
    writeJudgment("dashboard", {
      status: "pass",
      checks: [],
      specHash: SPEC_HASH,
      stagingBuildId: "build-42",
    });

    const newBuild = recorder();
    await run([...ARGS(), "--page=dashboard"], {
      spawn: newBuild.spawn,
      fetch: versionFetch("build-43"),
    });
    expect(newBuild.stages()).toContain("run-hermes-page-judge.mjs");

    resetProjectConfigForTests();
    const forced = recorder();
    await run([...ARGS(), "--page=dashboard", "--force-judge"], {
      spawn: forced.spawn,
      fetch: versionFetch("build-42"),
    });
    expect(forced.stages()).toContain("run-hermes-page-judge.mjs");

    resetProjectConfigForTests();
    const down = recorder();
    await run([...ARGS(), "--page=dashboard"], {
      spawn: down.spawn,
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(down.stages()).toContain("run-hermes-page-judge.mjs");
  });

  it("reads the build id out of common version payload shapes", () => {
    expect(extractBuildId('{"buildId":"a1"}')).toBe("a1");
    expect(extractBuildId('{"version":"1.2.3"}')).toBe("1.2.3");
    expect(extractBuildId("  deadbeef  ")).toBe("deadbeef");
    expect(extractBuildId('{"unrelated":{"nested":1}}')).toBe(null);
    expect(extractBuildId("")).toBe(null);
  });
});

describe("multi-page runs", () => {
  it("iterates every configured page under --all and keeps the worst exit code", async () => {
    writeSpec("dashboard");
    writeSpec("pricing");
    const spawned = recorder({ "run-hermes-page-judge.mjs": 1 });

    const code = await run([...ARGS(), "--all"], { spawn: spawned.spawn });

    const judged = spawned.calls.filter(
      call => call.script === "run-hermes-page-judge.mjs"
    );
    expect(judged.map(call => call.args[0])).toEqual([
      "--page=dashboard",
      "--page=pricing",
    ]);
    expect(code).toBe(1);
  });

  it("exits with the environment failure even when a later stage fails too", async () => {
    writeSpec("dashboard");
    writeSpec("pricing");
    // dashboard hits an environment failure; pricing only fails its verdict.
    const spawn = (script: string, args: string[]) => {
      if (script === "run-hermes-page-judge.mjs") {
        return args.includes("--page=dashboard") ? 3 : 1;
      }
      return 0;
    };

    const code = await run([...ARGS(), "--pages=dashboard,pricing"], { spawn });

    expect(code).toBe(3);
  });

  it("rejects --pages= with no pages and --page= missing entirely", async () => {
    await expect(run([...ARGS(), "--pages="], { spawn: recorder().spawn })).rejects.toThrow(
      /listed no pages/
    );
    await expect(run(ARGS(), { spawn: recorder().spawn })).rejects.toThrow(
      /Missing --page=/
    );
  });
});

describe("--help", () => {
  it("prints its own help without running a stage", async () => {
    const spawned = recorder();
    expect(await run(["--help"], { spawn: spawned.spawn })).toBe(0);
    expect(spawned.calls).toHaveLength(0);
  });
});
