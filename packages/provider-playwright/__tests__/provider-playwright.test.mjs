import { describe, expect, it, vi } from "vitest";
import { QA_IR_VERSION } from "../../contracts/index.mjs";
import { createExecutionPlan } from "../../core/index.mjs";
import { verifyStoredEvidence } from "../../evidence/index.mjs";
import { executeWithPlaywright, playwrightExecutionCapabilities } from "../index.mjs";

const policy = {
  navigation: "ALLOWED",
  readDom: true,
  readNetwork: false,
  click: "NONE",
  type: "NONE",
  upload: false,
  submit: false,
  destructiveMutation: false,
  confirmation: "DENY",
  secrets: "RUNTIME_INJECTED",
};

function qaIr(target = "/dashboard") {
  return {
    schemaVersion: QA_IR_VERSION,
    id: "qa-ir-playwright",
    source: { adapter: "test", adapterVersion: "0.1", uri: "qa.spec.ts" },
    suites: [{
      id: "suite",
      title: "Suite",
      tags: [],
      provenance: [],
      scenarios: [{
        id: "scenario",
        title: "Scenario",
        preconditions: [],
        steps: [
          { id: "navigate", kind: "NAVIGATE", target: { type: "PATH", value: target } },
          { id: "observe", kind: "OBSERVE", requests: [{ type: "VISIBLE_TEXT" }, { type: "DOM_SNAPSHOT" }] },
          { id: "checkpoint", kind: "CHECKPOINT", checkpointId: "loaded" },
        ],
        expectations: [{ id: "heading", kind: "CONTAINS_TEXT", expected: { kind: "literal", value: "Dashboard" } }],
        policy,
        provenance: [],
      }],
    }],
  };
}

function fakeBrowser({ pageUrl = "https://example.test/dashboard?temporaryAccessCode=short-secret#short-secret", text = "Dashboard SESSION-SECRET", dom = "<main>Dashboard SESSION-SECRET</main>" } = {}) {
  const calls = [];
  let routeHandler;
  let webSocketHandler;
  const page = {
    async goto(url) { calls.push(["goto", url]); },
    locator(selector) {
      return {
        async evaluate(_callback, maxChars) {
          calls.push([`evaluate:${selector}`, maxChars]);
          return (selector === "body" ? text : dom).slice(0, maxChars);
        },
      };
    },
    url() { return pageUrl; },
    viewportSize() { return { width: 1280, height: 720 }; },
  };
  const browser = {
    async newContext(options) {
      calls.push(["newContext", options]);
      return {
        async route(pattern, handler) { calls.push(["route", pattern]); routeHandler = handler; },
        async routeWebSocket(pattern, handler) { calls.push(["routeWebSocket", pattern]); webSocketHandler = handler; },
        async newPage() { calls.push(["newPage"]); return page; },
      };
    },
    async close() { calls.push(["close"]); },
  };
  return {
    calls,
    browserType: { async launch() { calls.push(["launch"]); return browser; } },
    get routeHandler() { return routeHandler; },
    get webSocketHandler() { return webSocketHandler; },
  };
}

