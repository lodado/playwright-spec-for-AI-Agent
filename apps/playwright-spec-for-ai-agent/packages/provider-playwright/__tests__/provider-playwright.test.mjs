import { describe, expect, it, vi } from "vitest";
import { QA_IR_VERSION } from "../../contracts/index.mjs";
import { createExecutionPlan } from "../../core/index.mjs";
import { verifyStoredEvidence } from "../../evidence/index.mjs";
import { evaluateDeterministically } from "../../judge/index.mjs";
import { executeWithPlaywright, normalizeAuthBootstrap, playwrightExecutionCapabilities } from "../index.mjs";

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
          { id: "navigate", kind: "NAVIGATE", milestoneClass: "REQUIRED_SEMANTIC_MILESTONE", target: { type: "PATH", value: target } },
          { id: "observe", kind: "OBSERVE", requests: [{ type: "VISIBLE_TEXT" }, { type: "DOM_SNAPSHOT" }, { type: "ELEMENT_OBSERVATION" }] },
          { id: "checkpoint", kind: "CHECKPOINT", checkpointId: "loaded" },
        ],
        expectations: [{ id: "heading", kind: "CONTAINS_TEXT", target: { testId: "heading" }, expected: { kind: "literal", value: "Dashboard" } }],
        policy,
        provenance: [],
      }],
    }],
  };
}

function clickableQaIr(action = "CLICK") {
  const input = qaIr();
  input.suites[0].scenarios[0].policy = { ...policy, click: "SAFE_ONLY" };
  input.suites[0].scenarios[0].steps.splice(1, 0, {
    id: "click",
    kind: "INTERACT",
    milestoneClass: "REQUIRED_EXACT_ACTION",
    action,
    target: { testId: "open-menu" },
    ...(action === "CLICK" ? {} : { value: "unsafe" }),
  });
  return input;
}

