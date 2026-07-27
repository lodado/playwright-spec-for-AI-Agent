import { describe, expect, it } from "vitest";

import {
  EVIDENCE_COMPARISON_VERSION,
  JUDGE_RESULT_VERSION,
  PATCH_APPLICATION_RESULT_VERSION,
  PATCH_PROPOSAL_VERSION,
  PROVIDER_CAPABILITIES_VERSION,
  QA_IR_VERSION,
  VERIFICATION_RESULT_VERSION,
  canonicalHash,
  validateContract,
} from "../../contracts/index.mjs";
import { createInMemoryEvidenceStore } from "../../evidence/index.mjs";
import { compareEvidence, rerunLiveScenario } from "../index.mjs";

describe("authenticated before/after evidence comparison", () => {
  it("requires a real fixed expectation, no new failures, and preserved milestones for IMPROVED", () => {
    const chain = artifactChain();
    const qaIr = qaIrFixture();
    const before = liveSide({ qaIr, runId: "before-run", statuses: ["CONTRADICTED", "MATCHED"] });
    const after = liveSide({ qaIr, runId: "after-run", statuses: ["MATCHED", "MATCHED"] });
    const comparison = compareEvidence({ ...chain, before, after });

    expect(validateContract("EvidenceComparison", comparison, chain)).toBe(comparison);
    expect(comparison).toMatchObject({ schemaVersion: EVIDENCE_COMPARISON_VERSION, conclusion: "IMPROVED", fixedExpectationIds: ["expect-title"], newlyFailedExpectationIds: [] });
    expect(comparison.requiredMilestoneIds).toEqual(["navigate-dashboard", "open-settings"]);
    expect(comparison.preservedMilestoneIds).toEqual(comparison.requiredMilestoneIds);
  });

  it("classifies new failures as REGRESSED and incomplete or changed reruns as INCONCLUSIVE", () => {
    const chain = artifactChain();
    const qaIr = qaIrFixture();
    const before = liveSide({ qaIr, runId: "before-run", statuses: ["CONTRADICTED", "MATCHED"] });
    const regressed = liveSide({ qaIr, runId: "after-regressed", statuses: ["MATCHED", "CONTRADICTED"] });
    expect(compareEvidence({ ...chain, before, after: regressed })).toMatchObject({ conclusion: "REGRESSED", newlyFailedExpectationIds: ["expect-dialog"] });

    const changedQaIr = qaIrFixture();
    changedQaIr.suites[0].scenarios[0].policy.readNetwork = false;
    const inconclusive = liveSide({ qaIr: changedQaIr, runId: "after-inconclusive", statuses: ["MATCHED", "MATCHED"], authenticated: false, completedMilestoneIds: ["navigate-dashboard"] });
    const result = compareEvidence({ ...chain, before, after: inconclusive });
    expect(result.conclusion).toBe("INCONCLUSIVE");
    expect(result.policyChanges).toHaveLength(1);
    expect(result.inconclusiveReasons.join(" ")).toMatch(/authenticated|required exact-action|different QA IR/);
  });

  it("never treats an unchanged live failure as fixed", () => {
    const chain = artifactChain();
    const qaIr = qaIrFixture();
    const before = liveSide({ qaIr, runId: "before-run", statuses: ["CONTRADICTED", "MATCHED"] });
    const after = liveSide({ qaIr, runId: "after-run", statuses: ["CONTRADICTED", "MATCHED"] });
    expect(compareEvidence({ ...chain, before, after })).toMatchObject({ conclusion: "UNCHANGED", fixedExpectationIds: [], unchangedFailureIds: ["expect-title"] });
  });

  it("keeps browser rerun and after-evidence judgment as separate ordered invocations", async () => {
    const chain = artifactChain();
    const qaIr = qaIrFixture();
    const before = liveSide({ qaIr, runId: "before-run", statuses: ["CONTRADICTED", "MATCHED"] });
    const after = liveSide({ qaIr, runId: "after-run", statuses: ["MATCHED", "MATCHED"] });
    const order = [];
    const result = await rerunLiveScenario({
      ...chain,
      before,
      async rerun(request) {
        order.push("rerun");
        expect(request).toMatchObject({ scenarioId: "scenario-settings", targetOrigin: "https://example.test", baseRevision: chain.proposal.baseRevision });
        expect(request).not.toHaveProperty("judgeResult");
        return { qaIr: after.qaIr, evidenceBundle: after.evidenceBundle, authenticated: true, completedMilestoneIds: after.completedMilestoneIds, judgeInput: { invocationId: "after-judge-input" } };
      },
      async judge(input) {
        order.push("judge");
        expect(input.judgeInput).toEqual({ invocationId: "after-judge-input" });
        return after.judgeResult;
      },
    });
    expect(order).toEqual(["rerun", "judge"]);
    expect(result.comparison.conclusion).toBe("IMPROVED");
    const sameInvocation = async () => after;
    await expect(rerunLiveScenario({ ...chain, before, rerun: sameInvocation, judge: sameInvocation })).rejects.toThrow(/separate invocations/);
  });
});

