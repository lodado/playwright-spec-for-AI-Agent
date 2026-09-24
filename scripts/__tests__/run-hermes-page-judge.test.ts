import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { buildBrowseChecklist } from "../spec-annotation-reader.mjs";
import { AgentOutputError, EnvironmentError } from "../errors.mjs";
import * as uploadPreflight from "../qa-upload-preflight.mjs";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  prelogin: vi.fn(),
  launchAuthenticatedBrowser: vi.fn(),
  connectExistingBrowser: vi.fn(),
  hasSessionProfile: vi.fn(() => false),
  resolveSpecForJudge: vi.fn(),
  uploadFixtures: {} as Record<string, string>,
  capabilities: {
    auth: "credentials-in-prompt",
    supportsMaxTurns: true,
    supportsToolsetDisable: false,
    supportsVideo: false,
    blocksEventLoop: true,
  },
}));

vi.mock("../ai-agent-adapter.mjs", () => ({
  prepareAdapter: async () => ({
    name: "test-adapter",
    run: mocks.runAgent,
    capabilities: mocks.capabilities,
    prelogin: mocks.prelogin,
  }),
  runAgent: mocks.runAgent,
  runAgentAsync: mocks.runAgent,
  resolveAdapterName: () => "test-adapter",
}));

vi.mock("../qa-browser-session.mjs", () => ({
  hasSessionProfile: mocks.hasSessionProfile,
  launchAuthenticatedBrowser: mocks.launchAuthenticatedBrowser,
  connectExistingBrowser: mocks.connectExistingBrowser,
  SESSION_PROFILE_DIR: ".private/qa-browser-profile",
}));

// Session seeding reads a real storageState file and drives a browser; the
// auth-mode rows only need to know that a configured state was used.
vi.mock("../qa-session-seed.mjs", async importOriginal => ({
  ...(await importOriginal<typeof import("../qa-session-seed.mjs")>()),
  readStorageState: () => ({ cookies: [], origins: [] }),
  seedAsideSession: () => ({ cookies: 0 }),
  seedProfileSession: async () => ({ cookies: 0 }),
}));

vi.mock("../qa-spec-artifacts.mjs", () => ({
  loadSpecSourceFiles: () => ({}),
  buildUploadFixturesPayload: () => ({
    projectRoot: "/tmp",
    defaults: mocks.uploadFixtures,
    byCheckId: {},
  }),
}));

vi.mock("../resolve-spec-for-judge.mjs", () => ({
  resolveSpecForJudge: mocks.resolveSpecForJudge,
}));

import { buildBrowseHermesQuery, main } from "../run-hermes-page-judge.mjs";

