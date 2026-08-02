import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXECUTION_ACTION_PROPOSAL_VERSION } from "../../contracts/index.mjs";
import { readEvidenceArchive } from "../../evidence/index.mjs";
import { judgeWithHermes } from "../../provider-hermes/index.mjs";
import { runAdaptiveSuiteWithPlaywright } from "../../runtime/playwright.mjs";
import { executeQaNative } from "../qa-native-execute.mjs";
import { judgeQaNative } from "../qa-native-judge.mjs";
import { reportQaNative } from "../qa-native-report.mjs";
import { reviewQaNative } from "../qa-native-review.mjs";
import { runQaNative } from "../qa-native.mjs";

const temporaryDirectories = [];
const integrityKey = Buffer.alloc(32, 0x63);

const multiSource = `// @qa-scenario: DASHBOARD_READONLY
test.describe("dashboard", () => {
  // @qa-live-policy: readonly
  test("shows dashboard", async ({ page }) => {
    await expect(page.getByText("Dashboard")).toBeVisible();
  });
  // @qa-live-policy: readonly
  test("shows metrics", async ({ page }) => {
    await expect(page.getByText("Dashboard")).toBeVisible();
  });
  // @qa-live-policy: readonly
  test("hides sign in", async ({ page }) => {
    await expect(page.getByText("Dashboard")).toBeVisible();
  });
});
`;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "qa-native-one-shot-"));
  temporaryDirectories.push(cwd);
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "Dashboard.jsx"), "export function Dashboard() { return <h1>Welcome Dashboard</h1>; }\n");
  writeFileSync(join(cwd, "dashboard.spec.ts"), multiSource);
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "commit", "-qm", "fixture"], { cwd });
  return cwd;
}

describe("qa-native one-shot execute -> judge -> review -> report", () => {
  it("runs three abstract adaptive scenarios through independent judgment review and reporting", async () => {
    const cwd = repository();
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end('<!doctype html><main data-testid="root"><h1>Dashboard</h1></main>');
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const env = { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") };

    let proposalId = 0;
    const createProposer = () => async (input) => ({ tokensUsed: 0, proposal: { schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION, proposalId: `p-${++proposalId}`, runId: input.runId, scenarioId: input.scenarioId, milestoneId: input.currentMilestoneId, leaseId: input.capabilityLease.leaseId, action: "observe_dom", parameters: {} } });
    const judge = (args) => judgeWithHermes({ ...args, model: "hermes-test", transport: async () => {
      const scenario = args.qaIr.suites.flatMap((suite) => suite.scenarios).find((candidate) => candidate.id === args.bundle.scenarioId);
      return { expectationResults: scenario.expectations.map((expectation) => ({ expectationId: expectation.id, status: "CONTRADICTED", confidence: 0.82, evidenceRefs: [args.bundle.artifacts[0].id], rationale: "Expected dashboard copy is missing." })), uncertainty: [] };
    } });

    try {
      const executeStatus = await runQaNative(["execute", "--spec=dashboard.spec.ts", `--base-url=${baseUrl}`, "--run-dir=.qa/runs/one-shot"], {
        cwd,
        env,
        handlers: { execute: (options) => executeQaNative(options, {
          createProposer,
          executeAdaptive: (adaptive) => runAdaptiveSuiteWithPlaywright({ ...adaptive, browserType: chromium }),
          extractFull: async ({ manifest }) => ({ status: "ABSTRACTED", tests: manifest.tests.map((test) => ({ testId: test.testId, given: ["the dashboard is available"], when: ["the page is observed"], then: ["Dashboard content is visible"], classification: "LIVE_EXECUTABLE" })) }),
          reviewFull: async ({ candidate }) => ({ status: "APPROVED", tests: candidate.tests }),
        }) },
        stdout: vi.fn(),
        stderr: vi.fn(),
      });
      expect(executeStatus).toBe(0);

      const judgeStatus = await runQaNative(["judge", "--run-dir=.qa/runs/one-shot"], {
        cwd,
        env,
        handlers: { judge: (options) => judgeQaNative(options, { judge }) },
        stdout: vi.fn(),
        stderr: vi.fn(),
      });
      expect(judgeStatus).toBe(0);

      const reviewStatus = await runQaNative(["review", "--run-dir=.qa/runs/one-shot"], {
        cwd,
        env,
        handlers: { review: (options) => reviewQaNative(options, { reviewer: async () => ({ status: "APPROVED" }) }) },
        stdout: vi.fn(),
        stderr: vi.fn(),
      });
      expect(reviewStatus).toBe(0);

      const reportStatus = await runQaNative(["report", "--run-dir=.qa/runs/one-shot"], {
        cwd,
        env,
        handlers: { report: reportQaNative },
        stdout: vi.fn(),
        stderr: vi.fn(),
      });
      expect(reportStatus).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    const runDirectory = join(cwd, ".qa", "runs", "one-shot");
    const replay = readEvidenceArchive({ directory: join(runDirectory, "evidence"), integrityKey });
    expect(new Set(replay.bundles.map((bundle) => bundle.scenarioId)).size).toBe(3);

    expect(JSON.parse(readFileSync(join(runDirectory, "judgment.json"), "utf8"))).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(runDirectory, "review.json"), "utf8"))).toHaveLength(3);
    expect(readdirSync(runDirectory).sort()).toEqual(["authority.json", "behavior.json", "evidence", "judgment.json", "report.md", "review.json"]);
  }, 30_000);
});
