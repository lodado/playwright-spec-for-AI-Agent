import { TextDecoder } from "node:util";
import { validateContract } from "../contracts/index.mjs";
import { verifyStoredEvidence } from "../evidence/index.mjs";

export function validateAdaptiveExecutionEvidence({ input, outcome, bundles, manifest, readBlob }) {
  validateContract("EvidenceManifest", manifest);
  if (!Array.isArray(bundles) || bundles.length === 0) throw new Error("adaptive execution evidence is missing");
  const bundleIds = bundles.map((bundle) => bundle?.bundleId);
  const checkpointBundleIds = manifest.checkpoints.map((checkpoint) => checkpoint.evidenceBundleId);
  if (manifest.runId !== input.runId || manifest.checkpoints.some((checkpoint) => checkpoint.stage !== "execute") || bundleIds.some((id, index) => id !== checkpointBundleIds[index]) || bundleIds.length !== checkpointBundleIds.length) {
    throw new Error("adaptive evidence does not match its manifest");
  }

  const audits = bundles.map((bundle) => {
    const verified = verifyStoredEvidence({ bundle, manifest, readBlob });
    if (verified.bundle.runId !== input.runId || verified.bundle.scenarioId !== input.scenarioId) throw new Error("adaptive evidence is bound to a different run or scenario");
    const domArtifacts = verified.bundle.artifacts.filter((artifact) => artifact.type === "DOM_SNAPSHOT");
    const ariaArtifacts = verified.bundle.artifacts.filter((artifact) => artifact.type === "ARIA_SNAPSHOT");
    const actionArtifacts = verified.bundle.artifacts.filter((artifact) => artifact.type === "ACTION_LOG");
    if (verified.bundle.artifacts.length !== 5 || domArtifacts.length !== 2 || ariaArtifacts.length !== 2 || actionArtifacts.length !== 1) throw new Error("adaptive checkpoint evidence is incomplete");
    let audit;
    try {
      audit = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(verified.readBlob(actionArtifacts[0].storageRef)));
    } catch {
      throw new Error("adaptive action evidence is invalid");
    }
    if (!isExactObject(audit, ["proposal", "status", "before", "after"]) || audit.status !== "ACCEPTED") throw new Error("adaptive action evidence is invalid");
    const proposal = validateContract("ExecutionActionProposal", audit.proposal);
    if (proposal.runId !== input.runId || proposal.scenarioId !== input.scenarioId || proposal.leaseId !== input.capabilityLease.leaseId || !input.capabilityLease.actions.includes(proposal.action)) throw new Error("adaptive action evidence is bound to a different execution");
    if (!input.milestones.some((milestone) => milestone.id === proposal.milestoneId) || verified.bundle.checkpointId !== proposal.proposalId) throw new Error("adaptive action evidence is bound to an unknown milestone");
    validateAuditPage(audit.before, input.capabilityLease.allowedOrigins);
    validateAuditPage(audit.after, input.capabilityLease.allowedOrigins);
    if (verified.bundle.environment.targetUrl !== audit.after.url) throw new Error("adaptive action evidence does not match its checkpoint");
    return { proposal, before: audit.before, after: audit.after };
  });

  const requiredMilestones = input.milestones.filter((milestone) => milestone.class !== "OPTIONAL_HINT");
  let milestoneIndex = 0;
  let expectedPage = input.currentPage;
  for (const audit of audits) {
    const milestone = requiredMilestones[milestoneIndex];
    if (milestone === undefined || audit.proposal.milestoneId !== milestone.id || !sameAuditPage(audit.before, expectedPage)) throw new Error("adaptive action evidence is out of sequence");
    expectedPage = audit.after;
    if (provesMilestone(audit.proposal, milestone)) milestoneIndex += 1;
  }
  if (milestoneIndex !== requiredMilestones.length || requiredMilestones.some((milestone) => !outcome.completedMilestoneIds.includes(milestone.id))) throw new Error("adaptive milestone completion lacks accepted evidence");
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

function provesMilestone(proposal, milestone) {
  if (milestone.class === "REQUIRED_EXACT_ACTION") return proposal.action === milestone.requiredAction;
  return ["observe_dom", "observe_aria"].includes(proposal.action) || (proposal.action === "wait_for_element_state" && ["present", "visible"].includes(proposal.parameters.state));
}
