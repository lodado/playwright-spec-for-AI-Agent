import { describe, expect, it, vi } from "vitest";
import {
  EXECUTION_ACTION_PROPOSAL_VERSION,
  EXECUTION_AGENT_INPUT_VERSION,
  validateContract,
} from "../../contracts/index.mjs";
import { createInMemoryEvidenceStore } from "../../evidence/index.mjs";
import { judgeEvidence } from "../../judge/index.mjs";
import * as provider from "../index.mjs";

const { openPlaywrightBrowserToolGateway, playwrightBrowserToolCapabilities, runAdaptiveWithPlaywright } = provider;

function executionAgentInput() {
  return {
    schemaVersion: EXECUTION_AGENT_INPUT_VERSION,
    runId: "run-gateway",
    scenarioId: "scenario-gateway",
    goal: { id: "goal-settings", description: "Open the settings dialog." },
    milestones: [
      {
        id: "open-settings",
        class: "REQUIRED_EXACT_ACTION",
        status: "PENDING",
        description: "Click the observed Settings entry.",
        requiredAction: "click_observed_element",
        target: { testId: "settings" },
      },
      {
        id: "dialog-visible",
        class: "REQUIRED_SEMANTIC_MILESTONE",
        status: "PENDING",
        description: "Settings dialog is visible.",
      },
    ],
    currentMilestoneId: "open-settings",
    currentPage: { pageId: "page-1", domGeneration: 1, url: "https://example.test/dashboard" },
    recentObservations: [],
    capabilityLease: {
      leaseId: "lease-gateway",
      actions: ["get_current_url", "observe_dom", "observe_aria", "click_observed_element", "press_key"],
      allowedOrigins: ["https://example.test"],
    },
    remainingBudget: { actions: 6, turns: 6, timeMs: 30_000, tokens: 8_000 },
  };
}

function proposal(input, action, parameters = {}) {
  return {
    schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION,
    proposalId: `proposal-${action}-${Math.random().toString(16).slice(2)}`,
    runId: input.runId,
    scenarioId: input.scenarioId,
    milestoneId: input.currentMilestoneId,
    leaseId: input.capabilityLease.leaseId,
    action,
    parameters,
  };
}

function fakeBrowser({
  url = "https://example.test/dashboard",
  dom = '<main><button data-testid="settings" role="button">Settings</button></main>',
  aria = '- button "Settings"',
  visibleText = "Settings dashboard visible text",
  elementText = "Settings",
  protectedElement = false,
  requestAfterClick,
  routeNavigationRequests = false,
  historyMissing = false,
} = {}) {
  const calls = [];
  const screenshots = [];
  let pageUrl = url;
  let routeHandler;

  const htmlLocator = {
    evaluate: vi.fn(async (evaluate, maxChars) => {
      const value = typeof dom === "function" ? await dom(evaluate, maxChars) : dom;
      return typeof value === "string" ? { dom: value, sensitiveValues: [], sensitiveValuesOverflow: false } : value;
    }),
  };
  const bodyLocator = {
    ariaSnapshot: vi.fn(async () => aria),
    evaluate: vi.fn(async () => visibleText),
  };
  const candidate = {
    isVisible: vi.fn(async () => true),
    evaluate: vi.fn(async () => ({
      tag: "button",
      role: "button",
      accessibleName: protectedElement ? "[REDACTED]" : elementText,
      text: protectedElement ? "[REDACTED]" : elementText,
      testId: "settings",
      protected: protectedElement,
      anchor: false,
      form: false,
      editable: false,
      disabled: false,
    })),
    click: vi.fn(async () => {
      calls.push(["click", "settings"]);
      if (requestAfterClick !== undefined) {
        await routeHandler({
          request: () => ({ method: () => requestAfterClick, url: () => "https://api.example.test/state" }),
          abort: vi.fn(async () => calls.push(["abort", "blockedbyclient"])),
          continue: vi.fn(async () => calls.push(["continue"])),
        });
      }
    }),
    hover: vi.fn(async () => calls.push(["hover", "settings"])),
    waitForElementState: vi.fn(async (state) => calls.push(["wait", state])),
  };
  candidate.elementHandle = vi.fn(async () => candidate);
  const candidateList = {
    count: vi.fn(async () => 1),
    nth: vi.fn(() => candidate),
  };
  const mainFrame = {};
  mainFrame.url = () => pageUrl;
  const page = {
    goto: vi.fn(async (target) => {
      pageUrl = target;
      calls.push(["goto", target]);
      if (routeNavigationRequests) {
        await routeHandler({
          request: () => ({
            method: () => "GET",
            url: () => target,
            isNavigationRequest: () => true,
            resourceType: () => "document",
            frame: () => mainFrame,
          }),
          abort: vi.fn(async () => calls.push(["abort", "blockedbyclient"])),
          continue: vi.fn(async () => calls.push(["continue"])),
        });
      }
    }),
    goBack: vi.fn(async () => {
      if (historyMissing) return null;
      pageUrl = "https://example.test/previous";
      calls.push(["go-back"]);
      return {};
    }),
    reload: vi.fn(async () => {
      calls.push(["reload", pageUrl]);
      return {};
    }),
    mainFrame: vi.fn(() => mainFrame),
    url: vi.fn(() => pageUrl),
    viewportSize: vi.fn(() => ({ width: 1280, height: 720 })),
    locator: vi.fn((selector) => {
      if (selector === "html") return htmlLocator;
      if (selector === "body") return bodyLocator;
      return candidateList;
    }),
    screenshot: vi.fn(async () => {
      screenshots.push("screenshot");
      return Buffer.from("unexpected screenshot");
    }),
    keyboard: {
      press: vi.fn(async (key) => calls.push(["press", key])),
    },
    mouse: {
      wheel: vi.fn(async (deltaX, deltaY) => calls.push(["scroll", deltaX, deltaY])),
    },
    waitForFunction: vi.fn(async () => calls.push(["wait-for-function"])),
  };
  const context = {
    route: vi.fn(async (_pattern, handler) => {
      routeHandler = handler;
    }),
    routeWebSocket: vi.fn(async () => undefined),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => calls.push(["close-context"])),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => calls.push(["close-browser"])),
  };
  return {
    browserType: { launch: vi.fn(async () => browser) },
    browser,
    context,
    calls,
    screenshots,
    candidate,
  };
}

