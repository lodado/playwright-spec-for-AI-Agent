// Oracle refactor-modularity, row O21 (P6, Q19 a), judge stage: a stage exit does not reflect the ledger, so
// the judge exits as it would over an intact ledger, whether the ledger verifies broken by an edit, by the
// removal of an entry that had a successor, or by a line cut part-way. The harness mirrors the neighbouring
// run-hermes-page-judge.test.ts: the agent adapter, browser session and spec resolution are faked; the
// ledger is a real file the judge appends to.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { buildBrowseChecklist } from "../spec-annotation-reader.mjs";
import { EnvironmentError } from "../errors.mjs";
import { appendRunEvent } from "../qa-run-ledger.mjs";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  resolveSpecForJudge: vi.fn(),
}));

vi.mock("../ai-agent-adapter.mjs", () => ({
  prepareAdapter: async () => ({
    name: "test-adapter",
    run: mocks.runAgent,
    capabilities: {
      auth: "credentials-in-prompt",
      supportsMaxTurns: true,
      supportsToolsetDisable: false,
      supportsVideo: false,
      blocksEventLoop: true,
    },
    prelogin: vi.fn(),
  }),
  runAgent: mocks.runAgent,
  runAgentAsync: mocks.runAgent,
  resolveAdapterName: () => "test-adapter",
}));

vi.mock("../qa-browser-session.mjs", () => ({
  hasSessionProfile: () => false,
  launchAuthenticatedBrowser: vi.fn(),
  connectExistingBrowser: vi.fn(),
  SESSION_PROFILE_DIR: ".private/qa-browser-profile",
}));

vi.mock("../qa-spec-artifacts.mjs", () => ({
  loadSpecSourceFiles: () => ({}),
  buildUploadFixturesPayload: () => ({ projectRoot: "/tmp", defaults: {}, byCheckId: {} }),
}));

vi.mock("../resolve-spec-for-judge.mjs", () => ({
  resolveSpecForJudge: mocks.resolveSpecForJudge,
}));

import { main } from "../run-hermes-page-judge.mjs";
import { FIXED_NOW, makeLedgerFile, nodeIo } from "./refactor-trace-fixtures.mjs";

const SPEC = {
  scenarios: [
    {
      scenarioId: "ACTIVE",
      label: "Dashboard - ACTIVE",
      sourceFile: "dashboard.spec.ts",
      alwaysRun: false,
      liveSkip: false,
      tests: [
        {
          title: "shows health score",
          checkId: "shows-health-score",
          liveRunPolicy: "executable-readonly",
          stagingMode: "read-only",
          expectations: [],
        },
      ],
    },
  ],
};

const ARGV = ["--page=dashboard", "--target-path=/dashboard"];

type Damage = "intact" | "edit-first" | "remove-first" | "cut-last";
const STATES: Damage[] = ["intact", "edit-first", "remove-first", "cut-last"];

function agentPayload(result: "pass" | "fail") {
  return {
    status: result,
    cause: result === "pass" ? "NONE" : "PRODUCT_DEFECT",
    summary: "ok",
    checks: [
      {
        checkId: buildBrowseChecklist(SPEC)[0].checkId,
        item: "shows health score",
        detail: 'score reads "98%"',
        result,
        confidence: "high",
        cause: result === "pass" ? "NONE" : "PRODUCT_DEFECT",
        evidenceRefs: [],
      },
    ],
    evidence: [],
    recommendedAction: "",
    source: "hermes-agent",
  };
}

let root: string;
let outputDir: string;
let previousCwd: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "refactor-trace-judge-ledger-"));
  outputDir = join(root, "__QA__", "dashboard");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "dashboard-qa-spec-live.md"), "## Plan\n\n### 1. shows health score\n");
  previousCwd = process.cwd();
  process.chdir(root);
  resetProjectConfigForTests();
  process.env.QA_OUTPUT_DIR = outputDir;
  process.env.STAGING_QA_BASE_URL = "https://staging.test.internal";
  process.env.STAGING_QA_EMAIL = "qa@test.internal";
  process.env.STAGING_QA_PASSWORD = "pw";
  process.env.CI = "true";
  delete process.env.QA_RECORD_VIDEO;
  delete process.env.QA_JUDGE_MAX_TURNS;
  delete process.env.GITHUB_STEP_SUMMARY;
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200 })));
  mocks.runAgent.mockReset();
  mocks.resolveSpecForJudge.mockReset().mockReturnValue({
    path: join(outputDir, "dashboard-qa-spec.json"),
    definition: SPEC,
    planSource: "spec-live.json",
    staleness: { ok: true, expected: null, actual: "sha256:abc" },
  });
});

afterEach(() => {
  process.chdir(previousCwd);
  resetProjectConfigForTests();
  vi.unstubAllGlobals();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

/** a fresh 3-entry ledger at the path the judge appends to, damaged as `state` says */
function seedLedger(state: Damage) {
  const ledger = makeLedgerFile(outputDir, "dashboard");
  for (let index = 0; index < 3; index += 1) {
    appendRunEvent(ledger.path, { kind: "trace-event", runId: `run-${index + 1}` }, { now: FIXED_NOW, io: nodeIo });
    ledger.recordAppend();
  }
  if (state === "edit-first") ledger.editFirst();
  if (state === "remove-first") ledger.removeFirst();
  if (state === "cut-last") ledger.tearLast();
}

async function judgeExit(state: Damage) {
  resetProjectConfigForTests();
  seedLedger(state);
  return main(ARGV).then(
    (code: number) => ({ code }),
    (error: { exitCode: number }) => ({ code: error.exitCode }),
  );
}

describe("judge stage as a run ledger that is intact or verifies broken under P6", () => {
  it("to be exit 0 for a passing judgment in every ledger state", async () => {
    mocks.runAgent.mockImplementation(() => agentPayload("pass"));

    const exits: Record<string, number> = {};
    for (const state of STATES) exits[state] = (await judgeExit(state)).code;

    expect(exits).toEqual({ intact: 0, "edit-first": 0, "remove-first": 0, "cut-last": 0 });
  });

  it("to be exit 1 for a failing judgment in every ledger state", async () => {
    mocks.runAgent.mockImplementation(() => agentPayload("fail"));

    const exits: Record<string, number> = {};
    for (const state of STATES) exits[state] = (await judgeExit(state)).code;

    expect(exits).toEqual({ intact: 1, "edit-first": 1, "remove-first": 1, "cut-last": 1 });
  });

  it("to be exit 3 after 3 environment failures in every ledger state", async () => {
    mocks.runAgent.mockImplementation(() => {
      throw new EnvironmentError("login flap");
    });

    const exits: Record<string, number> = {};
    for (const state of STATES) exits[state] = (await judgeExit(state)).code;

    expect(exits).toEqual({ intact: 3, "edit-first": 3, "remove-first": 3, "cut-last": 3 });
    expect(mocks.runAgent).toHaveBeenCalledTimes(3 * STATES.length);
  });
});
