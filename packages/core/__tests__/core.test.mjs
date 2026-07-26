import { describe, expect, it } from "vitest";
import { QA_IR_VERSION, validateContract } from "../../contracts/index.mjs";
import { createExecutionPlan, executePlan, providerCapabilities, validateExecutionPlanBinding } from "../index.mjs";

const readonlyPolicy = {
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

const provenance = [{
  path: "qa.spec.ts",
  range: { start: { line: 1, column: 1 }, end: { line: 10, column: 1 } },
  adapter: { name: "test", version: "0.1" },
  contentHash: "sha256:test",
}];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function qaIr(policy = readonlyPolicy, steps = [
  { id: "navigate", kind: "NAVIGATE", milestoneClass: "REQUIRED_SEMANTIC_MILESTONE", target: { type: "PATH", value: "/dashboard" } },
  { id: "observe", kind: "OBSERVE", requests: [{ type: "VISIBLE_TEXT" }] },
  { id: "checkpoint", kind: "CHECKPOINT", checkpointId: "loaded" },
]) {
  return {
    schemaVersion: QA_IR_VERSION,
    id: "qa-ir-core-test",
    source: { adapter: "test", adapterVersion: "0.1", uri: "qa.spec.ts", revision: "abc123" },
    suites: [{ id: "suite", title: "Suite", tags: ["readonly"], scenarios: [{ id: "scenario", title: "Scenario", preconditions: [], steps, expectations: [], policy, provenance }], provenance }],
    extensions: {},
  };
}

function plan(overrides = {}) {
  return createExecutionPlan({ qaIr: qaIr(), providerCapabilities: providerCapabilities(), ...overrides });
}

describe("core execution planner", () => {
  it("creates deterministic plans with stable nodes and graph edges", () => {
    const caps = providerCapabilities();
    const first = createExecutionPlan({ qaIr: qaIr(), providerCapabilities: caps });
    const second = createExecutionPlan({ qaIr: qaIr(), providerCapabilities: caps });

    expect(first).toEqual(second);
    expect(validateContract("ExecutionPlan", first)).toBe(first);
    expect(first.retryPolicy).toEqual({ maxAttempts: 1 });
    expect(first.timeoutPolicy).toEqual({ perNodeMs: 30000, runMs: 120000 });
    expect(first.nodes.map((node) => node.kind)).toEqual(["NAVIGATE", "OBSERVE", "CHECKPOINT"]);
    expect(first.edges).toEqual([
      { from: first.nodes[0].nodeId, to: first.nodes[1].nodeId },
      { from: first.nodes[1].nodeId, to: first.nodes[2].nodeId },
    ]);
  });

  it("binds submitted plans to the exact QA IR and provider capabilities", () => {
    const source = qaIr();
    const capabilities = providerCapabilities();
    const target = createExecutionPlan({ qaIr: source, providerCapabilities: capabilities });
    expect(validateExecutionPlanBinding({ qaIr: source, plan: target, providerCapabilities: capabilities })).toBe(target);

    const forged = structuredClone(target);
    forged.nodes[0].policy.navigation = "BLOCKED";
    expect(() => validateExecutionPlanBinding({ qaIr: source, plan: forged, providerCapabilities: capabilities })).toThrow(/does not match/);

    const changedIr = structuredClone(source);
    changedIr.suites[0].scenarios[0].title = "Changed scenario";
    expect(() => validateExecutionPlanBinding({ qaIr: changedIr, plan: target, providerCapabilities: capabilities })).toThrow(/does not match/);
  });

  it("validates retry and timeout policies", async () => {
    expect(() => plan({ retryPolicy: { maxAttempts: 0 } })).toThrow(/retryPolicy/);
    expect(() => plan({ retryPolicy: { maxAttempts: 1, extra: true } })).toThrow(/retryPolicy/);
    expect(() => plan({ timeoutPolicy: { perNodeMs: 2, runMs: 1 } })).toThrow(/timeoutPolicy/);

    const bad = plan();
    bad.timeoutPolicy = { perNodeMs: 1, runMs: 2, extra: true };
    const outcome = await executePlan({ plan: bad, providerCapabilities: providerCapabilities(), executeNode: () => undefined });
    expect(outcome).toMatchObject({ stage: "execute", type: "ERROR", code: "CONTRACT_VIOLATION" });
  });

  it("executes deterministic topological order even when edge array order is reversed", async () => {
    const target = plan();
    target.edges = [...target.edges].reverse();
    const calls = [];
    const outcome = await executePlan({ plan: target, providerCapabilities: providerCapabilities(), executeNode: (node) => calls.push(node.kind) });

    expect(outcome.type).toBe("COMPLETED");
    expect(calls).toEqual(["NAVIGATE", "OBSERVE", "CHECKPOINT"]);
  });

  it("rejects graph cycles and unknown edge references before execution", async () => {
    const cyclic = plan();
    cyclic.edges = [
      { from: cyclic.nodes[0].nodeId, to: cyclic.nodes[1].nodeId },
      { from: cyclic.nodes[1].nodeId, to: cyclic.nodes[0].nodeId },
    ];
    const cycleCalls = [];
    expect(await executePlan({ plan: cyclic, providerCapabilities: providerCapabilities(), executeNode: (node) => cycleCalls.push(node.nodeId) })).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(cycleCalls).toEqual([]);

    const unknown = plan();
    unknown.edges = [{ from: unknown.nodes[0].nodeId, to: "missing" }];
    const unknownCalls = [];
    expect(await executePlan({ plan: unknown, providerCapabilities: providerCapabilities(), executeNode: (node) => unknownCalls.push(node.nodeId) })).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(unknownCalls).toEqual([]);
  });

  it("plans only policy-authorized CLICK interactions with action evidence", () => {
    const clickStep = { id: "click", kind: "INTERACT", milestoneClass: "REQUIRED_EXACT_ACTION", action: "CLICK", target: { testId: "open" } };
    const clickPolicy = { ...readonlyPolicy, click: "SAFE_ONLY" };
    const capabilities = providerCapabilities({ actions: ["CLICK"], evidence: ["ACTION_LOG"] });
    const clickPlan = createExecutionPlan({ qaIr: qaIr(clickPolicy, [clickStep]), providerCapabilities: capabilities });

    expect(clickPlan.nodes[0]).toMatchObject({ kind: "INTERACT", milestoneClass: "REQUIRED_EXACT_ACTION", action: "CLICK", evidence: ["ACTION_LOG"] });
    expect(() => createExecutionPlan({ qaIr: qaIr(readonlyPolicy, [clickStep]), providerCapabilities: capabilities })).toThrow(/click is blocked by policy/);
    expect(() => createExecutionPlan({ qaIr: qaIr(clickPolicy, [{ ...clickStep, action: "TYPE", value: "x" }]), providerCapabilities: providerCapabilities({ actions: ["TYPE"], evidence: [] }) })).toThrow(/TYPE is not supported/);
  });

  it("preflights CLICK action and ACTION_LOG capabilities before execution", async () => {
    const clickStep = { id: "click", kind: "INTERACT", milestoneClass: "REQUIRED_EXACT_ACTION", action: "CLICK", target: { testId: "open" } };
    const clickPolicy = { ...readonlyPolicy, click: "SAFE_ONLY" };
    const capabilities = providerCapabilities({ actions: ["CLICK"], evidence: ["ACTION_LOG"] });
    const clickPlan = createExecutionPlan({ qaIr: qaIr(clickPolicy, [clickStep]), providerCapabilities: capabilities });

    for (const missing of [
      providerCapabilities({ actions: [], evidence: ["ACTION_LOG"] }),
      providerCapabilities({ actions: ["CLICK"], evidence: [] }),
    ]) {
      const calls = [];
      expect(await executePlan({ plan: clickPlan, providerCapabilities: missing, executeNode: node => calls.push(node.nodeId) })).toMatchObject({ code: "POLICY_VIOLATION" });
      expect(calls).toEqual([]);
    }

    const forged = structuredClone(clickPlan);
    forged.nodes[0].evidence = [];
    const calls = [];
    expect(await executePlan({ plan: forged, providerCapabilities: providerCapabilities({ actions: ["CLICK"], evidence: [] }), executeNode: node => calls.push(node.nodeId) })).toMatchObject({ code: "POLICY_VIOLATION" });
    expect(calls).toEqual([]);

    const disguised = structuredClone(clickPlan);
    disguised.nodes[0].kind = "OBSERVE";
    const disguisedCalls = [];
    expect(await executePlan({ plan: disguised, providerCapabilities: capabilities, executeNode: node => disguisedCalls.push(node.nodeId) })).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(disguisedCalls).toEqual([]);
  });

  it("rejects blocked navigation and DOM evidence before execution", async () => {
    const blockedNav = plan();
    blockedNav.nodes[0].policy = { ...readonlyPolicy, navigation: "BLOCKED" };
    const navCalls = [];
    expect(await executePlan({ plan: blockedNav, providerCapabilities: providerCapabilities(), executeNode: (node) => navCalls.push(node.nodeId) })).toMatchObject({ code: "POLICY_VIOLATION" });
    expect(navCalls).toEqual([]);

    const blockedDom = plan();
    blockedDom.nodes[1].policy = { ...readonlyPolicy, readDom: false };
    const domCalls = [];
    expect(await executePlan({ plan: blockedDom, providerCapabilities: providerCapabilities(), executeNode: (node) => domCalls.push(node.nodeId) })).toMatchObject({ code: "POLICY_VIOLATION" });
    expect(domCalls).toEqual([]);
  });

  it("requires readNetwork for NETWORK_LOG evidence", async () => {
    const networkPlan = createExecutionPlan({
      qaIr: qaIr({ ...readonlyPolicy, readNetwork: true }, [
        { id: "observe", kind: "OBSERVE", requests: [{ type: "NETWORK_LOG" }] },
      ]),
      providerCapabilities: providerCapabilities({ evidence: ["NETWORK_LOG"] }),
    });
    networkPlan.nodes[0].policy.readNetwork = false;
    const calls = [];
    const outcome = await executePlan({ plan: networkPlan, providerCapabilities: providerCapabilities({ evidence: ["NETWORK_LOG"] }), executeNode: (node) => calls.push(node.nodeId) });

    expect(calls).toEqual([]);
    expect(outcome).toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("rejects missing provider actions and evidence before execution", async () => {
    const target = plan();
    const calls = [];
    expect(await executePlan({ plan: target, providerCapabilities: providerCapabilities({ actions: ["NAVIGATE", "CHECKPOINT"], evidence: ["VISIBLE_TEXT"] }), executeNode: (node) => calls.push(node.nodeId) })).toMatchObject({ code: "POLICY_VIOLATION" });
    expect(calls).toEqual([]);

    expect(await executePlan({ plan: target, providerCapabilities: providerCapabilities({ evidence: [] }), executeNode: () => undefined })).toMatchObject({ code: "POLICY_VIOLATION" });
  });

  it("retries each node up to maxAttempts", async () => {
    const target = plan({ retryPolicy: { maxAttempts: 2 } });
    let attempts = 0;
    const outcome = await executePlan({
      plan: target,
      providerCapabilities: providerCapabilities(),
      executeNode: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
      },
    });

    expect(outcome.type).toBe("COMPLETED");
    expect(attempts).toBe(4);
  });

  it("returns generic timeout outcomes for per-node and run timeouts", async () => {
    const nodeTimeout = plan({ timeoutPolicy: { perNodeMs: 1, runMs: 10 } });
    expect(await executePlan({ plan: nodeTimeout, providerCapabilities: providerCapabilities(), executeNode: () => delay(8) })).toMatchObject({ stage: "execute", type: "ERROR", code: "UNKNOWN_RUNTIME_ERROR", message: "Execution timed out" });

    const runTimeout = plan({ timeoutPolicy: { perNodeMs: 3, runMs: 3 } });
    let calls = 0;
    expect(await executePlan({
      plan: runTimeout,
      providerCapabilities: providerCapabilities(),
      executeNode: async () => {
        calls += 1;
        if (calls === 1) await delay(2);
        else await delay(3);
      },
    })).toMatchObject({ stage: "execute", type: "ERROR", code: "UNKNOWN_RUNTIME_ERROR", message: "Execution timed out" });
  });

  it("sanitizes provider errors, forged stages, secrets, and null throws", async () => {
    const target = plan();
    const secretOutcome = await executePlan({
      plan: target,
      providerCapabilities: providerCapabilities(),
      executeNode: () => {
        const error = new Error("token=secret");
        error.stage = "judge";
        error.code = "EACCES";
        throw error;
      },
    });

    expect(validateContract("RuntimeOutcome", secretOutcome)).toBe(secretOutcome);
    expect(secretOutcome).toMatchObject({ stage: "execute", type: "ERROR", code: "UNKNOWN_RUNTIME_ERROR", message: "Execution provider failed" });
    expect(JSON.stringify(secretOutcome)).not.toContain("secret");
    expect(secretOutcome.verdict).toBeUndefined();

    const nullOutcome = await executePlan({ plan: target, providerCapabilities: providerCapabilities(), executeNode: () => { throw null; } });
    expect(nullOutcome).toMatchObject({ stage: "execute", type: "ERROR", code: "UNKNOWN_RUNTIME_ERROR", message: "Execution provider failed" });

    const forgedOutcome = await executePlan({
      plan: target,
      providerCapabilities: providerCapabilities(),
      executeNode: () => {
        const error = new Error("secret credential");
        error.code = "POLICY_VIOLATION";
        throw error;
      },
    });
    expect(forgedOutcome).toMatchObject({ stage: "execute", type: "ERROR", code: "POLICY_VIOLATION", message: "Execution provider failed" });
    expect(JSON.stringify(forgedOutcome)).not.toContain("secret");
  });

  it("completes readonly execution", async () => {
    const target = plan();
    const calls = [];
    const outcome = await executePlan({ plan: target, providerCapabilities: providerCapabilities(), executeNode: (node) => calls.push(node.kind) });

    expect(calls).toEqual(["NAVIGATE", "OBSERVE", "CHECKPOINT"]);
    expect(outcome).toEqual({ schemaVersion: "runtime-outcome/0.1", stage: "execute", type: "COMPLETED" });
  });
});