function credentialBearingDom() {
  const inputAttributes = new Map([["name", "password"], ["value", "unknown-password"], ["data-session-token", "unknown-session"]]);
  const metaAttributes = new Map([["name", "api-key"], ["content", "unknown-api-key"]]);
  const recoveryAttributes = new Map([["id", "recovery-code"]]);
  const rootAttributes = new Map([["manifest", "https://example.test/app?code=root-secret"]]);
  const linkAttributes = new Map([
    ["href", "https://example.test/download?X-Amz-Signature=short-secret#fragment"],
    ["ping", "https://example.test/audit?code=ping-secret"],
    ["xlink:href", "/download?code=xlink-secret"],
    ["imagesrcset", "/image?code=imagesrcset-secret 1x"],
    ["attributionsrc", "/attribution?code=attribution-secret"],
  ]);
  const node = (tagName, attributes, text = "") => ({
    tagName,
    textContent: text,
    value: attributes.get("value") ?? "",
    get attributes() { return [...attributes.keys()].map((name) => ({ name })); },
    getAttribute: (name) => attributes.get(name) ?? null,
    removeAttribute: (name) => attributes.delete(name),
  });
  const input = node("INPUT", inputAttributes);
  const meta = node("META", metaAttributes);
  const recovery = node("DIV", recoveryAttributes, "ABCD-1234");
  const link = node("A", linkAttributes, "Download");
  const descendants = (selector) => {
      if (selector === "input, textarea, select") return [input];
      if (selector === "*") return [input, meta, recovery, link];
      return [];
  };
  const clone = node("HTML", rootAttributes);
  clone.querySelectorAll = descendants;
  Object.defineProperty(clone, "outerHTML", {
    get() {
      return `<html ${[...rootAttributes].map(([key, value]) => `${key}="${value}"`).join(" ")}><input ${[...inputAttributes].map(([key, value]) => `${key}="${value}"`).join(" ")}><meta ${[...metaAttributes].map(([key, value]) => `${key}="${value}"`).join(" ")}><div id="recovery-code">${recovery.textContent}</div><a ${[...linkAttributes].map(([key, value]) => `${key}="${value}"`).join(" ")}>Download</a></html>`;
    },
  });
  const root = node("HTML", rootAttributes);
  root.cloneNode = () => clone;
  root.querySelectorAll = descendants;
  return root;
}

async function openGateway({ input = executionAgentInput(), browserType = fakeBrowser().browserType, clock } = {}) {
  expect(typeof openPlaywrightBrowserToolGateway).toBe("function");
  return openPlaywrightBrowserToolGateway({
    input,
    browserType,
    secrets: ["SESSION-SECRET"],
    ...(clock === undefined ? {} : { clock }),
    now: () => "2026-07-26T00:00:00.000Z",
  });
}

async function artifactText(gateway, bundle) {
  const blobs = await Promise.all(
    bundle.artifacts.map(async (artifact) => {
      const blob = await gateway.readBlob(artifact.storageRef);
      return Buffer.isBuffer(blob) ? blob.toString("utf8") : String(blob);
    }),
  );
  return blobs.join("\n");
}

