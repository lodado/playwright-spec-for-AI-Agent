import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QA_IR_VERSION, SEMANTIC_JUDGE_DECISION_VERSION } from "../contracts/index.mjs";
import { createExecutionPlan, executePlan, providerCapabilities, validateExecutionPlanBinding } from "../core/index.mjs";
import { createInMemoryEvidenceStore, readEvidenceArchive, verifyStoredEvidence, writeEvidenceArchive } from "../evidence/index.mjs";
import { judgeEvidence } from "../judge/index.mjs";
import { judgeWithHermes } from "../provider-hermes/index.mjs";
import { executeWithPlaywright, playwrightExecutionCapabilities } from "../provider-playwright/index.mjs";

const temporaryDirectories = [];
const integrityKey = Buffer.alloc(32, 0x51);
const fixtureCapabilities = providerCapabilities({
  providerId: "fixture-test-only",
  actions: ["NAVIGATE", "OBSERVE", "CHECKPOINT"],
  evidence: ["VISIBLE_TEXT"],
});
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function portableQaIr() {
  return {
    schemaVersion: QA_IR_VERSION,
    id: "qa-ir-portable",
    source: { adapter: "test", adapterVersion: "0.1", uri: "portable.spec.ts" },
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
          { id: "navigate", kind: "NAVIGATE", milestoneClass: "REQUIRED_SEMANTIC_MILESTONE", target: { type: "PATH", value: "/dashboard" } },
          { id: "observe", kind: "OBSERVE", requests: [{ type: "VISIBLE_TEXT" }] },
          { id: "checkpoint", kind: "CHECKPOINT", checkpointId: "loaded" },
        ],
        expectations: [{ id: "visual", kind: "VISUAL_STABILITY", target: { testId: "dashboard" } }],
        policy,
        provenance: [],
      }],
    }],
  };
}

async function executeWithFixture({ qaIr, plan, runId, secrets }) {
  validateExecutionPlanBinding({ qaIr, plan, providerCapabilities: fixtureCapabilities });
  const store = createInMemoryEvidenceStore({ providerCapabilities: fixtureCapabilities, producer: { name: "fixture-test-only", version: "0.1.0" }, secrets });
  const steps = new Map(qaIr.suites[0].scenarios[0].steps.map((step) => [step.id, step]));
  let artifacts = [];
  let bundle;
  let manifest;
  const outcome = await executePlan({
    plan,
    providerCapabilities: fixtureCapabilities,
    executeNode(node) {
      const step = steps.get(node.stepId);
      if (!step || step.kind !== node.kind) throw new Error("fixture plan mismatch");
      if (node.kind === "OBSERVE") {
        artifacts = [store.captureArtifact({ id: `${node.nodeId}:visible_text`, type: "VISIBLE_TEXT", contentType: "text/plain", content: "Dashboard stable fixture-secret" })];
      }
      if (node.kind === "CHECKPOINT") {
        bundle = store.createBundle({
          runId,
          scenarioId: node.scenarioId,
          checkpointId: step.checkpointId,
          capturedAt: "2026-07-25T00:00:00.000Z",
          environment: { targetUrl: "https://example.test/dashboard", browser: "fixture", viewport: { width: 1280, height: 720 } },
          artifacts,
          facts: [{ id: `${node.nodeId}:url`, kind: "URL", value: "https://example.test/dashboard" }],
        });
        manifest = store.appendCheckpoint(bundle);
      }
    },
  });
  return { outcome, bundles: bundle ? [bundle] : [], manifest, readBlob: store.readBlob };
}

function fakeBrowser() {
  const launch = vi.fn(async () => ({
    async close() {},
    async newContext() {
      return {
        async route() {},
        async routeWebSocket() {},
        async newPage() {
          return {
            async goto() {},
            locator: () => ({ async evaluate(_callback, maxChars) { return "Dashboard stable fixture-secret".slice(0, maxChars); } }),
            url: () => "https://example.test/dashboard",
            viewportSize: () => ({ width: 1280, height: 720 }),
          };
        },
      };
    },
  }));
  return { launch, browserType: { launch } };
}