const SPEC = {
  scenarios: [
    {
      scenarioId: "ACTIVE",
      label: "Dashboard — ACTIVE",
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

function agentPayload(overrides: Record<string, unknown> = {}) {
  return {
    status: "pass",
    cause: "NONE",
    summary: "ok",
    checks: [
      {
        checkId: buildBrowseChecklist(SPEC)[0].checkId,
        item: "shows health score",
        detail: 'score reads "98%"',
        result: "pass",
        confidence: "high",
        cause: "NONE",
        evidenceRefs: [],
      },
    ],
    evidence: [],
    recommendedAction: "",
    source: "hermes-agent",
    ...overrides,
  };
}

let root: string;
let outputDir: string;
let previousCwd: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "judge-wiring-"));
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

  mocks.capabilities = {
    auth: "credentials-in-prompt",
    supportsMaxTurns: true,
    supportsToolsetDisable: false,
    supportsVideo: false,
    blocksEventLoop: true,
  };
  mocks.runAgent.mockReset().mockReturnValue(agentPayload());
  mocks.uploadFixtures = {};
  mocks.prelogin.mockReset();
  mocks.launchAuthenticatedBrowser.mockReset();
  mocks.connectExistingBrowser.mockReset();
  mocks.hasSessionProfile.mockReset().mockReturnValue(false);
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

function readJudgment() {
  return JSON.parse(
    readFileSync(join(outputDir, "dashboard-hermes-judgment.json"), "utf8"),
  );
}

it('stops before any agent call or retries when a fixture is missing', async () => {
  mocks.uploadFixtures = { document: join(root, 'missing.pdf') };
  await expect(main(ARGV)).rejects.toThrow(/Upload fixture/);
  expect(mocks.runAgent).not.toHaveBeenCalled();
  expect(readLedgerKinds().some(event => event.kind === 'judge-retry')).toBe(false);
  expect(existsSync(join(outputDir, 'dashboard-hermes-judgment.json'))).toBe(false);
});

it('quarantines unsupported upload tooling before judging', async () => {
  const file = join(root, 'fixture.txt');
  writeFileSync(file, 'fixture');
  mocks.uploadFixtures = { document: file };
  await expect(main(ARGV)).rejects.toThrow(/cdp-attach/);
  expect(mocks.runAgent).not.toHaveBeenCalled();
  expect(readLedgerKinds().at(-1)).toMatchObject({ status: 'error', cause: 'ENVIRONMENT_DEFECT' });
});

it('does not retry or call the judge when the actual upload probe fails', async () => {
  const file = join(root, 'fixture.txt');
  writeFileSync(file, 'fixture');
  mocks.uploadFixtures = { document: file };
  mocks.capabilities.auth = 'cdp-attach';
  const probe = vi.spyOn(uploadPreflight, 'preflightUploads').mockRejectedValue(new EnvironmentError('Upload preflight failed'));
  await expect(main(ARGV)).rejects.toThrow('Upload preflight failed');
  expect(probe).toHaveBeenCalledOnce();
  expect(mocks.runAgent).not.toHaveBeenCalled();
  expect(readLedgerKinds().some(event => event.kind === 'judge-retry')).toBe(false);
});

function readLedgerKinds() {
  const path = join(outputDir, "dashboard-qa-runs.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function sessionStub(evidence: Record<string, unknown> = {}) {
  const snapshot = join(outputDir, "captured-aria.yaml");
  writeFileSync(snapshot, "- text: 98%\n");
  const captured = {
    tracePath: null,
    harPath: null,
    videoPath: null,
    screenshots: [],
    ariaSnapshots: [snapshot],
    violations: [],
    ...evidence,
  };
  return {
    cdpUrl: "http://127.0.0.1:9999",
    capture: vi.fn(async () => captured),
    close: vi.fn(async () => captured),
    evidence: captured,
  };
}

describe("judge wiring", () => {
  it("demotes an agent-only pass without runner-owned evidence", async () => {
    await main(ARGV);
    expect(readJudgment()).toMatchObject({
      status: "manual_review",
      cause: "HARNESS_DEFECT",
      runnerEvidence: null,
      checks: [{
        result: "manual_review",
        demotedFrom: "pass",
        evidenceRefs: [],
      }],
    });
  });

  it("dry-run stops before the agent and reports the resolved plan", async () => {
    const code = await main([...ARGV, "--dry-run"]);

    expect(code).toBe(0);
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(existsSync(join(outputDir, "dashboard-qa-judge-plan.md"))).toBe(true);
    expect(existsSync(join(outputDir, "dashboard-hermes-query.txt"))).toBe(true);
    expect(existsSync(join(outputDir, "dashboard-qa-run.invalid"))).toBe(false);
    expect(readLedgerKinds()).toEqual([]);

    const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(printed).toContain("https://staging.test.internal/dashboard");
    expect(printed).toContain("test-adapter");
    expect(printed).toContain("turn budget:   20");
  });

  it("refuses a stale plan instead of judging last night's spec", async () => {
    mocks.resolveSpecForJudge.mockReturnValue({
      path: join(outputDir, "dashboard-qa-spec.json"),
      definition: SPEC,
      planSource: "spec-live.json",
      staleness: { ok: false, expected: "sha256:old", actual: "sha256:new" },
    });

    await expect(main(ARGV)).rejects.toMatchObject({
      exitCode: 2,
      hint: expect.stringContaining("abstract-ai"),
    });
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("quarantines and exits 3 when the run is an environment defect", async () => {
    mocks.runAgent.mockReturnValue(
      agentPayload({
        status: "fail",
        cause: "ENVIRONMENT_DEFECT",
        checks: [
          {
            item: "shows health score",
            detail: "redirected to /login",
            result: "skip",
            cause: "ENVIRONMENT_DEFECT",
          },
        ],
      }),
    );

    const code = await main(ARGV);

    expect(code).toBe(3);
    expect(existsSync(join(outputDir, "dashboard-qa-run.invalid"))).toBe(true);
    expect(readJudgment().cause).toBe("ENVIRONMENT_DEFECT");
  });

  it("exits 3 without calling the agent when the target is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    await expect(main(ARGV)).rejects.toMatchObject({ exitCode: 3 });
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(existsSync(join(outputDir, "dashboard-qa-run.invalid"))).toBe(true);
    expect(readLedgerKinds().map(entry => entry.kind)).toEqual([
      "judge-start",
      "judge",
    ]);
  });

  it("refuses a placeholder target URL", async () => {
    process.env.STAGING_QA_BASE_URL = "https://your-staging-url.example.com";

    await expect(main(ARGV)).rejects.toMatchObject({ exitCode: 2 });
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("stamps run identity, coverage, and the spec hash into the judgment", async () => {
    mocks.capabilities.auth = "cdp-attach";
    mocks.hasSessionProfile.mockReturnValue(true);
    mocks.launchAuthenticatedBrowser.mockResolvedValue(sessionStub());
    const code = await main(ARGV);

    expect(code).toBe(0);
    const judgment = readJudgment();
    expect(judgment).toMatchObject({
      artifactKind: "judgment",
      page: "dashboard",
      status: "pass",
      cause: "NONE",
      targetUrl: "https://staging.test.internal/dashboard",
      targetPath: "/dashboard",
      planSource: "spec-live.md",
      coverage: { planned: 1, addressed: 1, missing: [] },
    });
    expect(judgment.runId).toMatch(/^run-/);
    expect(judgment.specHash).toMatch(/^sha256:/);
    expect(Date.parse(judgment.judgedAt)).not.toBeNaN();

    const ledger = readLedgerKinds();
    expect(ledger.map(entry => entry.kind)).toEqual(["judge-start", "judge"]);
    expect(ledger[0]).toMatchObject({ adapter: "test-adapter", page: "dashboard" });
    expect(ledger[1]).toMatchObject({ status: "pass", cause: "NONE" });
    expect(ledger[0].runId).toBe(judgment.runId);

    const manifest = JSON.parse(
      readFileSync(join(outputDir, "dashboard-qa-evidence-manifest.json"), "utf8"),
    );
    expect(manifest.items).toEqual([
      expect.objectContaining({ item: "shows health score", addressed: true }),
    ]);
  });

  it("writes an unaddressed marker and demotes when a planned check is missing", async () => {
    mocks.runAgent.mockReturnValue(
      agentPayload({ checks: [], summary: "nothing to see" }),
    );

    const code = await main(ARGV);

    expect(code).toBe(0);
    const judgment = readJudgment();
    expect(judgment.status).toBe("manual_review");
    expect(judgment.coverage.missing).toEqual(["shows health score"]);

    const manifest = JSON.parse(
      readFileSync(join(outputDir, "dashboard-qa-evidence-manifest.json"), "utf8"),
    );
    expect(manifest.items[0]).toMatchObject({
      addressed: false,
      result: "unaddressed",
    });
  });

  it("appends the judgment to GITHUB_STEP_SUMMARY and calls the onJudgment hook", async () => {
    mocks.capabilities.auth = "cdp-attach";
    mocks.hasSessionProfile.mockReturnValue(true);
    mocks.launchAuthenticatedBrowser.mockResolvedValue(sessionStub());
    const summaryPath = join(root, "step-summary.md");
    const hookMarker = join(root, "hook.json");
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    writeFileSync(
      join(root, "playwright-spec-for-ai-agent.config.mjs"),
      [
        `import { writeFileSync } from "node:fs";`,
        `export default {`,
        `  hooks: {`,
        `    onJudgment: ({ page, judgment }) =>`,
        `      writeFileSync(${JSON.stringify(hookMarker)}, JSON.stringify({ page, status: judgment.status })),`,
        `  },`,
        `};`,
      ].join("\n"),
    );
    resetProjectConfigForTests();

    expect(await main(ARGV)).toBe(0);
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toContain("dashboard QA — PASS");
    expect(summary).toContain("shows health score");
    expect(JSON.parse(readFileSync(hookMarker, "utf8"))).toEqual({
      page: "dashboard",
      status: "pass",
    });
  });

  it("exits 1 on a fail verdict", async () => {
    mocks.runAgent.mockReturnValue(
      agentPayload({
        status: "fail",
        cause: "PRODUCT_DEFECT",
        checks: [
          {
            item: "shows health score",
            detail: "the score card is missing",
            result: "fail",
            cause: "PRODUCT_DEFECT",
          },
        ],
      }),
    );

    expect(await main(ARGV)).toBe(1);
  });

  it("makes manual_review exit non-zero only with --fail-on=manual_review", async () => {
    mocks.runAgent.mockReturnValue(
      agentPayload({ status: "manual_review", cause: "SPEC_GAP" }),
    );

    expect(await main(ARGV)).toBe(0);
    expect(await main([...ARGV, "--fail-on=manual_review"])).toBe(1);
    expect(await main([...ARGV, "--fail-on=never"])).toBe(0);
  });

  it("rejects an unknown --fail-on value", async () => {
    await expect(main([...ARGV, "--fail-on=maybe"])).rejects.toMatchObject({
      exitCode: 2,
    });
  });

  it("scales the turn budget and skips it for adapters that ignore it", async () => {
    await main(ARGV);
    expect(mocks.runAgent).toHaveBeenLastCalledWith(
      expect.any(String),
      20,
      expect.objectContaining({ mode: "browse" }),
    );

    mocks.capabilities.supportsMaxTurns = false;
    await main(ARGV);
    expect(mocks.runAgent).toHaveBeenLastCalledWith(
      expect.any(String),
      null,
      expect.any(Object),
    );
  });

  it("calls prelogin for a self-prelogin adapter and never launches a session", async () => {
    mocks.capabilities.auth = "self-prelogin";

    await main(ARGV);

    expect(mocks.prelogin).toHaveBeenCalledWith({
      loginUrl: "https://staging.test.internal/login",
      email: "qa@test.internal",
      password: "pw",
    });
    expect(mocks.launchAuthenticatedBrowser).not.toHaveBeenCalled();
  });

  it("launches the runner-owned session for a cdp-attach adapter with a saved profile", async () => {
    mocks.capabilities.auth = "cdp-attach";
    mocks.hasSessionProfile.mockReturnValue(true);
    const session = sessionStub({
      tracePath: join(outputDir, "evidence", "t.zip"),
      screenshots: [join(outputDir, "evidence", "s.png")],
    });
    mocks.launchAuthenticatedBrowser.mockResolvedValue(session);
    mocks.runAgent.mockImplementation(() => {
      expect(process.env.BROWSER_CDP_URL).toBe("http://127.0.0.1:9999");
      return agentPayload();
    });

    await main(ARGV);

    const options = mocks.launchAuthenticatedBrowser.mock.calls[0][0];
    expect(options.evidenceDir).toBe(join(outputDir, "evidence"));
    expect(options.label).toMatch(/^dashboard-run-/);
    // A blocking adapter must not enable live interception: no route handler
    // can run while spawnSync holds the event loop.
    expect(options.allowedOrigins).toEqual([]);
    expect(options.blockMutations).toBe(false);
    expect(session.close).toHaveBeenCalled();
    expect(process.env.BROWSER_CDP_URL).toBeUndefined();
    expect(readJudgment().runnerEvidence.tracePath).toBe(
      join(outputDir, "evidence", "t.zip"),
    );
  });

  it("registers runner-owned intermediate captures before the final page changes", async () => {
    mocks.capabilities.auth = "cdp-attach";
    mocks.hasSessionProfile.mockReturnValue(true);
    const session = sessionStub();
    const checkpoint = join(outputDir, "checkpoint.yaml");
    writeFileSync(checkpoint, '- dialog "Upload documents"\n');
    session.capture.mockImplementation(async () => {
      session.evidence.ariaSnapshots.push(checkpoint);
      return { ...session.evidence, ariaSnapshots: [checkpoint] };
    });
    mocks.launchAuthenticatedBrowser.mockResolvedValue(session);
    mocks.runAgent.mockImplementation(async (_query, _turns, options) => {
      const first = await options.captureEvidence();
      await options.captureEvidence();
      return agentPayload({ checks: [{
        ...agentPayload().checks[0],
        detail: 'Observed "Upload documents" before closing the dialog.',
        evidenceRefs: first.ariaSnapshots,
      }] });
    });
    expect(await main(ARGV)).toBe(0);
    const judgment = readJudgment();
    expect(judgment.status).toBe("pass");
    expect(judgment.checks[0].evidenceRefs).toContain(checkpoint);
    expect(judgment.runnerEvidence.ariaSnapshots).toContain(checkpoint);
    expect(session.capture.mock.calls.map(call => call[0])).toEqual([
      `dashboard-${judgment.runId}-checkpoint-1`,
      `dashboard-${judgment.runId}-checkpoint-2`,
    ]);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("keeps the runner session open until async agent output resolves", async () => {
    mocks.capabilities.auth = "cdp-attach";
    mocks.hasSessionProfile.mockReturnValue(true);
    const session = sessionStub();
    mocks.launchAuthenticatedBrowser.mockResolvedValue(session);
    mocks.runAgent.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return agentPayload();
    });
    const pending = main(ARGV);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.close).not.toHaveBeenCalled();
    await pending;
    expect(session.close).toHaveBeenCalled();
    expect(readJudgment().checks.length).toBeGreaterThan(0);
  });

  it("enables live interception only for a non-blocking adapter", async () => {
    mocks.capabilities.auth = "cdp-attach";
    mocks.capabilities.blocksEventLoop = false;
    mocks.hasSessionProfile.mockReturnValue(true);
    mocks.launchAuthenticatedBrowser.mockResolvedValue(sessionStub());

    await main(ARGV);

    const options = mocks.launchAuthenticatedBrowser.mock.calls[0][0];
    expect(options.allowedOrigins).toEqual(["https://staging.test.internal"]);
    expect(options.blockMutations).toBe(true);
  });

  it("retries an environment failure twice, then quarantines with the last real error", async () => {
    mocks.runAgent.mockImplementation(() => {
      throw new EnvironmentError(`login flap ${mocks.runAgent.mock.calls.length}`);
    });

    await expect(main(ARGV)).rejects.toMatchObject({
      exitCode: 3,
      message: "login flap 3",
    });
    expect(mocks.runAgent).toHaveBeenCalledTimes(3);

    const ledger = readLedgerKinds();
    expect(ledger.filter(entry => entry.kind === "judge-retry")).toHaveLength(2);
    expect(ledger.at(-1)).toMatchObject({
      kind: "judge",
      status: "error",
      cause: "ENVIRONMENT_DEFECT",
    });
    expect(existsSync(join(outputDir, "dashboard-qa-run.invalid"))).toBe(true);
  });

  it("retries unusable agent output once and never re-judges a completed run", async () => {
    mocks.runAgent
      .mockImplementationOnce(() => {
        throw new AgentOutputError("no JSON");
      })
      .mockImplementation(() => agentPayload());

    expect(await main(ARGV)).toBe(0);
    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
    expect(
      readLedgerKinds().filter(entry => entry.kind === "judge-retry"),
    ).toHaveLength(1);
  });

  it("demotes the verdict from a mutation found in the recorded HAR", async () => {
    mocks.capabilities.auth = "cdp-attach";
    mocks.hasSessionProfile.mockReturnValue(true);
    const harPath = join(outputDir, "session.har");
    writeFileSync(
      harPath,
      JSON.stringify({
        log: {
          entries: [
            {
              request: {
                method: "POST",
                url: "https://staging.test.internal/api/track",
              },
            },
          ],
        },
      }),
    );
    mocks.launchAuthenticatedBrowser.mockResolvedValue(sessionStub({ harPath }));

    const code = await main(ARGV);

    expect(code).toBe(0);
    const judgment = readJudgment();
    expect(judgment.status).toBe("manual_review");
    expect(judgment.summary).toContain("unexpected-mutation");
  });
});

describe("buildBrowseHermesQuery", () => {
  it("includes annotation guide in judge prompt", () => {
    const query = buildBrowseHermesQuery({
      judgeDocument: "## Plan\n\n### 1. test",
      stagingLogin: {
        loginUrl: "https://example.com/login",
        email: "qa@example.com",
        password: "pw",
        targetUrl: "https://example.com/dashboard",
      },
    });

    expect(query).toContain("Only executable-interaction checks with a declared upload fixture may call qa_upload_fixture");
    expect(query).toContain("judgment-interaction-no-confirm does not authorize file attachment");
    expect(query).toContain("A displayed zero credit balance is not proof");
    expect(query).toContain("respect the source observation timeout");
    expect(query).toContain("## Annotation guide");
    expect(query).toContain("`mock-judgment` -> `judgment-mock-api`");
    expect(query).toContain("If `blocked-*`, mark `skip`.");
    expect(query).toContain(
      "Value mismatch alone (e.g., `0` vs `8`) is not a failure",
    );
  });

  it("asks for detail before result, plus confidence, cause and evidenceRefs", () => {
    const query = buildBrowseHermesQuery({
      judgeDocument: "## Plan",
      stagingLogin: {
        authRequired: false,
        loginUrl: "https://example.com/login",
        email: "",
        password: "",
        targetUrl: "https://example.com/pricing",
      },
    });

    const shape = query.slice(query.indexOf('{ "status"'));
    expect(shape.indexOf('"detail"')).toBeLessThan(shape.indexOf('"result"'));
    expect(query).toContain('"confidence": "high"|"medium"|"low"');
    expect(query).toContain('"evidenceRefs"');
    expect(query).toContain("## Cause classification");
    expect(query).toContain("`ENVIRONMENT_DEFECT`");
    expect(query).toContain("is downgraded to `manual_review` automatically");
  });

  it("instructs Hermes to skip login when auth is disabled", () => {
    const query = buildBrowseHermesQuery({
      judgeDocument: "## Plan\n\n### 1. public page",
      stagingLogin: {
        authRequired: false,
        loginUrl: "https://example.com/login",
        email: "",
        password: "",
        targetUrl: "https://example.com/pricing",
      },
    });

    expect(query).toContain("Open the target page directly without logging in");
    expect(query).toContain("Login required: false");
    expect(query).not.toContain("Password:");
  });

  it("keeps credentials out of the prompt in preauthenticated mode", () => {
    const query = buildBrowseHermesQuery({
      judgeDocument: "## Plan\n\n### 1. test",
      stagingLogin: {
        loginUrl: "https://example.com/login",
        email: "qa@example.com",
        password: "super-secret-pw",
        targetUrl: "https://example.com/dashboard",
      },
      preauthenticated: true,
    });

    expect(query).not.toContain("super-secret-pw");
    expect(query).not.toContain("qa@example.com");
    expect(query).not.toContain("Password:");
    expect(query).toContain("already authenticated");
    expect(query).toContain("never enter credentials");
    expect(query).toContain("Target URL: https://example.com/dashboard");
  });

  it("still embeds credentials in the legacy prompt flow", () => {
    const query = buildBrowseHermesQuery({
      judgeDocument: "## Plan\n\n### 1. test",
      stagingLogin: {
        loginUrl: "https://example.com/login",
        email: "qa@example.com",
        password: "pw",
        targetUrl: "https://example.com/dashboard",
      },
    });

    expect(query).toContain("Password: pw");
    expect(query).toContain("Login URL: https://example.com/login");
  });

  it("tells the judge to wait for the page to settle before failing", () => {
    const query = buildBrowseHermesQuery({
      judgeDocument: "## Plan",
      stagingLogin: {
        authRequired: false,
        loginUrl: "https://example.com/login",
        email: "",
        password: "",
        targetUrl: "https://example.com/pricing",
      },
    });

    expect(query).toContain("wait until the page settles");
    expect(query).toContain("re-observe once settled before marking `fail`");
  });
});

describe("judge prompt", () => {
  it("tells the judge that an unsatisfiable mock precondition is skip, not manual_review", async () => {
    const { buildBrowseHermesQuery } = await import("../run-hermes-page-judge.mjs");
    const query = buildBrowseHermesQuery({
      judgeDocument: "### ACTIVE — a check",
      stagingLogin: { targetUrl: "https://staging.acmecorp.com/dashboard" },
      preauthenticated: true,
    });

    expect(query).toMatch(/\*\*skip\*\* when the mocked precondition cannot exist/);
    expect(query).toMatch(/not `manual_review`/);
  });
});

// Oracle refactor-entry-flows O1/O21/O24: where staging credentials may appear
// (docs/how-to/authentication.md). The expected decision below is the card's
// O1 rule, not a copy of the production branches.
describe("credential decision per adapter auth, session source, flag and env", () => {
  const PASSWORD = "S3cret-pw-value";
  const EMAIL = "qa-auth@test.internal";
  const AUTHS = ["credentials-in-prompt", "self-prelogin", "cdp-attach"] as const;
  const SESSIONS = ["none", "storage-state", "session-profile", "cdp-url"] as const;
  const FLAGS = ["absent", "present"] as const;
  const CREDS = ["set", "unset"] as const;
  type Case = {
    auth: (typeof AUTHS)[number];
    session: (typeof SESSIONS)[number];
    flag: (typeof FLAGS)[number];
    creds: (typeof CREDS)[number];
  };
  const CASES: Case[] = AUTHS.flatMap(auth =>
    SESSIONS.flatMap(session =>
      FLAGS.flatMap(flag => CREDS.map(creds => ({ auth, session, flag, creds }))),
    ),
  );

  // O1 Then: preauthenticated ⇔ F absent ∧ (A = self-prelogin ∨ (A = cdp-attach ∧ S ≠ none))
  function preauthenticated({ auth, session, flag }: Case) {
    return flag === "absent" && (auth === "self-prelogin" || (auth === "cdp-attach" && session !== "none"));
  }
  // O1 Then: with C = unset it rejects unless preauthenticated ∧ (A = cdp-attach ∨ S = storage-state)
  function rejectsForMissingCredentials(c: Case) {
    return c.creds === "unset" && !(preauthenticated(c) && (c.auth === "cdp-attach" || c.session === "storage-state"));
  }

  function arrange(c: Case) {
    mocks.capabilities.auth = c.auth;
    delete process.env.QA_BROWSER_CDP_URL;
    if (c.creds === "set") {
      process.env.STAGING_QA_EMAIL = EMAIL;
      process.env.STAGING_QA_PASSWORD = PASSWORD;
    } else {
      delete process.env.STAGING_QA_EMAIL;
      delete process.env.STAGING_QA_PASSWORD;
    }
    if (c.session === "storage-state") {
      writeFileSync(
        join(root, "playwright-spec-for-ai-agent.config.json"),
        JSON.stringify({ staging: { storageState: "state.json" } }),
      );
      resetProjectConfigForTests();
    }
    mocks.hasSessionProfile.mockReturnValue(c.session === "session-profile");
    mocks.launchAuthenticatedBrowser.mockResolvedValue(sessionStub());
    mocks.connectExistingBrowser.mockResolvedValue(sessionStub());
    const argv = [...ARGV];
    if (c.session === "cdp-url") argv.push("--cdp-url=http://127.0.0.1:9222");
    if (c.flag === "present") argv.push("--credentials-in-prompt");
    return argv;
  }

  function securityWarnings() {
    return vi.mocked(console.warn).mock.calls.filter(call => String(call[0]).startsWith("[security]")).length;
  }

  it.each(CASES)(
    "[O1] auth=$auth session=$session flag=$flag creds=$creds",
    async c => {
      const argv = arrange(c);

      if (rejectsForMissingCredentials(c)) {
        await expect(main(argv)).rejects.toMatchObject({
          exitCode: 3,
          message: "Missing staging QA credentials.",
        });
        expect(mocks.runAgent).toHaveBeenCalledTimes(0);
        expect(securityWarnings()).toBe(0);
        return;
      }

      expect(await main(argv)).toBe(0);
      expect(mocks.runAgent).toHaveBeenCalledTimes(1);
      const query = String(mocks.runAgent.mock.calls[0][0]);
      if (preauthenticated(c)) {
        expect(query.includes(PASSWORD)).toBe(false);
        expect(query.includes(EMAIL)).toBe(false);
        expect(securityWarnings()).toBe(0);
      } else {
        expect(query.includes(PASSWORD)).toBe(true);
        expect(securityWarnings()).toBe(1);
      }
    },
  );

  it.each(CASES)(
    "[O21] dry-run auth=$auth session=$session flag=$flag creds=$creds",
    async c => {
      const argv = [...arrange(c), "--dry-run"];

      if (rejectsForMissingCredentials(c)) {
        await expect(main(argv)).rejects.toMatchObject({
          exitCode: 3,
          message: "Missing staging QA credentials.",
        });
      } else {
        expect(await main(argv)).toBe(0);
        const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
        expect(printed).toContain(
          preauthenticated(c)
            ? `auth mode:     preauthenticated (${c.auth})`
            : "auth mode:     credentials-in-prompt",
        );
        expect(securityWarnings()).toBe(preauthenticated(c) ? 0 : 1);
      }
      expect(mocks.runAgent).toHaveBeenCalledTimes(0);
      expect(mocks.launchAuthenticatedBrowser).toHaveBeenCalledTimes(0);
      expect(mocks.connectExistingBrowser).toHaveBeenCalledTimes(0);
    },
  );

  it("[O24] keeps the run's credential decision across a retried attempt", async () => {
    const argv = arrange({ auth: "cdp-attach", session: "session-profile", flag: "absent", creds: "set" });
    mocks.runAgent
      .mockImplementationOnce(() => {
        throw new EnvironmentError("login flap");
      })
      .mockImplementation(() => agentPayload());

    expect(await main(argv)).toBe(0);

    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
    for (const [query] of mocks.runAgent.mock.calls) {
      expect(String(query).includes(PASSWORD)).toBe(false);
    }
    expect(mocks.launchAuthenticatedBrowser).toHaveBeenCalledTimes(2);
    expect(readLedgerKinds().filter(entry => entry.kind === "judge-retry")).toHaveLength(1);
    expect(securityWarnings()).toBe(0);
  });
});

// Oracle refactor-entry-flows O2 (P2): the preflight plan is not written to disk.
describe("judge plan file", () => {
  it("[O2] leaves no plan file when the run fails before the final plan", async () => {
    const file = join(root, "fixture.txt");
    writeFileSync(file, "fixture");
    mocks.uploadFixtures = { document: file };
    mocks.capabilities.auth = "cdp-attach";
    const probe = vi
      .spyOn(uploadPreflight, "preflightUploads")
      .mockRejectedValue(new EnvironmentError("Upload preflight failed"));

    await expect(main(ARGV)).rejects.toThrow("Upload preflight failed");

    expect(probe).toHaveBeenCalledTimes(1);
    expect(mocks.runAgent).toHaveBeenCalledTimes(0);
    const ledger = readLedgerKinds();
    expect(ledger.at(-1)).toMatchObject({ kind: "judge", status: "error", cause: "ENVIRONMENT_DEFECT" });
    expect(ledger.filter(entry => entry.kind === "judge-retry")).toHaveLength(0);
    expect(existsSync(join(outputDir, "dashboard-qa-run.invalid"))).toBe(true);
    expect(readdirSync(outputDir).filter(name => name.endsWith("-qa-judge-plan.md"))).toEqual([]);
  });
});

// Oracle refactor-entry-flows O9 (P1): an unclassified error is quarantined, never retried.
describe("judge unclassified failure", () => {
  it("[O9] quarantines an unclassified error as HARNESS_DEFECT without a retry", async () => {
    mocks.runAgent.mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(main(ARGV)).rejects.toThrow("boom");

    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    const ledger = readLedgerKinds();
    expect(ledger.filter(entry => entry.kind === "judge-retry")).toHaveLength(0);
    expect(ledger.at(-1)).toMatchObject({ kind: "judge", status: "error", cause: "HARNESS_DEFECT" });
    expect(existsSync(join(outputDir, "dashboard-qa-run.invalid"))).toBe(true);
    expect(existsSync(join(outputDir, "dashboard-hermes-judgment.json"))).toBe(false);
  });
});

// Oracle refactor-entry-flows O20 (P3): the public module surface does not move.
describe("public module surface", () => {
  it("[O20] keeps the export names of the judge, config and doctor modules", async () => {
    const judge = await import("../run-hermes-page-judge.mjs");
    const config = await import("../hermes-qa-project-config.mjs");
    const doctor = await import("../run-qa-doctor.mjs");

    expect(Object.keys(judge).sort()).toEqual([
      "buildBrowseHermesQuery",
      "main",
      "prepareJudgePlan",
      "resolveAttachUrl",
    ]);
    expect(Object.keys(config).sort()).toEqual([
      "DEFAULT_PATH_TEMPLATES",
      "DEFAULT_STAGING_ACCOUNT",
      "LIVE_RUN_POLICIES",
      "applyPathTemplate",
      "applyStagingAccountDefaults",
      "applyStagingUrlDefaults",
      "defineConfig",
      "getAllowedOrigins",
      "getGithubIssueConfig",
      "getHooks",
      "getLivePolicyOverrides",
      "getPackageScriptsDir",
      "getPageConfig",
      "getProjectConfig",
      "getStagingVersionUrl",
      "getStorageStatePath",
      "isPlaceholderBaseUrl",
      "listConfiguredPages",
      "loadProjectConfig",
      "mergeUploadFixtures",
      "printProjectConfigHelp",
      "resetProjectConfigForTests",
      "resolveBaseUrlForPage",
      "resolveDefaultUploadFixtures",
      "resolveFixturePaths",
      "resolveJudgeTarget",
      "resolveOutputDirForPage",
      "resolvePageUrlForPage",
      "resolvePathFromConfig",
      "resolveSpecDirForPage",
      "resolveTargetPathForPage",
    ]);
    expect(Object.keys(doctor).sort()).toEqual([
      "collectDoctorReport",
      "formatDoctorReport",
      "parseDoctorArgs",
    ]);
  });
});

// A no-confirm check never attaches a file live, so its plan identity must not
// offer one — offering it sent the agent to a tool that refuses the policy.
describe("upload fixtures offered per check", () => {
  it("offers no fixture to a judgment-interaction-no-confirm check", async () => {
    const spec = {
      scenarios: [
        {
          ...SPEC.scenarios[0],
          tests: [
            {
              title: "shows the file name",
              checkId: "shows-the-file-name",
              liveRunPolicy: "judgment-interaction-no-confirm",
              stagingMode: "judgment",
              fixtures: { upload: "fixtures/a.png" },
              expectations: [],
            },
          ],
        },
      ],
    };
    mocks.resolveSpecForJudge.mockReturnValue({
      path: join(outputDir, "dashboard-qa-spec.json"),
      definition: spec,
      planSource: "spec-live.json",
      staleness: { ok: true, expected: null, actual: "sha256:abc" },
    });

    expect(await main([...ARGV, "--dry-run"])).toBe(0);

    const query = readFileSync(join(outputDir, "dashboard-hermes-query.txt"), "utf8");
    const identities = JSON.parse(query.split("## Check identities")[1].split("```json")[1].split("```")[0]);
    expect(identities).toHaveLength(1);
    expect(identities[0].uploadFixtures).toEqual({});
    expect(identities[0].requiredUploadFixtures).toEqual({});
  });

  it("tells the judge a no-confirm check that needs a file is a SPEC_GAP skip", () => {
    const query = buildBrowseHermesQuery({
      judgeDocument: "plan",
      stagingLogin: { authRequired: false, targetUrl: "https://x.test/" },
    });
    expect(query).toContain(
      "A judgment-interaction-no-confirm check whose plan needs an attached file cannot run live: report it `skip` with cause `SPEC_GAP`",
    );
  });
});

describe("upload repetition wording", () => {
  it("scopes 'do not repeat an upload' to one check, not one file", () => {
    const query = buildBrowseHermesQuery({
      judgeDocument: "plan",
      stagingLogin: { authRequired: false, targetUrl: "https://x.test/" },
    });
    expect(query).toContain(
      "Each executable-interaction check that declares a fixture needs its own upload under its own checkId, even when an earlier check uploaded the same file; never reuse another check's upload or outcome.",
    );
    expect(query).toContain("Within one check, do not repeat an upload after an unknown outcome.");
  });
});

describe("checkpoint timing wording", () => {
  it("asks for a checkpoint at every state a pass quotes, transient ones included", () => {
    const query = buildBrowseHermesQuery({
      judgeDocument: "plan",
      stagingLogin: { authRequired: false, targetUrl: "https://x.test/" },
    });
    expect(query).toContain(
      "A pass may quote only text a checkpoint of that check captured: call qa_checkpoint again the moment each quoted state appears, including a transient one such as a processing indicator, before it changes.",
    );
  });
});

describe("truncated source wording", () => {
  it("forbids a fail resting on behaviour a truncated excerpt does not show", () => {
    const query = buildBrowseHermesQuery({
      judgeDocument: "plan",
      stagingLogin: { authRequired: false, targetUrl: "https://x.test/" },
    });
    expect(query).toContain(
      "An excerpt ending in `// … excerpt truncated` is not the whole check: never `fail` on behaviour the excerpt does not show — use `manual_review`.",
    );
  });
});
