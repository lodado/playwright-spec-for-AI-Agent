/**
 * Cross-stage contract tests: the real CLI, driven end to end against a
 * throwaway project with the offline `fixture` adapter.
 *
 * Every other suite mocks the adapter and exercises one module. These bugs all
 * lived *between* two modules that each had passing unit tests, so nothing here
 * may stub a stage: the assertions are on exit codes and on artifacts one stage
 * wrote and the next one read.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyLedger } from "../qa-run-ledger.mjs";

const BIN = fileURLToPath(
  new URL("../../bin/playwright-spec-for-ai-agent.mjs", import.meta.url)
);

const PAGE = "dash";
const CHECKS = [
  "shows the plan name in the header",
  "uploads a profile image",
  "opens the danger dialog but never confirms",
];

let server: ChildProcess;
let baseUrl: string;
let root: string;
let fixtureDir: string;

function qaDir() {
  return join(root, "src", "page", PAGE, "__QA__");
}

function artifact(suffix: string) {
  return join(qaDir(), `${PAGE}-${suffix}`);
}

function readJson(suffix: string) {
  return JSON.parse(readFileSync(artifact(suffix), "utf8"));
}

/** The real bin, in the throwaway project, offline. */
function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  Object.assign(childEnv, {
    QA_AI_ADAPTER: "fixture",
    QA_NO_ENV_FILE: "1",
    STAGING_QA_EMAIL: "qa@acme.test",
    STAGING_QA_PASSWORD: "secret",
    STAGING_QA_BASE_URL: baseUrl,
  });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * The built-in fixture livePlan names a scenario no spec contains, so the
 * abstraction validator rejects it (correctly). A recorded plan for *these*
 * specs is what lets the offline pipeline reach the judge at all.
 */
function writeAbstractFixture() {
  const block = (title: string, mutations: boolean) =>
    [
      `### ACTIVE — ${title}`,
      "Given: the dashboard is open on an account with a plan",
      "When: the page has settled and is read",
      "Then: the described element is rendered with real content",
      `Never: the element is blank, a skeleton, or an error state after load${
        mutations ? "; mutations: 0" : ""
      }`,
    ].join("\n");
  writeFileSync(
    join(fixtureDir, "abstract.json"),
    JSON.stringify({
      livePlan: [
        block(CHECKS[0], true),
        block(CHECKS[1], false),
        block(CHECKS[2], false),
      ].join("\n\n"),
    })
  );
}

function writeProject() {
  const specDir = join(root, "src", "page", PAGE, "__tests__");
  mkdirSync(specDir, { recursive: true });
  // `spec` refuses a @qa-fixture path that is not on disk.
  mkdirSync(join(root, "tests", "fixtures"), { recursive: true });
  writeFileSync(join(root, "tests", "fixtures", "qa-avatar.png"), "");
  writeFileSync(
    join(root, "playwright-spec-for-ai-agent.config.mjs"),
    `export default {
  paths: { specDir: "src/page/{page}/__tests__", outputDir: "src/page/{page}/__QA__" },
  staging: { baseUrl: ${JSON.stringify(baseUrl)}, loginPath: "/login", authRequired: true },
  pages: { ${PAGE}: { targetPath: "/dash" } },
};
`
  );
  writeFileSync(
    join(specDir, "dash.spec.ts"),
    `// @qa-scenario: ACTIVE
// @qa-always-run: true

import { expect, test } from "@playwright/test";

test.describe("Dashboard", () => {
  // @qa-live-policy: readonly
  test(${JSON.stringify(CHECKS[0])}, async ({ page }) => {
    await expect(page.getByTestId("plan-name")).toHaveText("Growth");
  });

  // @qa-live-policy: safe-interaction
  // @qa-fixture: avatar=tests/fixtures/qa-avatar.png
  test(${JSON.stringify(CHECKS[1])}, async ({ page }) => {
    await page.getByTestId("avatar-input").setInputFiles("tests/fixtures/qa-avatar.png");
  });

  // @qa-live-policy: subscription-mutation
  test("cancels subscription", async ({ page }) => {
    await page.getByTestId("cancel-btn").click();
  });
});
`
  );
  // Prose naming annotations must stay prose: this file is still collected.
  writeFileSync(
    join(specDir, "prose.spec.ts"),
    `// @qa-scenario: ACTIVE

/*
 * Documented, not activated:
 *   @qa-live-skip: true
 *   @qa-always-run: true
 */

import { expect, test } from "@playwright/test";

test.describe("Dashboard danger zone", () => {
  // @qa-live-policy: safe-interaction-no-confirm
  test(${JSON.stringify(CHECKS[2])}, async ({ page }) => {
    await page.getByTestId("danger-btn").click();
  });
});
`
  );
}

/** spec -> abstract-ai -> judge, all offline. */
function runPipeline() {
  expect(cli(["spec", `--page=${PAGE}`]).status).toBe(0);
  expect(
    cli(["abstract-ai", `--page=${PAGE}`, "--force"], { QA_FIXTURE_DIR: fixtureDir })
      .status
  ).toBe(0);
  return cli(["judge", `--page=${PAGE}`, "--non-interactive"]);
}

