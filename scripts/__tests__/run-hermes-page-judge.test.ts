import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { AgentOutputError, EnvironmentError } from "../errors.mjs";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  prelogin: vi.fn(),
  launchAuthenticatedBrowser: vi.fn(),
  hasSessionProfile: vi.fn(() => false),
  resolveSpecForJudge: vi.fn(),
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
  resolveAdapterName: () => "test-adapter",
}));

vi.mock("../qa-browser-session.mjs", () => ({
  hasSessionProfile: mocks.hasSessionProfile,
  launchAuthenticatedBrowser: mocks.launchAuthenticatedBrowser,
  SESSION_PROFILE_DIR: ".private/qa-browser-profile",
}));

vi.mock("../qa-spec-artifacts.mjs", () => ({
  loadSpecSourceFiles: () => ({}),
  buildUploadFixturesPayload: () => ({
    projectRoot: "/tmp",
    defaults: {},
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
  mocks.prelogin.mockReset();
  mocks.launchAuthenticatedBrowser.mockReset();
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

function readLedgerKinds() {
  const path = join(outputDir, "dashboard-qa-runs.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function sessionStub(evidence: Record<string, unknown> = {}) {
  const captured = {
    tracePath: null,
    harPath: null,
    videoPath: null,
    screenshots: [],
    ariaSnapshots: [],
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