describe("readonly Playwright execution provider", () => {
  it("executes a plan and seals redacted browser evidence before returning", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser();
    const result = await executeWithPlaywright({
      qaIr: input,
      plan,
      baseUrl: "https://example.test",
      runId: "run-playwright",
      browserType: fixture.browserType,
      secrets: ["SESSION-SECRET"],
      now: () => "2026-07-25T00:00:00.000Z",
    });

    expect(result.outcome).toMatchObject({ stage: "execute", type: "COMPLETED" });
    expect(fixture.calls.map(([name]) => name)).toEqual([
      "launch", "newContext", "route", "routeWebSocket", "newPage", "goto", "evaluate:html", "evaluate:body", "close",
    ]);
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0].artifacts.map((artifact) => artifact.type)).toEqual(["DOM_SNAPSHOT", "VISIBLE_TEXT"]);
    expect(result.bundles[0].facts).toMatchObject([{ kind: "URL", value: "https://example.test/dashboard" }]);
    expect(JSON.stringify(result)).not.toContain("SESSION-SECRET");
    expect(JSON.stringify(result)).not.toContain("short-secret");
    expect(verifyStoredEvidence({ bundle: result.bundles[0], manifest: result.manifest, readBlob: result.readBlob }).bundle).toEqual(result.bundles[0]);
  });

  it("allows only same-origin HTTP(S) browser requests", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser();
    await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-routes", browserType: fixture.browserType });

    const sameOrigin = { request: () => ({ method: () => "GET", url: () => "https://example.test/app.js" }), abort: vi.fn(), continue: vi.fn() };
    const external = { request: () => ({ method: () => "GET", url: () => "https://attacker.test/collect" }), abort: vi.fn(), continue: vi.fn() };
    const mutation = { request: () => ({ method: () => "POST", url: () => "https://example.test/api/update" }), abort: vi.fn(), continue: vi.fn() };
    await fixture.routeHandler(sameOrigin);
    await fixture.routeHandler(external);
    await fixture.routeHandler(mutation);

    expect(sameOrigin.continue).toHaveBeenCalledOnce();
    expect(sameOrigin.abort).not.toHaveBeenCalled();
    expect(external.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(external.continue).not.toHaveBeenCalled();
    expect(mutation.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(mutation.continue).not.toHaveBeenCalled();

    const webSocket = { close: vi.fn() };
    fixture.webSocketHandler(webSocket);
    expect(webSocket.close).toHaveBeenCalledOnce();
  });

  it("rejects cross-origin redirects without sealing evidence and still closes the browser", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser({ pageUrl: "https://attacker.test/collect?secret=short-secret" });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-redirect", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ code: "POLICY_VIOLATION" });
    expect(result.bundles).toHaveLength(0);
    expect(fixture.calls.at(-1)).toEqual(["close"]);
    expect(JSON.stringify(result)).not.toContain("short-secret");
  });

  it("rejects mutation and cross-origin navigation before opening a browser", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    plan.nodes[0].policy.click = "SAFE_ONLY";
    const mutationBrowser = { launch: vi.fn() };
    const mutation = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-mutation", browserType: mutationBrowser });
    expect(mutation.outcome).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(mutationBrowser.launch).not.toHaveBeenCalled();

    const external = qaIr("https://attacker.test/collect");
    const externalPlan = createExecutionPlan({ qaIr: external, providerCapabilities: playwrightExecutionCapabilities() });
    const externalBrowser = { launch: vi.fn() };
    const blocked = await executeWithPlaywright({ qaIr: external, plan: externalPlan, baseUrl: "https://example.test", runId: "run-external", browserType: externalBrowser });
    expect(blocked.outcome).toMatchObject({ code: "POLICY_VIOLATION" });
    expect(externalBrowser.launch).not.toHaveBeenCalled();
  });

  it("rejects forged plans before opening a browser", async () => {
    const input = qaIr();
    input.suites[0].scenarios[0].steps[1].requests = [{ type: "VISIBLE_TEXT" }];
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });

    const cases = [];
    const forgedEvidence = structuredClone(plan);
    forgedEvidence.nodes.find((node) => node.kind === "OBSERVE").evidence = ["DOM_SNAPSHOT"];
    cases.push([input, forgedEvidence]);

    const blockedInput = structuredClone(input);
    blockedInput.suites[0].scenarios[0].policy.navigation = "BLOCKED";
    cases.push([blockedInput, plan]);

    const duplicateNavigation = structuredClone(plan);
    duplicateNavigation.nodes.push({ ...structuredClone(duplicateNavigation.nodes[0]), nodeId: "forged-extra-navigation" });
    cases.push([input, duplicateNavigation]);

    for (const [candidateIr, candidatePlan] of cases) {
      const browserType = { launch: vi.fn() };
      const result = await executeWithPlaywright({ qaIr: candidateIr, plan: candidatePlan, baseUrl: "https://example.test", runId: "run-forged", browserType });
      expect(result.outcome).toMatchObject({ code: "CONTRACT_VIOLATION" });
      expect(browserType.launch).not.toHaveBeenCalled();
    }
  });

  it("rejects retries before opening a browser", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities(), retryPolicy: { maxAttempts: 2 } });
    const browserType = { launch: vi.fn() };
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-retry", browserType });

    expect(result.outcome).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(browserType.launch).not.toHaveBeenCalled();
  });

  it("rejects excessive viewport dimensions before opening a browser", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const browserType = { launch: vi.fn() };
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-viewport", browserType, viewport: { width: 4097, height: 1 } });

    expect(result.outcome).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(browserType.launch).not.toHaveBeenCalled();
  });

  it("caps aggregate evidence and closes the browser on storage failure", async () => {
    const input = qaIr();
    const template = input.suites[0].scenarios[0];
    input.suites[0].scenarios = [0, 1, 2, 3].map((index) => ({
      ...structuredClone(template),
      id: `scenario-${index}`,
      steps: template.steps.map((step) => ({ ...structuredClone(step), id: `${step.id}-${index}`, ...(step.kind === "CHECKPOINT" ? { checkpointId: `loaded-${index}` } : {}) })),
    }));
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser({ text: "x".repeat(1024 * 1024), dom: "x".repeat(4 * 1024 * 1024) });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-cap", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ code: "EVIDENCE_STORAGE_FAILED" });
    expect(fixture.calls.at(-1)).toEqual(["close"]);
  });

  it("bounds browser-to-Node capture before rejecting oversized evidence", async () => {
    const input = qaIr();
    input.suites[0].scenarios[0].steps[1].requests = [{ type: "VISIBLE_TEXT" }];
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser({ text: "x".repeat(1024 * 1024 + 10) });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-bounded", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ code: "EVIDENCE_STORAGE_FAILED" });
    expect(fixture.calls.find(([name]) => name === "evaluate:body")).toEqual(["evaluate:body", 1024 * 1024 + 1]);
    expect(fixture.calls.at(-1)).toEqual(["close"]);
  });

  it("does not report success when observations remain unsealed", async () => {
    const input = qaIr();
    input.suites[0].scenarios[0].steps.push({ id: "observe-after-checkpoint", kind: "OBSERVE", requests: [{ type: "VISIBLE_TEXT" }] });
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser();
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-unsealed", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ code: "EVIDENCE_STORAGE_FAILED" });
    expect(fixture.calls.at(-1)).toEqual(["close"]);
  });

  it("reports browser startup failures as runtime errors without verdicts", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const result = await executeWithPlaywright({
      qaIr: input,
      plan,
      baseUrl: "https://example.test",
      runId: "run-failed",
      browserType: { async launch() { throw new Error("browser-secret"); } },
    });

    expect(result.outcome).toMatchObject({ stage: "execute", type: "ERROR", code: "BROWSER_START_FAILED", message: "Execution provider failed" });
    expect(result.outcome.verdict).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("browser-secret");
  });

  it("closes a launched browser when startup exceeds the node timeout", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({
      qaIr: input,
      providerCapabilities: playwrightExecutionCapabilities(),
      timeoutPolicy: { perNodeMs: 1, runMs: 10 },
    });
    const close = vi.fn(async () => {});
    const result = await executeWithPlaywright({
      qaIr: input,
      plan,
      baseUrl: "https://example.test",
      runId: "run-startup-timeout",
      browserType: {
        async launch() {
          return { close, newContext: () => new Promise(() => {}) };
        },
      },
    });

    expect(result.outcome).toMatchObject({ code: "UNKNOWN_RUNTIME_ERROR", message: "Execution timed out" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a browser whose launch completes after the node timeout", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({
      qaIr: input,
      providerCapabilities: playwrightExecutionCapabilities(),
      timeoutPolicy: { perNodeMs: 1, runMs: 10 },
    });
    const close = vi.fn(async () => {});
    let finishLaunch;
    const launch = new Promise((resolve) => { finishLaunch = () => resolve({ close, newContext: vi.fn() }); });
    const result = await executeWithPlaywright({
      qaIr: input,
      plan,
      baseUrl: "https://example.test",
      runId: "run-late-launch",
      browserType: { launch: () => launch },
    });

    finishLaunch();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(result.outcome).toMatchObject({ code: "UNKNOWN_RUNTIME_ERROR", message: "Execution timed out" });
  });
});