function artifactChain() {
  const hash = `sha256:${"1".repeat(64)}`;
  const proposal = {
    schemaVersion: PATCH_PROPOSAL_VERSION,
    proposalId: "patch-proposal-1111111111111111",
    diagnosisId: "diagnosis-fixture",
    codeContextBundleId: "code-context-fixture",
    repairRecommendationId: "recommendation-fixture",
    baseRevision: "1".repeat(40),
    intent: "Fix settings dialog",
    expectedEffect: "The dialog opens",
    risks: ["Review required"],
    files: [{ path: "src/settings.mjs", action: "MODIFY", originalContentHash: hash }],
    operations: [{ type: "REPLACE_RANGE", path: "src/settings.mjs", startLine: 1, endLine: 1, replacement: "export const fixed = true;" }],
    verificationPlan: [{ command: "npm test", purpose: "Run tests" }],
  };
  const application = {
    schemaVersion: PATCH_APPLICATION_RESULT_VERSION,
    applicationId: "patch-application-fixture",
    proposalId: proposal.proposalId,
    baseRevision: proposal.baseRevision,
    status: "APPLIED",
    worktree: { worktreeId: "worktree-fixture", path: ".qa/worktrees/worktree-fixture", branch: "qa/fix-fixture", revision: proposal.baseRevision },
    appliedFiles: [{ path: "src/settings.mjs", action: "MODIFY", beforeHash: hash, afterHash: `sha256:${"2".repeat(64)}` }],
    diff: { fileCount: 1, changedLines: 2, contentHash: `sha256:${"3".repeat(64)}` },
  };
  const checks = ["format", "lint", "typecheck", "unit", "playwright"].map((name) => ({ name, required: true, status: "PASS", exitCode: 0, durationMs: 1, resourceOutcome: "WITHIN_LIMITS" }));
  const verification = {
    schemaVersion: VERIFICATION_RESULT_VERSION,
    verificationId: "verification-fixture",
    proposalId: proposal.proposalId,
    applicationId: application.applicationId,
    worktreeRevision: proposal.baseRevision,
    diffHash: application.diff.contentHash,
    status: "PASS",
    checks,
  };
  return { proposal, application, verification };
}

function qaIrFixture() {
  return {
    schemaVersion: QA_IR_VERSION,
    id: "qa-settings",
    source: { adapter: "playwright", adapterVersion: "0.1", uri: "tests/settings.spec.ts", revision: "fixture" },
    suites: [{
      id: "suite-settings",
      title: "Settings",
      tags: [],
      provenance: [],
      scenarios: [{
        id: "scenario-settings",
        title: "opens settings",
        preconditions: [],
        steps: [
          { id: "navigate-dashboard", kind: "NAVIGATE", milestoneClass: "REQUIRED_SEMANTIC_MILESTONE", target: { type: "PATH", value: "/dashboard" } },
          { id: "open-settings", kind: "INTERACT", milestoneClass: "REQUIRED_EXACT_ACTION", action: "CLICK", target: { role: "button", accessibleName: { kind: "literal", value: "Settings" } } },
        ],
        expectations: [
          { id: "expect-title", kind: "VISIBLE", target: { role: "heading" } },
          { id: "expect-dialog", kind: "VISIBLE", target: { role: "dialog" } },
        ],
        policy: { navigation: "ALLOWED", readDom: true, readNetwork: true, click: "SAFE_ONLY", type: "NONE", upload: false, submit: false, destructiveMutation: false, confirmation: "DENY", secrets: "RUNTIME_INJECTED" },
        provenance: [],
      }],
    }],
  };
}

function liveSide({ qaIr, runId, statuses, authenticated = true, completedMilestoneIds = ["navigate-dashboard", "open-settings"] }) {
  const store = createInMemoryEvidenceStore({ providerCapabilities: { schemaVersion: PROVIDER_CAPABILITIES_VERSION, providerId: "fixture", actions: [], evidence: [], unsupportedEvidence: [] } });
  const facts = statuses.map((status, index) => ({ id: `${runId}-fact-${index}`, kind: "TEXT", value: status }));
  const evidenceBundle = store.createBundle({ runId, scenarioId: "scenario-settings", checkpointId: `${runId}-checkpoint`, capturedAt: "2026-07-27T00:00:00.000Z", environment: { targetUrl: "https://example.test/dashboard", browser: "chromium", viewport: { width: 1280, height: 720 } }, artifacts: [], facts });
  const expectationIds = ["expect-title", "expect-dialog"];
  const verdict = statuses.every((status) => status === "MATCHED") ? "PASS" : "FAIL";
  const judgeBody = {
    schemaVersion: JUDGE_RESULT_VERSION,
    qaIrId: qaIr.id,
    evidenceBundleId: evidenceBundle.bundleId,
    verdict,
    confidence: 0.9,
    expectationResults: statuses.map((status, index) => ({ expectationId: expectationIds[index], status, confidence: 0.9, evidenceRefs: [facts[index].id], rationale: `fixture ${status}` })),
    uncertainty: [],
    judge: { provider: "fixture-judge", model: "fixture", promptVersion: "fixture/0.1" },
    inputHash: canonicalHash({ qaIrId: qaIr.id, evidenceBundleId: evidenceBundle.bundleId }),
  };
  const judgeResult = { ...judgeBody, resultId: `judge-${canonicalHash(judgeBody).slice(7, 23)}` };
  return { qaIr, evidenceBundle, judgeResult, authenticated, completedMilestoneIds };
}