describe("Playwright browser tool gateway", () => {
  it("closes the browser when the adaptive proposer fails", async () => {
    const fixture = fakeBrowser();

    await expect(runAdaptiveWithPlaywright({
      input: executionAgentInput(),
      browserType: fixture.browserType,
      proposeAction: async () => { throw new Error("proposer failed"); },
    })).rejects.toThrow(/proposer failed/i);

    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
  });

  it("bounds adaptive proposer latency by the remaining run budget", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const fixture = fakeBrowser();
      const input = executionAgentInput();
      input.remainingBudget.timeMs = 1_000;
      let proposerCalled = false;
      const running = runAdaptiveWithPlaywright({
        input,
        browserType: fixture.browserType,
        proposeAction: async () => {
          proposerCalled = true;
          return new Promise(() => undefined);
        },
      });
      const rejection = expect(running).rejects.toThrow(/time budget/i);
      await vi.waitFor(() => expect(proposerCalled).toBe(true));

      await vi.advanceTimersByTimeAsync(1_000);

      await rejection;
      expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes browser execution before the independent Judge returns a verdict", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    input.milestones = [{ id: "settings-visible", class: "REQUIRED_SEMANTIC_MILESTONE", status: "PENDING", description: "Settings is visible.", target: { testId: "settings" } }];
    input.currentMilestoneId = "settings-visible";

    const execution = await runAdaptiveWithPlaywright({
      input,
      browserType: fixture.browserType,
      proposeAction: async (agentInput) => ({ proposal: proposal(agentInput, "observe_dom"), tokensUsed: 1 }),
    });

    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    const judgment = await judgeEvidence({
      qaIr: urlQaIr(),
      bundle: execution.bundles.at(-1),
      manifest: execution.manifest,
      readBlob: execution.readBlob,
    });
    expect(judgment.verdict).toBe("PASS");
    expect(judgment.judge.provider).toBe("deterministic");
  });

  it("returns current URL evidence without taking screenshots", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    const gateway = await openGateway({ input, browserType: fixture.browserType });

    const agentInput = gateway.agentInput();
    expect(agentInput.currentPage.url).toBe("https://example.test/dashboard");
    expect(agentInput.capabilityLease.actions).toEqual(
      expect.arrayContaining(["get_current_url", "observe_dom", "observe_aria", "click_observed_element", "press_key"]),
    );
    expect(gateway.capabilities.actions).toContain("navigate");
    expect(gateway.capabilities.actions).toEqual(expect.arrayContaining(["go_back", "reload_page", "hover_observed_element", "scroll_view", "wait_for_element_state"]));
    expect(agentInput.capabilityLease.actions).not.toContain("observe_screenshot");

    const execution = await gateway.execute({ proposal: proposal(agentInput, "get_current_url"), tokensUsed: 11 });
    validateContract("ExecutionActionResult", execution.result, { input: agentInput });

    expect(execution.result).toMatchObject({
      accepted: true,
      policyReason: "ACCEPTED",
      page: { url: "https://example.test/dashboard" },
    });
    expect(await artifactText(gateway, execution.bundle)).toContain("https://example.test/dashboard");
    expect(fixture.screenshots).toEqual([]);

    await gateway.close();
  });

  it("navigates within the capability origin and invalidates the previous page identity", async () => {
    const fixture = fakeBrowser({ routeNavigationRequests: true });
    const input = executionAgentInput();
    input.milestones[0].status = "COMPLETED";
    input.currentMilestoneId = "dialog-visible";
    input.capabilityLease.actions.push("navigate");
    const gateway = await openGateway({ input, browserType: fixture.browserType });

    const execution = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "navigate", { url: "https://example.test/settings" }),
      tokensUsed: 2,
    });

    expect(execution.result).toMatchObject({
      accepted: true,
      page: { url: "https://example.test/settings", domGeneration: 1 },
    });
    expect(execution.result.page.pageId).not.toBe("page-1");
    expect(fixture.calls).toContainEqual(["goto", "https://example.test/settings"]);
    expect(fixture.calls.filter(([action]) => action === "continue")).toHaveLength(2);
    expect(gateway.agentInput().recentObservations).toEqual([]);
    await gateway.close();
  });

  it("rejects cross-origin navigation before Playwright executes it", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    input.milestones[0].status = "COMPLETED";
    input.currentMilestoneId = "dialog-visible";
    input.capabilityLease.actions.push("navigate");
    const gateway = await openGateway({ input, browserType: fixture.browserType });

    await expect(
      gateway.execute({
        proposal: proposal(gateway.agentInput(), "navigate", { url: "https://outside.test/settings" }),
        tokensUsed: 2,
      }),
    ).rejects.toThrow(/origin/i);

    expect(fixture.calls.filter(([action]) => action === "goto")).toEqual([
      ["goto", "https://example.test/dashboard"],
    ]);
    await gateway.close();
  });

  it("goes back and reloads before interaction with fresh page identities", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    input.milestones[0].status = "COMPLETED";
    input.currentMilestoneId = "dialog-visible";
    input.capabilityLease.actions.push("go_back", "reload_page");
    const gateway = await openGateway({ input, browserType: fixture.browserType });

    const backed = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "go_back"),
      tokensUsed: 1,
    });
    const reloaded = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "reload_page"),
      tokensUsed: 1,
    });

    expect(backed.result.page.url).toBe("https://example.test/previous");
    expect(reloaded.result.page.pageId).not.toBe(backed.result.page.pageId);
    expect(fixture.calls).toContainEqual(["go-back"]);
    expect(fixture.calls).toContainEqual(["reload", "https://example.test/previous"]);
    await gateway.close();
  });

  it("fails closed when browser history has no previous page", async () => {
    const fixture = fakeBrowser({ historyMissing: true });
    const input = executionAgentInput();
    input.milestones[0].status = "COMPLETED";
    input.currentMilestoneId = "dialog-visible";
    input.capabilityLease.actions.push("go_back");
    const gateway = await openGateway({ input, browserType: fixture.browserType });

    await expect(
      gateway.execute({ proposal: proposal(gateway.agentInput(), "go_back"), tokensUsed: 1 }),
    ).rejects.toThrow(/no previous page/i);
    await expect(
      gateway.execute({ proposal: proposal(gateway.agentInput(), "get_current_url"), tokensUsed: 1 }),
    ).rejects.toThrow(/closed/i);
  });

  it("rejects navigation after an interaction", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    input.capabilityLease.actions.push("navigate", "go_back", "reload_page");
    const gateway = await openGateway({ input, browserType: fixture.browserType });
    const observed = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "observe_dom"),
      tokensUsed: 1,
    });
    const element = observed.observation.elements[0];
    await gateway.execute({
      proposal: proposal(gateway.agentInput(), "click_observed_element", {
        observationId: observed.observation.observationId,
        elementId: element.elementId,
      }),
      tokensUsed: 1,
    });

    for (const [action, parameters] of [
      ["navigate", { url: "https://example.test/settings" }],
      ["go_back", {}],
      ["reload_page", {}],
    ]) {
      await expect(
        gateway.execute({ proposal: proposal(gateway.agentInput(), action, parameters), tokensUsed: 1 }),
      ).rejects.toThrow(/denied after an interaction/i);
    }

    expect(fixture.calls.filter(([action]) => action === "goto")).toEqual([
      ["goto", "https://example.test/dashboard"],
    ]);
    expect(fixture.calls.filter(([action]) => action === "go-back" || action === "reload")).toEqual([]);
    await gateway.close();
  });

  it("observes DOM as opaque actionable elements", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    const gateway = await openGateway({ input, browserType: fixture.browserType });
    const agentInput = gateway.agentInput();

    const execution = await gateway.execute({ proposal: proposal(agentInput, "observe_dom"), tokensUsed: 3 });
    const observed = execution.observation.elements[0];

    expect(execution.result.accepted).toBe(true);
    expect(observed).toMatchObject({
      milestoneIds: ["open-settings"],
      allowedActions: expect.arrayContaining(["click_observed_element"]),
      text: "Settings",
    });
    expect(observed.allowedActions).toEqual(["click_observed_element"]);
    expect(observed.elementId).not.toContain("settings");
    expect(gateway.agentInput().recentObservations[0].observationId).toBe(execution.observation.observationId);
    expect(fixture.screenshots).toEqual([]);

    await gateway.close();
  });

  it("observes ARIA as opaque actionable elements", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    const gateway = await openGateway({ input, browserType: fixture.browserType });
    const agentInput = gateway.agentInput();

    const execution = await gateway.execute({ proposal: proposal(agentInput, "observe_aria"), tokensUsed: 4 });
    const observed = execution.observation.elements[0];

    expect(execution.result.accepted).toBe(true);
    expect(observed).toMatchObject({
      role: "button",
      accessibleName: "Settings",
      allowedActions: expect.arrayContaining(["click_observed_element"]),
    });
    expect(observed.elementId).not.toContain("settings");
    expect(fixture.screenshots).toEqual([]);

    await gateway.close();
  });

  it("clicks the observed element and records pre action and post evidence", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    const gateway = await openGateway({ input, browserType: fixture.browserType });
    const agentInput = gateway.agentInput();

    const observedExecution = await gateway.execute({ proposal: proposal(agentInput, "observe_dom"), tokensUsed: 3 });
    const observedInput = gateway.agentInput();
    const observation = observedExecution.observation;
    const element = observation.elements[0];
    const execution = await gateway.execute({
      proposal: proposal(observedInput, "click_observed_element", {
        observationId: observation.observationId,
        elementId: element.elementId,
      }),
      tokensUsed: 9,
    });

    validateContract("ExecutionActionResult", execution.result, { input: observedInput });
    expect(execution.result.accepted).toBe(true);
    expect(fixture.candidate.elementHandle).toHaveBeenCalledTimes(1);
    expect(fixture.calls).toContainEqual(["click", "settings"]);
    expect(await artifactText(gateway, execution.bundle)).toEqual(expect.stringMatching(/before|action|after/i));
    expect(gateway.agentInput()).toMatchObject({
      currentMilestoneId: "dialog-visible",
      milestones: [
        { id: "open-settings", status: "COMPLETED" },
        { id: "dialog-visible", status: "PENDING" },
      ],
      recentObservations: [],
    });
    expect(fixture.screenshots).toEqual([]);

    await gateway.close();
  });

  it("audits a safe recovery click without satisfying an unrelated exact milestone", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    input.milestones[0].target = { testId: "required-settings" };
    input.milestones.push({ id: "settings-recovery", class: "OPTIONAL_HINT", status: "PENDING", description: "Use Settings as a declared recovery target.", target: { testId: "settings" } });
    const gateway = await openGateway({ input, browserType: fixture.browserType });
    const observed = await gateway.execute({ proposal: proposal(gateway.agentInput(), "observe_dom"), tokensUsed: 1 });
    const element = observed.observation.elements[0];

    expect(element.milestoneIds).toEqual(["settings-recovery"]);
    await gateway.execute({
      proposal: proposal(gateway.agentInput(), "click_observed_element", { observationId: observed.observation.observationId, elementId: element.elementId }),
      tokensUsed: 1,
    });

    expect(fixture.calls).toContainEqual(["click", "settings"]);
    expect(gateway.agentInput().currentMilestoneId).toBe("open-settings");
    expect(gateway.agentInput().milestones[0]).toMatchObject({ id: "open-settings", status: "PENDING" });
    await gateway.close();
  });

  it("returns a non-verdict outcome when the final semantic milestone is observed", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    input.milestones = [{
      id: "settings-visible",
      class: "REQUIRED_SEMANTIC_MILESTONE",
      status: "PENDING",
      description: "Settings entry is visible.",
      target: { testId: "settings" },
    }];
    input.currentMilestoneId = "settings-visible";
    const gateway = await openGateway({ input, browserType: fixture.browserType });

    const execution = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "observe_dom"),
      tokensUsed: 1,
    });

    expect(execution.outcome).toEqual({
      schemaVersion: "execution-agent-outcome/0.1",
      runId: input.runId,
      scenarioId: input.scenarioId,
      type: "COMPLETED",
      completedMilestoneIds: ["settings-visible"],
    });
    expect(execution.outcome).not.toHaveProperty("verdict");
    expect(() => gateway.agentInput()).toThrow(/complete/i);
    await gateway.close();
  });

  it("seals full page evidence and returns a BLOCKED outcome for report_blocked", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    input.milestones = [{
      id: "settings-visible",
      class: "REQUIRED_SEMANTIC_MILESTONE",
      status: "PENDING",
      description: "Settings entry is visible.",
      target: { testId: "settings" },
    }];
    input.currentMilestoneId = "settings-visible";
    input.capabilityLease.actions.push("report_blocked");
    const gateway = await openGateway({ input, browserType: fixture.browserType });

    const execution = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "report_blocked", { milestoneId: "settings-visible", reason: "The settings entry never appears." }),
      tokensUsed: 1,
    });

    expect(execution.result.accepted).toBe(true);
    expect(execution.bundle.artifacts.map((artifact) => artifact.type)).toEqual(expect.arrayContaining(["VISIBLE_TEXT", "ARIA_SNAPSHOT"]));
    expect(execution.outcome).toMatchObject({
      type: "BLOCKED",
      completedMilestoneIds: [],
      reason: expect.stringContaining("The settings entry never appears."),
    });
    expect(execution.outcome).not.toHaveProperty("verdict");
    expect(await artifactText(gateway, execution.bundle)).toContain("Settings dashboard visible text");
    expect(() => gateway.agentInput()).toThrow(/complete/i);
    await gateway.close();
  });

  it("hovers a safe observed element and invalidates the observation", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    input.milestones[0].requiredAction = "hover_observed_element";
    input.capabilityLease.actions.push("hover_observed_element");
    const gateway = await openGateway({ input, browserType: fixture.browserType });
    const observed = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "observe_dom"),
      tokensUsed: 1,
    });
    const element = observed.observation.elements[0];

    const execution = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "hover_observed_element", {
        observationId: observed.observation.observationId,
        elementId: element.elementId,
      }),
      tokensUsed: 1,
    });

    expect(element.allowedActions).toContain("hover_observed_element");
    expect(execution.result.page.domGeneration).toBe(2);
    expect(fixture.calls).toContainEqual(["hover", "settings"]);
    expect(gateway.agentInput().recentObservations).toEqual([]);
    await gateway.close();
  });

  it("scrolls by bounded deltas and invalidates prior DOM state", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    input.capabilityLease.actions.push("scroll_view");
    const gateway = await openGateway({ input, browserType: fixture.browserType });

    const execution = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "scroll_view", { deltaX: 0, deltaY: 640 }),
      tokensUsed: 1,
    });

    expect(execution.result.page.domGeneration).toBe(2);
    expect(fixture.calls).toContainEqual(["scroll", 0, 640]);
    await gateway.close();
  });

  it("waits for a bounded observed element state", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    input.capabilityLease.actions.push("wait_for_element_state");
    const gateway = await openGateway({ input, browserType: fixture.browserType });
    const observed = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "observe_dom"),
      tokensUsed: 1,
    });
    const element = observed.observation.elements[0];

    const execution = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "wait_for_element_state", {
        observationId: observed.observation.observationId,
        elementId: element.elementId,
        state: "visible",
        timeoutMs: 1_000,
      }),
      tokensUsed: 1,
    });

    expect(element.allowedActions).toContain("wait_for_element_state");
    expect(fixture.calls).toContainEqual(["wait", "visible"]);
    expect(execution.result.page.domGeneration).toBe(2);
    await gateway.close();
  });

  it("waits for an observed element to become absent", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    input.capabilityLease.actions.push("wait_for_element_state");
    const gateway = await openGateway({ input, browserType: fixture.browserType });
    const observed = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "observe_dom"),
      tokensUsed: 1,
    });
    const element = observed.observation.elements[0];

    await gateway.execute({
      proposal: proposal(gateway.agentInput(), "wait_for_element_state", {
        observationId: observed.observation.observationId,
        elementId: element.elementId,
        state: "absent",
        timeoutMs: 1_000,
      }),
      tokensUsed: 1,
    });

    expect(fixture.calls).toContainEqual(["wait-for-function"]);
    await gateway.close();
  });

  it("presses Escape through the keyboard and records evidence", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    input.milestones[0].description = "Dismiss the current overlay.";
    input.milestones[0].requiredAction = "press_key";
    const gateway = await openGateway({ input, browserType: fixture.browserType });
    const agentInput = gateway.agentInput();

    const execution = await gateway.execute({
      proposal: proposal(agentInput, "press_key", { key: "Escape" }),
      tokensUsed: 2,
    });

    validateContract("ExecutionActionResult", execution.result, { input: agentInput });
    expect(execution.result.accepted).toBe(true);
    expect(fixture.calls).toContainEqual(["press", "Escape"]);
    expect(await artifactText(gateway, execution.bundle)).toContain("Escape");
    expect(fixture.screenshots).toEqual([]);

    await gateway.close();
  });

  it("rejects stale observed elements before clicking", async () => {
    const fixture = fakeBrowser();
    const input = executionAgentInput();
    const gateway = await openGateway({ input, browserType: fixture.browserType });
    const agentInput = gateway.agentInput();

    const staleExecution = await gateway.execute({ proposal: proposal(agentInput, "observe_dom"), tokensUsed: 3 });
    const staleObservation = staleExecution.observation;
    const staleElement = staleObservation.elements[0];
    await gateway.execute({ proposal: proposal(gateway.agentInput(), "observe_aria"), tokensUsed: 3 });
    const currentInput = gateway.agentInput();

    await expect(
      gateway.execute({
        proposal: proposal(currentInput, "click_observed_element", {
          observationId: staleObservation.observationId,
          elementId: staleElement.elementId,
        }),
        tokensUsed: 1,
      }),
    ).rejects.toThrow(/observed element|stale|unavailable/i);
    expect(fixture.candidate.click).not.toHaveBeenCalled();
    expect(fixture.screenshots).toEqual([]);

    await gateway.close();
  });

  it("does not bind unsupported regex targets to a role-matching element", async () => {
    const input = executionAgentInput();
    input.milestones[0].target = {
      role: "button",
      accessibleName: { kind: "regex", value: "^Not Settings$" },
    };
    const fixture = fakeBrowser();
    const gateway = await openGateway({ input, browserType: fixture.browserType });

    const execution = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "observe_dom"),
      tokensUsed: 1,
    });

    expect(execution.observation.elements[0].milestoneIds).toEqual([]);
    await gateway.close();
  });

  it("rejects concurrent actions instead of racing browser and budget state", async () => {
    let releaseCapture;
    let captureCount = 0;
    const fixture = fakeBrowser({
      dom: () => {
        captureCount += 1;
        if (captureCount === 1) return new Promise((resolve) => { releaseCapture = resolve; });
        return '<main><button data-testid="settings">Settings</button></main>';
      },
    });
    const gateway = await openGateway({ browserType: fixture.browserType });
    const first = gateway.execute({ proposal: proposal(gateway.agentInput(), "get_current_url"), tokensUsed: 1 });
    await vi.waitFor(() => expect(releaseCapture).toBeTypeOf("function"));

    await expect(
      gateway.execute({ proposal: proposal(gateway.agentInput(), "get_current_url"), tokensUsed: 1 }),
    ).rejects.toThrow(/in progress/i);

    releaseCapture('<main><button data-testid="settings">Settings</button></main>');
    await expect(first).resolves.toMatchObject({ result: { accepted: true } });
    await gateway.close();
  });

  it("fails closed when browser evidence capture exceeds the time budget", async () => {
    let currentTime = 0;
    const fixture = fakeBrowser({
      dom: () => {
        currentTime = 30_001;
        return '<main><button data-testid="settings">Settings</button></main>';
      },
    });
    const gateway = await openGateway({ browserType: fixture.browserType, clock: () => currentTime });

    await expect(
      gateway.execute({ proposal: proposal(gateway.agentInput(), "get_current_url"), tokensUsed: 1 }),
    ).rejects.toThrow(/time budget/i);
    await expect(
      gateway.execute({ proposal: proposal(executionAgentInput(), "get_current_url"), tokensUsed: 1 }),
    ).rejects.toThrow(/closed/i);
  });

  it("fails closed instead of truncating discovered sensitive values", async () => {
    const fixture = fakeBrowser({
      dom: {
        dom: "<html></html>",
        sensitiveValues: Array.from({ length: 128 }, (_, index) => `private-${index}`),
        sensitiveValuesOverflow: true,
      },
    });
    const gateway = await openGateway({ browserType: fixture.browserType });

    await expect(
      gateway.execute({ proposal: proposal(gateway.agentInput(), "get_current_url"), tokensUsed: 1 }),
    ).rejects.toThrow(/sanitized DOM evidence/i);
  });

  it("bounds browser cleanup when close never settles", async () => {
    vi.useFakeTimers();
    try {
      const fixture = fakeBrowser();
      fixture.browser.close.mockImplementation(() => new Promise(() => undefined));
      const gateway = await openGateway({ browserType: fixture.browserType });
      const closing = gateway.close();

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(closing).resolves.toBeUndefined();
      expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a browser that launches after the execution deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const input = executionAgentInput();
      input.remainingBudget.timeMs = 1;
      let resolveLaunch;
      const fixture = fakeBrowser();
      const browserType = {
        launch: vi.fn(() => new Promise((resolve) => { resolveLaunch = resolve; })),
      };
      const opening = openGateway({ input, browserType });
      const rejection = expect(opening).rejects.toThrow(/time budget/i);
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      resolveLaunch(fixture.browser);
      await vi.advanceTimersByTimeAsync(0);

      expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows every page API request triggered by a click", async () => {
    const fixture = fakeBrowser({ requestAfterClick: "POST" });
    const gateway = await openGateway({ browserType: fixture.browserType });
    const observed = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "observe_dom"),
      tokensUsed: 1,
    });
    const element = observed.observation.elements[0];

    await expect(gateway.execute({
      proposal: proposal(gateway.agentInput(), "click_observed_element", {
        observationId: observed.observation.observationId,
        elementId: element.elementId,
      }),
      tokensUsed: 1,
    })).resolves.toMatchObject({ result: { accepted: true } });

    expect(fixture.calls).toContainEqual(["continue"]);
    expect(fixture.calls).not.toContainEqual(["abort", "blockedbyclient"]);
    expect(fixture.context.routeWebSocket).not.toHaveBeenCalled();
    expect(fixture.screenshots).toEqual([]);
  });

  it("withholds protected element text and actions from observations", async () => {
    const fixture = fakeBrowser({ elementText: "ABCD-1234", protectedElement: true });
    const gateway = await openGateway({ browserType: fixture.browserType });

    const execution = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "observe_dom"),
      tokensUsed: 1,
    });

    expect(execution.observation.elements[0]).toMatchObject({
      accessibleName: "[REDACTED]",
      text: "[REDACTED]",
      milestoneIds: [],
      allowedActions: [],
    });
    expect(JSON.stringify(execution)).not.toContain("ABCD-1234");
    await gateway.close();
  });

  it("withholds actions when an observation contains a discovered form value", async () => {
    const fixture = fakeBrowser({
      dom: (evaluate, maxChars) => evaluate(credentialBearingDom(), maxChars),
      elementText: "Copy unknown-password",
    });
    const gateway = await openGateway({ browserType: fixture.browserType });

    const execution = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "observe_dom"),
      tokensUsed: 1,
    });

    expect(execution.observation.elements[0]).toMatchObject({
      accessibleName: "Copy [REDACTED]",
      text: "Copy [REDACTED]",
      milestoneIds: [],
      allowedActions: [],
    });
    await gateway.close();
  });

  it("removes credential-bearing DOM attributes before evidence storage", async () => {
    const fixture = fakeBrowser({
      dom: (evaluate, maxChars) => evaluate(credentialBearingDom(), maxChars),
      aria: '- textbox: unknown-password\n- text: ABCD-1234\n- link "Download":\n  - /url: /download?X-Amz-Signature=short-secret',
    });
    const gateway = await openGateway({ browserType: fixture.browserType });

    const execution = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "get_current_url"),
      tokensUsed: 1,
    });
    const stored = await artifactText(gateway, execution.bundle);

    expect(stored).not.toMatch(/unknown-password|unknown-session|unknown-api-key|ABCD-1234|X-Amz-Signature|short-secret|ping-secret|xlink-secret|imagesrcset-secret|attribution-secret|root-secret/);
    expect(stored).not.toMatch(/data-session-token|content="unknown-api-key"|href=|ping=|xlink:href=|imagesrcset=|attributionsrc=|manifest=/);
    await gateway.close();
  });

  it("redacts credentials from agent input, observations, and stored evidence", async () => {
    const input = executionAgentInput();
    input.goal.description = "Open SESSION-SECRET settings.";
    input.milestones[0].description = "Click SESSION-SECRET.";
    const fixture = fakeBrowser({
      dom: '<main><button data-testid="settings">SESSION-SECRET</button></main>',
      aria: '- button "SESSION-SECRET"',
      elementText: "SESSION-SECRET",
    });
    const gateway = await openGateway({ input, browserType: fixture.browserType });

    const execution = await gateway.execute({
      proposal: proposal(gateway.agentInput(), "observe_dom"),
      tokensUsed: 3,
    });

    expect(JSON.stringify(gateway.agentInput())).not.toContain("SESSION-SECRET");
    expect(JSON.stringify(execution)).not.toContain("SESSION-SECRET");
    expect(await artifactText(gateway, execution.bundle)).not.toContain("SESSION-SECRET");
    expect(execution.observation.elements[0]).toMatchObject({
      accessibleName: "[REDACTED]",
      text: "[REDACTED]",
    });
    expect(fixture.screenshots).toEqual([]);

    await gateway.close();
  });

  it("chains checkpoints from two gateway sessions into one manifest via a shared store", async () => {
    const store = createInMemoryEvidenceStore({ providerCapabilities: playwrightBrowserToolCapabilities(), producer: { name: "gateway-shared-test", version: "0.0.0" }, secrets: [] });
    const semanticInput = (scenarioId) => {
      const base = executionAgentInput();
      base.runId = "run-shared";
      base.scenarioId = scenarioId;
      base.milestones = [{ id: "observe", class: "REQUIRED_SEMANTIC_MILESTONE", status: "PENDING", description: "Observe the dashboard.", target: { testId: "settings" } }];
      base.currentMilestoneId = "observe";
      return base;
    };

    let manifest;
    const gateway1 = await openPlaywrightBrowserToolGateway({ input: semanticInput("scenario-a"), browserType: fakeBrowser().browserType, store, secrets: [], now: () => "2026-07-26T00:00:00.000Z" });
    try {
      const execution = await gateway1.execute({ proposal: proposal(gateway1.agentInput(), "observe_dom"), tokensUsed: 0 });
      manifest = execution.manifest;
      expect(manifest.checkpoints).toHaveLength(1);
    } finally {
      await gateway1.close();
    }

    const gateway2 = await openPlaywrightBrowserToolGateway({ input: semanticInput("scenario-b"), browserType: fakeBrowser().browserType, store, priorManifest: manifest, secrets: [], now: () => "2026-07-26T00:00:00.000Z" });
    try {
      const execution = await gateway2.execute({ proposal: proposal(gateway2.agentInput(), "observe_dom"), tokensUsed: 0 });
      expect(execution.manifest.runId).toBe("run-shared");
      expect(execution.manifest.checkpoints).toHaveLength(2);
    } finally {
      await gateway2.close();
    }
  });
});

function urlQaIr() {
  return {
    schemaVersion: "qa-ir/0.2",
    id: "qa-ir-gateway-judge",
    source: { adapter: "adapter-playwright", adapterVersion: "0.2.0", uri: "gateway.spec.ts" },
    suites: [{
      id: "suite-gateway",
      title: "Gateway",
      tags: [],
      scenarios: [{
        id: "scenario-gateway",
        title: "Gateway URL",
        preconditions: [],
        steps: [{ id: "checkpoint", kind: "CHECKPOINT", checkpointId: "loaded" }],
        expectations: [{ id: "url", kind: "URL", expected: { kind: "literal", value: "/dashboard" } }],
        policy: { navigation: "ALLOWED", readDom: true, readNetwork: false, click: "NONE", type: "NONE", upload: false, submit: false, destructiveMutation: false, confirmation: "DENY", secrets: "RUNTIME_INJECTED" },
        provenance: [],
      }],
      provenance: [],
    }],
  };
}