function staticSemanticJudge(input) {
  return {
    schemaVersion: SEMANTIC_JUDGE_DECISION_VERSION,
    expectationResults: input.expectations.map((expectation) => ({
      expectationId: expectation.id,
      status: "MATCHED",
      confidence: 1,
      evidenceRefs: [input.evidence[0].id],
      rationale: "Static portability decision.",
    })),
    uncertainty: [],
    judge: { provider: "fixture-static-test-only", model: "static", modelVersion: "0.1.0", promptVersion: "fixture-static/0.1" },
  };
}

describe("runtime contract portability", () => {
  it("executes one QA IR twice and rejudges one persisted bundle without reopening a browser", async () => {
    const qaIr = portableQaIr();
    const playwrightPlan = createExecutionPlan({ qaIr, providerCapabilities: playwrightExecutionCapabilities() });
    const fixturePlan = createExecutionPlan({ qaIr, providerCapabilities: fixtureCapabilities });
    expect(fixturePlan).toEqual(playwrightPlan);

    const browser = fakeBrowser();
    const live = await executeWithPlaywright({
      qaIr,
      plan: playwrightPlan,
      baseUrl: "https://example.test",
      runId: "run-playwright",
      browserType: browser.browserType,
      secrets: ["fixture-secret"],
      now: () => "2026-07-25T00:00:00.000Z",
    });
    const fixture = await executeWithFixture({ qaIr, plan: fixturePlan, runId: "run-fixture", secrets: ["fixture-secret"] });
    expect(live.outcome.type).toBe("COMPLETED");
    expect(fixture.outcome.type).toBe("COMPLETED");
    expect(live.bundles[0].artifacts.map((artifact) => artifact.contentHash)).toEqual(fixture.bundles[0].artifacts.map((artifact) => artifact.contentHash));
    expect(verifyStoredEvidence({ bundle: fixture.bundles[0], manifest: fixture.manifest, readBlob: fixture.readBlob }).bundle).toEqual(fixture.bundles[0]);

    const parent = mkdtempSync(join(tmpdir(), "qa-contract-portability-"));
    temporaryDirectories.push(parent);
    const directory = join(parent, "archive");
    writeEvidenceArchive({ directory, bundles: fixture.bundles, manifest: fixture.manifest, readBlob: fixture.readBlob, secrets: ["fixture-secret"], integrityKey });
    const replay = readEvidenceArchive({ directory, secrets: ["fixture-secret"], integrityKey });
    expect(replay.bundles[0]).toEqual(fixture.bundles[0]);
    expect(Object.isFrozen(replay.bundles)).toBe(true);
    expect(Object.isFrozen(replay.bundles[0])).toBe(true);
    expect(Object.isFrozen(replay.bundles[0].artifacts[0])).toBe(true);
    expect(Object.isFrozen(replay.bundles[0].facts[0])).toBe(true);
    expect(() => { replay.bundles[0].facts[0].value = "tampered"; }).toThrow(TypeError);
    expect(replay.readBlob(replay.bundles[0].artifacts[0].storageRef).toString("utf8")).not.toContain("fixture-secret");
    const launchesBeforeJudgment = browser.launch.mock.calls.length;
    const transport = vi.fn(async () => ({
      expectationResults: [{ expectationId: "visual", status: "MATCHED", confidence: 1, evidenceRefs: [replay.bundles[0].artifacts[0].id], rationale: "Static portability decision." }],
      uncertainty: [],
    }));
    const judgeInput = { qaIr, bundle: replay.bundles[0], manifest: replay.manifest, readBlob: replay.readBlob, secrets: ["fixture-secret"] };
    const hermes = await judgeWithHermes({ ...judgeInput, transport, model: "hermes-test" });
    const staticResult = await judgeEvidence({ ...judgeInput, semanticJudge: async (input) => staticSemanticJudge(input) });

    expect(hermes.verdict).toBe("PASS");
    expect(staticResult.verdict).toBe("PASS");
    expect(staticResult.inputHash).toBe(hermes.inputHash);
    expect(staticResult.expectationResults).toEqual(hermes.expectationResults);
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0]).not.toContain("fixture-secret");
    expect(browser.launch).toHaveBeenCalledTimes(launchesBeforeJudgment);
    expect(JSON.stringify({ replay, hermes, staticResult })).not.toContain("fixture-secret");
  });
});
