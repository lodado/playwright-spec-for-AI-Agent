import { TextDecoder } from "node:util";
import { auditArtifactShape, validateContract } from "../contracts/index.mjs";
import { milestoneCompletionRule } from "../core/index.mjs";
import { verifyStoredEvidence } from "../evidence/index.mjs";

export function validateAdaptiveExecutionEvidence({ input, outcome, bundles, manifest, readBlob }) {
  validateContract("EvidenceManifest", manifest);
  if (!Array.isArray(bundles) || bundles.length === 0) throw new Error("adaptive execution evidence is missing");
  const bundleIds = bundles.map((bundle) => bundle?.bundleId);
  const checkpointBundleIds = manifest.checkpoints.map((checkpoint) => checkpoint.evidenceBundleId);
  const offset = checkpointBundleIds.indexOf(bundleIds[0]);
  if (manifest.runId !== input.runId || manifest.checkpoints.some((checkpoint) => checkpoint.stage !== "execute") || offset < 0 || bundleIds.some((id, index) => id !== checkpointBundleIds[offset + index])) {
    throw new Error("adaptive evidence does not match its manifest");
  }

  const audits = bundles.map((bundle) => {
    const verified = verifyStoredEvidence({ bundle, manifest, readBlob });
    if (verified.bundle.runId !== input.runId || verified.bundle.scenarioId !== input.scenarioId) throw new Error("adaptive evidence is bound to a different run or scenario");
    // The action log must exist to read the proposal; the full artifact shape is action-dependent,
    // so it is checked once the action is known.
    const actionArtifacts = verified.bundle.artifacts.filter((artifact) => artifact.type === "ACTION_LOG");
    if (actionArtifacts.length !== 1) throw new Error("adaptive checkpoint evidence is incomplete");
    let audit;
    try {
      audit = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(verified.readBlob(actionArtifacts[0].storageRef)));
    } catch {
      throw new Error("adaptive action evidence is invalid");
    }
    if (!isExactObject(audit, ["proposal", "status", "before", "after"]) && !isExactObject(audit, ["proposal", "status", "before", "after", "satisfiedMilestoneIds"])) throw new Error("adaptive action evidence is invalid");
    const invalidSatisfiedMilestones = audit.satisfiedMilestoneIds !== undefined && (!Array.isArray(audit.satisfiedMilestoneIds) || audit.satisfiedMilestoneIds.some((id) => !input.milestones.some((milestone) => milestone.id === id)));
    if (audit.status !== "ACCEPTED" || invalidSatisfiedMilestones) throw new Error("adaptive action evidence is invalid");
    const proposal = validateContract("ExecutionActionProposal", audit.proposal);
    if (!matchesAuditArtifactShape(verified.bundle.artifacts, auditArtifactShape(proposal.action))) throw new Error("adaptive checkpoint evidence is incomplete");
    if (proposal.runId !== input.runId || proposal.scenarioId !== input.scenarioId || proposal.leaseId !== input.capabilityLease.leaseId || !input.capabilityLease.actions.includes(proposal.action)) throw new Error("adaptive action evidence is bound to a different execution");
    if (!input.milestones.some((milestone) => milestone.id === proposal.milestoneId) || verified.bundle.checkpointId !== proposal.proposalId) throw new Error("adaptive action evidence is bound to an unknown milestone");
    validateAuditPage(audit.before, input.capabilityLease.allowedOrigins);
    validateAuditPage(audit.after, input.capabilityLease.allowedOrigins);
    if (verified.bundle.environment.targetUrl !== audit.after.url) throw new Error("adaptive action evidence does not match its checkpoint");
    return { proposal, before: audit.before, after: audit.after, satisfiedMilestoneIds: audit.satisfiedMilestoneIds };
  });

  const requiredMilestones = input.milestones.filter((milestone) => milestone.class !== "OPTIONAL_HINT");
  let milestoneIndex = 0;
  let expectedPage = input.currentPage;
  audits.forEach((audit, index) => {
    const milestone = requiredMilestones[milestoneIndex];
    // The runtime performs the startup navigation itself, so the first audit's `before` may carry
    // a redirected/normalized URL. pageId and domGeneration must still match the issued input, and
    // validateAuditPage has already pinned every audit URL inside the capability lease origins.
    const samePage = index === 0
      ? audit.before.pageId === expectedPage.pageId && audit.before.domGeneration === expectedPage.domGeneration
      : sameAuditPage(audit.before, expectedPage);
    if (milestone === undefined || audit.proposal.milestoneId !== milestone.id || !samePage) throw new Error("adaptive action evidence is out of sequence");
    expectedPage = audit.after;
    // Legacy audits (the 4-key form, sealed before the gateway evaluated semantic milestones) carry
    // no satisfiedMilestoneIds; synthesize membership so pre-2.3 runs stay judgeable. Current
    // gateways always seal the field, so new evidence is held to the strict rule.
    const satisfiedMilestoneIds = audit.satisfiedMilestoneIds ?? [milestone.id];
    if (milestoneCompletionRule({ action: audit.proposal.action, parameters: audit.proposal.parameters, satisfiedMilestoneIds }, milestone)) {
      milestoneIndex += 1;
      while (milestone.class === "REQUIRED_SEMANTIC_MILESTONE" && requiredMilestones[milestoneIndex]?.class === "REQUIRED_SEMANTIC_MILESTONE" && audit.satisfiedMilestoneIds?.includes(requiredMilestones[milestoneIndex].id)) milestoneIndex += 1;
    }
  });
  // Non-COMPLETED outcomes (ERROR/BLOCKED) seal only partial evidence: their bundle integrity and
  // sequencing above are still verified, but they need not cover every required milestone.
  if (outcome.type === "COMPLETED" && (milestoneIndex !== requiredMilestones.length || requiredMilestones.some((milestone) => !outcome.completedMilestoneIds.includes(milestone.id)))) throw new Error("adaptive milestone completion lacks accepted evidence");
}

function matchesAuditArtifactShape(artifacts, shape) {
  const counts = artifacts.reduce((totals, artifact) => ({ ...totals, [artifact.type]: (totals[artifact.type] ?? 0) + 1 }), {});
  const requiredCounts = shape.required.reduce((totals, entry) => ({ ...totals, [entry.type]: (totals[entry.type] ?? 0) + 1 }), {});
  const admissible = new Set([...Object.keys(requiredCounts), ...shape.optional]);
  return Object.entries(requiredCounts).every(([type, count]) => counts[type] === count)
    && shape.optional.every((type) => (counts[type] ?? 0) <= 1)
    && Object.keys(counts).every((type) => admissible.has(type));
}

function isExactObject(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validateAuditPage(value, allowedOrigins) {
  if (!isExactObject(value, ["pageId", "domGeneration", "url"]) || typeof value.pageId !== "string" || value.pageId.length === 0 || value.pageId.length > 256 || !Number.isSafeInteger(value.domGeneration) || value.domGeneration < 0) throw new Error("adaptive action page evidence is invalid");
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("adaptive action page evidence is invalid");
  }
  if (!allowedOrigins.includes(url.origin) || url.username || url.password || url.search || url.hash) throw new Error("adaptive action page evidence is outside the capability lease");
}

function sameAuditPage(left, right) {
  return left.pageId === right.pageId && left.domGeneration === right.domGeneration && left.url === right.url;
}