function fakeBrowser({ pageUrl = "https://example.test/dashboard?temporaryAccessCode=short-secret#short-secret", text = "Dashboard SESSION-SECRET", dom = "<main>Dashboard SESSION-SECRET</main>", clickError, onClick, onGoto, closeDelayMs = 0, elementCount = 1, visible = true, waitForVisible = visible, elementDetached = false, appearsAfterWait = false } = {}) {
  const calls = [];
  let routeHandler;
  let webSocketHandler;
  let appeared = false;
  // Model a mount/entry animation: `isVisible()` is the instant snapshot, `waitFor({state:"visible"})` resolves once the element becomes visible (or rejects if it never does).
  // `appearsAfterWait` models a page still rendering at observation time: count() is 0 until the
  // observer waits for the element to appear.
  const visibility = {
    async isVisible() { return visible; },
    async waitFor(options) {
      if (appearsAfterWait) {
        appeared = true;
        return;
      }
      if (options?.state === "visible" && !waitForVisible) {
        // Real Playwright blocks for the full timeout before rejecting — model that, it is the race.
        await new Promise((resolve) => setTimeout(resolve, options?.timeout ?? 0));
        throw new Error("waitFor: element never became visible");
      }
    },
  };
  const countNow = async () => (appearsAfterWait && !appeared ? 0 : elementCount);
  const page = {
    async goto(url) { calls.push(["goto", url]); await onGoto?.({ url, routeHandler }); },
    locator(selector) {
      return {
        async evaluate(_callback, maxChars) {
          calls.push([`evaluate:${selector}`, maxChars]);
          return (selector === "body" ? text : dom).slice(0, maxChars);
        },
      };
    },
    getByTestId(value) {
      return {
        ...visibility,
        async count() { return countNow(); },
        async evaluate(_callback, argument, options) {
          if (elementDetached) {
            // Real Playwright waits the full timeout for a detached element to re-attach.
            await new Promise((resolve) => setTimeout(resolve, options?.timeout ?? 0));
            throw new Error("evaluate: element is not attached to the DOM");
          }
          return typeof argument === "number" ? text.slice(0, argument + 1) : { anchor: false, form: false, editable: false };
        },
        async click() {
          calls.push(["click:testId", value]);
          if (clickError) throw clickError;
          await onClick?.({ routeHandler, webSocketHandler });
        },
      };
    },
    getByText(value) {
      return { ...visibility, async count() { return countNow(); }, async evaluate() { return text; }, async click() { calls.push(["click:text", value]); } };
    },
    getByRole(role, options) {
      return { ...visibility, async count() { return countNow(); }, async evaluate(_callback, argument) { return typeof argument === "number" ? text.slice(0, argument + 1) : { anchor: false, form: false, editable: false }; }, async click() { calls.push(["click:role", role, options]); } };
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
    async close() {
      if (closeDelayMs > 0) await new Promise(resolve => setTimeout(resolve, closeDelayMs));
      calls.push(["close"]);
    },
  };
  return {
    calls,
    browserType: { async launch() { calls.push(["launch"]); return browser; } },
    get routeHandler() { return routeHandler; },
    get webSocketHandler() { return webSocketHandler; },
  };
}

describe("readonly Playwright execution provider", () => {
  it("uses session state and confines bootstrap mutations to declared endpoints", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    let bootstrapPost;
    const fixture = fakeBrowser({
      onGoto: async ({ url, routeHandler }) => {
        if (url !== "https://example.test/login") return;
        bootstrapPost = { request: () => ({ method: () => "POST", url: () => "https://example.test/api/auth/session" }), abort: vi.fn(), continue: vi.fn() };
        await routeHandler(bootstrapPost);
      },
    });
    const authBootstrap = {
      url: "https://example.test/login",
      allowedEndpoints: [{ origin: "https://example.test", path: "/api/auth/session", methods: ["POST"] }],
    };
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-bootstrap", browserType: fixture.browserType, storageStatePath: "/private/session.json", authBootstrap });
    expect(result.outcome).toMatchObject({ type: "COMPLETED" });
    expect(fixture.calls).toContainEqual(["newContext", expect.objectContaining({ storageState: "/private/session.json" })]);
    expect(fixture.calls.map(([name, value]) => name === "goto" && value)).toContain("https://example.test/login");
    expect(bootstrapPost.continue).toHaveBeenCalledOnce();
    const postBootstrapMutation = { request: () => ({ method: () => "POST", url: () => "https://example.test/api/auth/session" }), abort: vi.fn(), continue: vi.fn() };
    await fixture.routeHandler(postBootstrapMutation);
    expect(postBootstrapMutation.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(postBootstrapMutation.continue).not.toHaveBeenCalled();
  });

  it("rejects broad or credential-bearing auth bootstrap configurations", () => {
    expect(() => normalizeAuthBootstrap({ url: "https://example.test/login?token=secret" }, "https://example.test")).toThrow("auth bootstrap is invalid");
    expect(() => normalizeAuthBootstrap({ url: "https://example.test/login", allowedEndpoints: [{ origin: "https://example.test", path: "/api/auth", methods: ["GET"] }] }, "https://example.test")).toThrow("auth bootstrap is invalid");
  });

  it("executes a plan and seals redacted browser evidence before returning", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser({ text: "Dashboard" });
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
    expect(result.bundles[0].facts).toMatchObject([
      { kind: "ELEMENT_OBSERVATION", value: { expectationId: "heading", resolution: "FOUND", visible: true, text: "Dashboard", textTruncated: false } },
      { kind: "URL", value: "https://example.test/dashboard" },
    ]);
    expect(evaluateDeterministically({ qaIr: input, bundle: result.bundles[0], manifest: result.manifest, readBlob: result.readBlob }).resolvedChecks).toMatchObject([
      { expectationId: "heading", status: "MATCHED" },
    ]);
    expect(JSON.stringify(result)).not.toContain("SESSION-SECRET");
    expect(JSON.stringify(result)).not.toContain("short-secret");
    expect(verifyStoredEvidence({ bundle: result.bundles[0], manifest: result.manifest, readBlob: result.readBlob }).bundle).toEqual(result.bundles[0]);
  });

  it("waits for entry-animated elements to become visible instead of snapshotting them hidden", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    // Element is present but hidden at t=0 (opacity:0/visibility:hidden mount animation) and becomes visible shortly after.
    const fixture = fakeBrowser({ text: "Dashboard", visible: false, waitForVisible: true });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-visibility-wait", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ type: "COMPLETED" });
    expect(result.bundles[0].facts).toMatchObject([
      { kind: "ELEMENT_OBSERVATION", value: { expectationId: "heading", resolution: "FOUND", visible: true } },
      { kind: "URL" },
    ]);
  });

  it("observes a present-but-hidden NOT_VISIBLE target as a fact instead of timing out the run", async () => {
    // Consumer repro: dashboard-inactive's `.not.toBeVisible()` targets are sometimes in the DOM
    // but hidden. Waiting for them to become visible burns the whole node timeout and killed the
    // run (strict one-shot 0/4). Observation must snapshot hidden state, never wait for it.
    const input = qaIr();
    input.suites[0].scenarios[0].expectations = [{ id: "signin-hidden", kind: "NOT_VISIBLE", target: { testId: "signin" }, provenance: [] }];
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities(), timeoutPolicy: { perNodeMs: 400, runMs: 5_000 } });
    const fixture = fakeBrowser({ text: "Dashboard", visible: false, waitForVisible: false });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-hidden-not-visible", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ type: "COMPLETED" });
    expect(result.bundles[0].facts[0]).toMatchObject({ kind: "ELEMENT_OBSERVATION", value: { expectationId: "signin-hidden", resolution: "FOUND", visible: false } });
  });

  it("bounds the entry-animation visibility wait below the node timeout for VISIBLE expectations", async () => {
    // A VISIBLE expectation whose element never shows must end as an observed visible:false fact
    // within the node budget — not as a run-killing node timeout.
    const input = qaIr();
    input.suites[0].scenarios[0].expectations = [{ id: "heading-visible", kind: "VISIBLE", target: { testId: "heading" }, provenance: [] }];
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities(), timeoutPolicy: { perNodeMs: 400, runMs: 5_000 } });
    const fixture = fakeBrowser({ text: "Dashboard", visible: false, waitForVisible: false });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-never-visible", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ type: "COMPLETED" });
    expect(result.bundles[0].facts[0]).toMatchObject({ kind: "ELEMENT_OBSERVATION", value: { expectationId: "heading-visible", resolution: "FOUND", visible: false } });
  });

  it("waits for a VISIBLE target still rendering at observation time instead of recording MISSING", async () => {
    // Playwright assertions retry for their declared timeout; an observation taken mid-render must
    // do the same for appearance, or a loading page becomes a MISSING fact and a false verdict.
    const input = qaIr();
    input.suites[0].scenarios[0].expectations = [{ id: "heading-visible", kind: "VISIBLE", target: { testId: "heading" }, provenance: [] }];
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities(), timeoutPolicy: { perNodeMs: 400, runMs: 5_000 } });
    const fixture = fakeBrowser({ text: "Dashboard", appearsAfterWait: true });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-late-render", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ type: "COMPLETED" });
    expect(result.bundles[0].facts[0]).toMatchObject({ kind: "ELEMENT_OBSERVATION", value: { expectationId: "heading-visible", resolution: "FOUND", visible: true } });
  });

  it("records a detached element as MISSING instead of timing out the run", async () => {
    // Hydration re-renders detach elements between count() and evaluate(); waiting the full node
    // timeout for re-attachment killed the run the same way the visibility wait did.
    const input = qaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities(), timeoutPolicy: { perNodeMs: 400, runMs: 5_000 } });
    const fixture = fakeBrowser({ text: "Dashboard", elementDetached: true });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-detached", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ type: "COMPLETED" });
    expect(result.bundles[0].facts[0]).toMatchObject({ kind: "ELEMENT_OBSERVATION", value: { expectationId: "heading", resolution: "MISSING" } });
  });

  it("keeps ambiguous semantic targets unresolved instead of inventing a deterministic result", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser({ elementCount: 2 });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-ambiguous", browserType: fixture.browserType });
    const evaluation = evaluateDeterministically({ qaIr: input, bundle: result.bundles[0], manifest: result.manifest, readBlob: result.readBlob });

    expect(result.outcome).toMatchObject({ type: "COMPLETED" });
    expect(result.bundles[0].facts[0]).toMatchObject({ kind: "ELEMENT_OBSERVATION", value: { expectationId: "heading", resolution: "AMBIGUOUS", count: 2 } });
    expect(evaluation.unresolvedChecks).toMatchObject([{ expectationId: "heading" }]);
  });

  it("models missing targets explicitly without creating an early deterministic failure", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser({ elementCount: 0 });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-missing", browserType: fixture.browserType });
    const evaluation = evaluateDeterministically({ qaIr: input, bundle: result.bundles[0], manifest: result.manifest, readBlob: result.readBlob });

    expect(result.bundles[0].facts[0]).toMatchObject({ kind: "ELEMENT_OBSERVATION", value: { expectationId: "heading", resolution: "MISSING" } });
    expect(evaluation.unresolvedChecks).toMatchObject([{ expectationId: "heading" }]);
  });

  it("resolves PRESENT from a uniquely found target", async () => {
    const input = qaIr();
    input.suites[0].scenarios[0].expectations[0].kind = "PRESENT";
    delete input.suites[0].scenarios[0].expectations[0].expected;
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser();
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-present", browserType: fixture.browserType });
    const evaluation = evaluateDeterministically({ qaIr: input, bundle: result.bundles[0], manifest: result.manifest, readBlob: result.readBlob });

    expect(evaluation.resolvedChecks).toMatchObject([{ expectationId: "heading", status: "MATCHED" }]);
  });

  it("keeps truncated or redacted text mismatches unresolved", async () => {
    for (const candidate of [
      { text: "x".repeat(5_000), expected: "needle", secrets: [] },
      { text: "SESSION-SECRET", expected: "SESSION-SECRET", secrets: ["SESSION-SECRET"] },
      { text: "SESSION-SECRET", expected: "[REDACTED]", secrets: ["SESSION-SECRET"] },
      { text: `${"A".repeat(4_090)}TOP-SECRET-1234567890`, expected: "TOP-SECRET-1234567890", secrets: ["TOP-SECRET-1234567890"] },
    ]) {
      const input = qaIr();
      input.suites[0].scenarios[0].expectations[0].expected.value = candidate.expected;
      const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
      const fixture = fakeBrowser({ text: candidate.text });
      const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: `run-partial-${candidate.secrets.length}`, browserType: fixture.browserType, secrets: candidate.secrets });
      const evaluation = evaluateDeterministically({ qaIr: input, bundle: result.bundles[0], manifest: result.manifest, readBlob: result.readBlob });

      expect(result.outcome).toMatchObject({ type: "COMPLETED" });
      expect(evaluation.unresolvedChecks).toMatchObject([{ expectationId: "heading" }]);
      expect(JSON.stringify(result)).not.toContain("SESSION-SECRET");
      expect(JSON.stringify(result)).not.toContain("TOP-SE");
    }
  });

  it("snapshots mutable QA IR before browser execution", async () => {
    const input = qaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    let reads = 0;
    Object.defineProperty(input.suites[0].scenarios[0].expectations[0].target, "testId", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "heading" : "tampered";
      },
    });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-snapshot", browserType: fakeBrowser().browserType });

    expect(result.outcome).toMatchObject({ type: "COMPLETED" });
    expect(reads).toBe(1);
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

  it("executes semantic clicks and seals a redacted ACTION_LOG", async () => {
    const input = clickableQaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser();
    const result = await executeWithPlaywright({
      qaIr: input,
      plan,
      baseUrl: "https://example.test",
      runId: "run-click",
      browserType: fixture.browserType,
      secrets: ["open-menu"],
      now: () => "2026-07-25T00:00:00.000Z",
    });

    expect(result.outcome).toMatchObject({ type: "COMPLETED" });
    expect(fixture.calls).toContainEqual(["click:testId", "open-menu"]);
    const action = result.bundles[0].artifacts.find(artifact => artifact.type === "ACTION_LOG");
    expect(action).toBeDefined();
    expect(result.readBlob(action.storageRef).toString()).toContain("[REDACTED]");
    expect(result.readBlob(action.storageRef).toString()).not.toContain("open-menu");
    expect(verifyStoredEvidence({ bundle: result.bundles[0], manifest: result.manifest, readBlob: result.readBlob }).bundle).toEqual(result.bundles[0]);
  });

  it("allows a same-origin GET started by a safe click and records it in the ACTION_LOG", async () => {
    const input = clickableQaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const readRoute = { request: () => ({ method: () => "GET", url: () => "https://example.test/api/subscription-history" }), abort: vi.fn(), continue: vi.fn() };
    const fixture = fakeBrowser({ onClick: async ({ routeHandler }) => routeHandler(readRoute) });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-click-read", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ type: "COMPLETED" });
    expect(readRoute.continue).toHaveBeenCalledOnce();
    expect(readRoute.abort).not.toHaveBeenCalled();
    const action = result.bundles[0].artifacts.find(artifact => artifact.type === "ACTION_LOG");
    expect(action).toBeDefined();
    const log = JSON.parse(result.readBlob(action.storageRef).toString());
    expect(log.allowedRequests).toContainEqual({ method: "GET", origin: "https://example.test", path: "/api/subscription-history" });
  });

  it("starts a fresh browser session for a scenario after a click checkpoint", async () => {
    const input = clickableQaIr();
    const first = input.suites[0].scenarios[0];
    input.suites[0].scenarios.push({
      ...structuredClone(first),
      id: "scenario-two",
      steps: first.steps.map(step => ({
        ...structuredClone(step),
        id: `${step.id}-two`,
        ...(step.kind === "CHECKPOINT" ? { checkpointId: "loaded-two" } : {}),
      })),
    });
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser();
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-click-two", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ type: "COMPLETED" });
    expect(result.bundles).toHaveLength(2);
    expect(fixture.calls.filter(([name]) => name === "launch")).toHaveLength(2);
    expect(fixture.calls.filter(([name]) => name === "close")).toHaveLength(2);
  });

  it("fails a click that attempts a mutating request instead of logging success", async () => {
    const input = clickableQaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser({
      onClick: async ({ routeHandler }) => routeHandler({
        request: () => ({ method: () => "POST", url: () => "https://example.test/api/update" }),
        abort: vi.fn(),
        continue: vi.fn(),
      }),
    });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-click-post", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ type: "ERROR", code: "POLICY_VIOLATION" });
    expect(result.bundles).toHaveLength(0);
    expect(fixture.calls.at(-1)).toEqual(["close"]);
  });

  it("fails any network request started by a click", async () => {
    const input = clickableQaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser({
      onClick: async ({ routeHandler }) => routeHandler({
        request: () => ({ method: () => "GET", url: () => "https://attacker.test/collect" }),
        abort: vi.fn(),
        continue: vi.fn(),
      }),
    });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-click-network", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ type: "ERROR", code: "POLICY_VIOLATION" });
    expect(result.bundles).toHaveLength(0);
  });

  it("fails a WebSocket started by a click", async () => {
    const input = clickableQaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const socket = { close: vi.fn() };
    const fixture = fakeBrowser({ onClick: ({ webSocketHandler }) => webSocketHandler(socket) });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-click-websocket", browserType: fixture.browserType });

    expect(socket.close).toHaveBeenCalledOnce();
    expect(result.outcome).toMatchObject({ type: "ERROR", code: "POLICY_VIOLATION" });
    expect(result.bundles).toHaveLength(0);
  });

  it("withholds already sealed evidence when a delayed click request is detected during cleanup", async () => {
    const input = clickableQaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser({
      closeDelayMs: 5,
      onClick: ({ routeHandler }) => {
        setTimeout(() => void routeHandler({
          request: () => ({ method: () => "POST", url: () => "https://example.test/delayed" }),
          abort: vi.fn(),
          continue: vi.fn(),
        }), 0);
      },
    });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-click-delayed", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ type: "ERROR", code: "POLICY_VIOLATION" });
    expect(result.bundles).toHaveLength(0);
    expect(result.manifest).toBeUndefined();
    expect(result.readBlob("anything")).toBeUndefined();
  });

  it("returns no sealed evidence and closes the browser when a click fails", async () => {
    const input = clickableQaIr();
    const plan = createExecutionPlan({ qaIr: input, providerCapabilities: playwrightExecutionCapabilities() });
    const fixture = fakeBrowser({ clickError: new Error("missing secret target") });
    const result = await executeWithPlaywright({ qaIr: input, plan, baseUrl: "https://example.test", runId: "run-click-failed", browserType: fixture.browserType });

    expect(result.outcome).toMatchObject({ type: "ERROR", code: "UNKNOWN_RUNTIME_ERROR", message: "Execution provider failed" });
    expect(result.bundles).toHaveLength(0);
    expect(fixture.calls.at(-1)).toEqual(["close"]);
    expect(JSON.stringify(result)).not.toContain("missing secret target");
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