/**
 * The judge preflights its target with `fetch`, and every stage here runs under
 * `spawnSync` — which freezes this process's event loop. An in-process server
 * would therefore never answer, so the loopback stub gets its own process.
 */
beforeAll(async () => {
  server = spawn(
    process.execPath,
    [
      "-e",
      `require("node:http").createServer((_q,r)=>{r.writeHead(200,{"content-type":"text/html"});r.end("<html><body>ok</body></html>")}).listen(0,"127.0.0.1",function(){console.log(this.address().port)})`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  baseUrl = await new Promise<string>((done, fail) => {
    server.once("error", fail);
    server.stdout!.once("data", chunk => done(`http://127.0.0.1:${String(chunk).trim()}`));
  });
});

afterAll(() => {
  server.kill();
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qa-e2e-"));
  fixtureDir = mkdtempSync(join(tmpdir(), "qa-e2e-fix-"));
  writeProject();
  writeAbstractFixture();
  return () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  };
});

describe("judge -> review spec revision handshake", () => {
  it("records in the judge plan the same hash the judgment carries", () => {
    expect(runPipeline().status).toBe(0);

    const judgment = readJson("hermes-judgment.json");
    const plan = readFileSync(artifact("qa-judge-plan.md"), "utf8");

    expect(judgment.specHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan).toContain(judgment.specHash);
    expect(cli(["review", `--page=${PAGE}`]).status).not.toBe(2);
  });

  it("refuses to review a plan stamped with another spec revision", () => {
    expect(runPipeline().status).toBe(0);

    const planPath = artifact("qa-judge-plan.md");
    writeFileSync(
      planPath,
      readFileSync(planPath, "utf8").replace(
        /sha256:[0-9a-f]{64}/g,
        `sha256:${"d".repeat(64)}`
      )
    );

    const review = cli(["review", `--page=${PAGE}`]);
    expect(review.output).toMatch(/stale/i);
    expect(review.status).toBe(2);
  });
});

describe("exit code taxonomy", () => {
  it("treats a missing --page as usage (2), never as a judged failure (1)", () => {
    for (const command of ["spec", "abstract-ai", "judge", "review", "slack", "show"]) {
      const result = cli([command]);
      expect(`${command}:${result.status}`).toBe(`${command}:2`);
    }
  });

  it("treats missing staging credentials as an environment failure without a stack", () => {
    const result = cli(["judge", `--page=${PAGE}`, "--non-interactive"], {
      STAGING_QA_EMAIL: undefined,
      STAGING_QA_PASSWORD: undefined,
    });

    expect(result.status).toBe(3);
    expect(result.output).not.toMatch(/ {4}at .*\.mjs:/);
  });

  it("refuses a quarantined run without printing a stack", () => {
    expect(runPipeline().status).toBe(0);
    writeFileSync(
      artifact("qa-run.invalid"),
      JSON.stringify({ reason: "test", at: new Date().toISOString() })
    );

    const review = cli(["review", `--page=${PAGE}`]);
    expect(review.status).toBe(2);
    expect(review.output).toMatch(/quarantined/);
    expect(review.output).not.toMatch(/ {4}at .*\.mjs:/);
  });
});

describe("flag forms", () => {
  it("honours a space-separated --fail-on the same as --fail-on=", () => {
    expect(runPipeline().status).toBe(0);
    expect(readJson("hermes-judgment.json").status).toBe("manual_review");

    expect(cli(["judge", `--page=${PAGE}`, "--non-interactive"]).status).toBe(0);
    expect(
      cli([
        "judge",
        `--page=${PAGE}`,
        "--non-interactive",
        "--fail-on",
        "manual_review",
      ]).status
    ).toBe(1);
  });
});

describe("artifacts a later stage reads back", () => {
  it("keeps the ledger chain intact and reports the spec hash as current", () => {
    expect(runPipeline().status).toBe(0);
    expect(cli(["review", `--page=${PAGE}`]).status).not.toBe(2);

    expect(verifyLedger(artifact("qa-runs.jsonl"))).toMatchObject({ ok: true });

    const show = cli(["show", `--page=${PAGE}`]);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("Spec hash: current");

    const ctrf = readJson("qa-report.ctrf.json");
    expect(ctrf.results.summary.tests).toBe(CHECKS.length);
    expect(readJson("qa-verdict-history.json").runs).toHaveLength(1);
  });

  it("reports an unreadable judgment as unreadable, not as never run", () => {
    expect(runPipeline().status).toBe(0);
    writeFileSync(artifact("hermes-judgment.json"), "{ not json");

    const show = cli(["show", `--page=${PAGE}`]);
    expect(show.stdout).not.toContain("Verdict: not run");
    expect(show.stdout).toMatch(/unreadable/i);
  });
});
