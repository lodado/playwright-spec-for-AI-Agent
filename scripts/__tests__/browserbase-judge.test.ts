import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { saveBrowserbaseContext } from "../browser-provider.mjs";
const mocks = vi.hoisted(() => ({ run: vi.fn(), launch: vi.fn(), resolve: vi.fn(), auth: "cdp-attach" }));
vi.mock("../ai-agent-adapter.mjs", () => ({ prepareAdapter: async () => ({ name: "test", capabilities: { auth: mocks.auth, supportsMaxTurns: true, blocksEventLoop: true } }), runAgent: mocks.run }));
vi.mock("../browser-provider.mjs", async importOriginal => ({ ...await importOriginal<any>(), launchBrowserbaseSession: mocks.launch }));
vi.mock("../resolve-spec-for-judge.mjs", () => ({ resolveSpecForJudge: mocks.resolve }));
vi.mock("../qa-spec-artifacts.mjs", () => ({ loadSpecSourceFiles: () => ({}), buildUploadFixturesPayload: () => ({ defaults: {}, byCheckId: {} }) }));
import { main } from "../run-hermes-page-judge.mjs";
let root: string, oldCwd: string, output: string, close: any;
const original = { ...process.env };
const base = "https://staging.example.test";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bb-judge-")); oldCwd = process.cwd(); process.chdir(root);
  resetProjectConfigForTests(); output = join(root, "__QA__", "dashboard"); mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "dashboard-qa-spec-live.md"), "## Plan\n### ACTIVE — shows score\n");
  Object.assign(process.env, { QA_BROWSER_PROVIDER: "browserbase", BROWSERBASE_API_KEY: "TOPSECRET", BROWSERBASE_PROJECT_ID: "project-1", STAGING_QA_BASE_URL: base, QA_OUTPUT_DIR: output, CI: "true" });
  delete process.env.STAGING_QA_EMAIL; delete process.env.STAGING_QA_PASSWORD; delete process.env.QA_BROWSER_CDP_URL; delete process.env.BROWSER_CDP_URL;
  mocks.auth = "cdp-attach";
  mocks.resolve.mockReturnValue({ path: join(output, "dashboard-qa-spec.json"), planSource: "spec-live.json", staleness: { ok: true, expected: null, actual: "sha256:abc" }, definition: { scenarios: [{ scenarioId: "ACTIVE", tests: [{ title: "shows score", checkId: "score", liveRunPolicy: "executable-readonly", stagingMode: "read-only", expectations: [] }] }] } });
  mocks.run.mockReset().mockImplementation(() => ({ status: "manual_review", cause: "SPEC_GAP", summary: "TOPSECRET", checks: [{ item: "shows score", result: "manual_review", cause: "SPEC_GAP", confidence: "low", detail: "visible", evidenceRefs: [] }], evidence: [] }));
  const evidence = { screenshots: [], ariaSnapshots: [], violations: [], tracePath: null, harPath: null, videoPath: null, browserProvider: { name: "browserbase", sessionId: "session-1" } };
  close = vi.fn(async () => evidence);
  const page = { goto: vi.fn(async () => ({ status: () => 200 })), url: () => base + "/dashboard", locator: () => ({ first: () => ({ isVisible: async () => true }) }) };
  mocks.launch.mockReset().mockResolvedValue({ cdpUrl: "wss://connect.browserbase.com?apiKey=TOPSECRET", secrets: ["TOPSECRET"], metadata: evidence.browserProvider, evidence, close, context: { pages: () => [page], newPage: async () => page } });
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200 })));
});
afterEach(() => { process.chdir(oldCwd); rmSync(root, { recursive: true, force: true }); process.env = { ...original }; resetProjectConfigForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const args = ["--page=dashboard", "--target-path=/dashboard"];
const save = () => saveBrowserbaseContext({ root, projectId: "project-1", origin: base, profile: "default", contextId: "context-1", successUrl: base + "/dashboard" });
describe("Browserbase judge boundary", () => {
  it("fails before agent allocation for an incompatible AI adapter", async () => {
    mocks.auth = "self-prelogin";
    await expect(main(args)).rejects.toThrow(/cdp-attach/); expect(mocks.launch).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("rejects explicit CDP and credential prompt conflicts", async () => {
    await expect(main([...args, "--cdp-url=https://local"])).rejects.toThrow(/cdp-url/);
    await expect(main([...args, "--credentials-in-prompt"])).rejects.toThrow(/credentials-in-prompt/);
  });
  it("does not silently use a local login when no cloud Context exists", async () => {
    await expect(main(args)).rejects.toThrow(/login.*browserbase|Browserbase.*Context/); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("dry-run does not create a session or call a model", async () => {
    save(); expect(await main([...args, "--dry-run"])).toBe(0); expect(mocks.launch).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("reuses cloud Context, forwards CDP, preserves evidence and removes secrets", async () => {
    save(); mocks.run.mockImplementation(() => {
      expect(process.env.BROWSER_CDP_URL).toContain("TOPSECRET"); expect(process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe(process.env.BROWSER_CDP_URL);
      expect(process.env.BROWSERBASE_API_KEY).toBeUndefined();
      return { status: "manual_review", cause: "SPEC_GAP", summary: "TOPSECRET", checks: [], evidence: [] };
    });
    expect(await main(args)).toBe(0);
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ contextId: "context-1", persist: false }));
    expect(close).toHaveBeenCalledTimes(1); expect(process.env.BROWSER_CDP_URL).toBeUndefined(); expect(process.env.BROWSERBASE_API_KEY).toBe("TOPSECRET");
    const artifact = readFileSync(join(output, "dashboard-hermes-judgment.json"), "utf8");
    expect(artifact).not.toContain("TOPSECRET"); expect(JSON.parse(artifact).runnerEvidence.browserProvider.sessionId).toBe("session-1");
    expect(readFileSync(join(output, "dashboard-hermes-judgment.md"), "utf8")).toContain("https://www.browserbase.com/sessions/session-1");
  });
  it("cleans up when the agent throws", async () => {
    save(); mocks.run.mockImplementation(() => { throw Error("TOPSECRET failure"); });
    await expect(main(args)).rejects.toThrow("[redacted] failure"); expect(close).toHaveBeenCalledTimes(1);
    expect(process.env.BROWSER_CDP_URL).toBeUndefined();
  });
  it("opens an ephemeral browser for a public page without requiring Context", async () => {
    expect(await main([...args, "--auth-required=false"])).toBe(0);
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ contextId: null })); expect(close).toHaveBeenCalledTimes(1);
  });
  it("refuses an expired Context before invoking the model and still releases it", async () => {
    vi.useFakeTimers();
    save(); const s = await mocks.launch(); mocks.launch.mockClear();
    s.context.pages()[0].url = () => base + "/login";
    const rejected = expect(main(args)).rejects.toThrow(/saved login is no longer valid/);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(mocks.run).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
  });
  it.each(["selector", "URL"])("waits for a hydrated success %s before invoking AI", async (delayed) => {
    vi.useFakeTimers();
    saveBrowserbaseContext({ root, projectId: "project-1", origin: base, contextId: "context-1", successUrl: base + "/dashboard", successSelector: "[data-user]" });
    const session = await mocks.launch(); mocks.launch.mockClear();
    let visible = false;
    session.context.pages()[0].locator = () => ({ first: () => ({ isVisible: async () => delayed === "URL" || visible }) });
    session.context.pages()[0].url = () => base + (delayed === "URL" && !visible ? "/login" : "/dashboard");
    const result = main(args).catch(error => error);
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.run).not.toHaveBeenCalled();
    visible = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(await result).toBe(0);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it.each(["missing selector", "wrong URL", "wrong origin", "non-overlapping markers"])(
    "times out when auth markers do not jointly match: %s", async (failure) => {
      vi.useFakeTimers();
      saveBrowserbaseContext({ root, projectId: "project-1", origin: base, contextId: "context-1", successUrl: failure === "wrong origin" ? "" : base + "/dashboard", successSelector: "[data-user]" });
      const session = await mocks.launch(); mocks.launch.mockClear();
      const page = session.context.pages()[0];
      let hydrated = false;
      page.url = () => failure === "wrong origin" ? "https://other.example.test/dashboard"
        : failure === "wrong URL" || (failure === "non-overlapping markers" && hydrated) ? base + "/login" : base + "/dashboard";
      page.locator = () => ({ first: () => ({ isVisible: async () => failure !== "missing selector" && (failure !== "non-overlapping markers" || hydrated) }) });
      let settled = false;
      const result = main(args).catch(error => error).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(200);
      const settledEarly = settled;
      hydrated = true;
      await vi.advanceTimersByTimeAsync(9_799);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ message: expect.stringMatching(/saved login is no longer valid/), exitCode: 3 });
      expect(settledEarly).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(mocks.run).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    },
  );
  it("state detection and judge use the same allocated remote session", async () => {
    save();
    const spec = mocks.resolve().definition;
    spec.scenarios.push({ ...spec.scenarios[0], scenarioId: "INACTIVE" });
    mocks.run.mockImplementation((_query: string, _turns: number, options: any) => {
      expect(process.env.BROWSER_CDP_URL).toContain("TOPSECRET");
      expect(options.secrets).toContain("TOPSECRET");
      return options.requiredKeys.includes("state") ? { state: "ACTIVE", confidence: "high", evidence: "dashboard" } : { status: "manual_review", cause: "SPEC_GAP", checks: [], evidence: [] };
    });
    await main(args);
    expect(mocks.run).toHaveBeenCalledTimes(2); expect(mocks.launch).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  });
});
