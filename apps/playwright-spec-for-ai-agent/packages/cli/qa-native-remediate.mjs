import { createHmac, timingSafeEqual } from "node:crypto";
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { canonicalHash, validateContract } from "../contracts/index.mjs";
import { readEvidenceArchive } from "../evidence/index.mjs";
import { judgeEvidence } from "../judge/index.mjs";
import { createHermesPatchProposer, createHermesRemediationReviewer, createHermesSemanticJudge } from "../provider-hermes/index.mjs";
import { applyPatchProposal, checkExpectationIntegrity, createIndependentRemediationReview, createPatchProposal, decidePublication, rerunLiveScenario, verifyAppliedPatch } from "../remediation/index.mjs";
import { createFailureFingerprint, createGitHubCliDraftTransport, createGitHubCliIssueTransport, publishGitHubVerifiedDraft } from "../reporter-github/index.mjs";
import { loadProjectConfig } from "../../scripts/hermes-qa-project-config.mjs";
import { executeQaNative } from "./qa-native-execute.mjs";
import { publishIssueQaNative } from "./qa-native-publish-issue.mjs";
import { prepareQaNativeRemediation } from "./qa-native-report.mjs";
import { readAuthenticatedRunEnvelope } from "./qa-native-run-envelope.mjs";
import { createExclusiveQaDirectory, readPrivateJson, writePrivateJsonExclusive, writePrivateFileExclusive } from "./qa-native.mjs";

const STAGE_ENVELOPE_VERSION = "remediation-stage-envelope/0.1";

export async function remediateQaNative(options, overrides = {}) {
  return runRemediation(options, { ...overrides, stopAfterVerification: false });
}

export async function verifyPatchQaNative(options, overrides = {}) {
  return runRemediation(options, { ...overrides, stopAfterVerification: true });
}

async function runRemediation(options, overrides) {
  const prepare = overrides.prepare ?? prepareQaNativeRemediation;
  const propose = overrides.propose ?? createHermesPatchProposer();
  const buildProposal = overrides.buildProposal ?? createPatchProposal;
  const apply = overrides.apply ?? applyPatchProposal;
  const verify = overrides.verify ?? verifyAppliedPatch;
  const compare = overrides.rerun ?? defaultLiveRerun;
  const checkIntegrity = overrides.checkIntegrity ?? checkExpectationIntegrity;
  const createReview = overrides.createReview ?? createIndependentRemediationReview;
  const decide = overrides.decide ?? decidePublication;
  const publishIssue = overrides.publishIssue ?? publishIssueQaNative;
  const prepared = prepare({ ...options, repositoryId: options.repository });
  if (prepared.items.length !== 1) throw new Error("remediation requires exactly one failing judgment");
  const item = prepared.items[0];
  const base = { diagnosis: item.diagnosis, codeContext: item.codeContext, recommendation: item.recommendation };
  const publicationFingerprint = createFailureFingerprint({ qaIr: prepared.qaIr, ...item });
  if (!item.diagnosis.remediationEligible || !["PRODUCT_CODE", "TEST_CODE", "QA_SPEC", "API_CONTRACT", "FIXTURE_OR_MOCK", "TEST_DATA"].includes(item.diagnosis.origin)) {
    if (overrides.stopAfterVerification) return 1;
    await publishIssue(options, overrides.publishIssueOverrides);
    return 0;
  }

  const config = await loadRemediationConfig(options.repositoryRoot, overrides.loadConfig);
  let proposal;
  let application;
  let verification;
  let comparison;
  let after;
  let integrity;
  let review;
  let pipelineRoot;
  try {
    const resumed = loadDiscoveredProposalStage(options);
    if (resumed) {
      ({ proposal } = resumed);
      validateContract("PatchProposal", proposal, base);
      pipelineRoot = remediationRoot(options, proposal.proposalId);
    } else {
      const modelOutput = await propose(base);
      proposal = buildProposal({ ...base, modelOutput, repositoryRoot: options.repositoryRoot, policy: config.patch });
      pipelineRoot = remediationRoot(options, proposal.proposalId);
      persistStage(options, pipelineRoot, "proposal", { proposal, generatorIdentity: generatorIdentity(proposal) });
    }

    const applicationStage = loadStage(options, pipelineRoot, "application");
    application = applicationStage?.application ?? apply({ proposal, repositoryRoot: options.repositoryRoot, cwd: options.cwd, policy: config.patch });
    validateContract("PatchApplicationResult", application, { proposal });
    if (!applicationStage) persistStage(options, pipelineRoot, "application", { application });
    if (application.status !== "APPLIED") throw new PipelineFallback("patch application did not produce an isolated publishable diff");

    const verificationStage = loadStage(options, pipelineRoot, "verification");
    if (verificationStage) {
      verification = verificationStage.verification;
      validateContract("VerificationResult", verification, { proposal, application });
    } else {
      const verified = verify({ proposal, application, cwd: options.cwd, config: config.verification });
      verification = verified.result;
      persistStage(options, pipelineRoot, "verification", { verification, outputs: verified.outputs });
      for (const output of verified.outputs) writePrivateFileExclusive(relative(options.cwd, join(pipelineRoot, "verification", `${output.artifactId}.log`)), output.content, { cwd: options.cwd });
    }
    if (verification.status !== "PASS") throw new PipelineFallback("deterministic patch verification did not pass");
    if (overrides.stopAfterVerification) return 0;

    const comparisonStage = loadStage(options, pipelineRoot, "comparison");
    if (comparisonStage) {
      ({ comparison, after } = comparisonStage);
      validateContract("EvidenceComparison", comparison, { proposal, application, verification });
    } else {
      const before = overrides.buildBefore ? overrides.buildBefore({ options, prepared, item }) : originalLiveSide(options, prepared, item);
      const live = await compare({ options, proposal, application, verification, before });
      ({ comparison, after } = live);
      persistStage(options, pipelineRoot, "comparison", { comparison, after });
    }
    if (comparison.conclusion !== "IMPROVED" || comparison.newlyFailedExpectationIds.length > 0) throw new PipelineFallback("the original live QA scenario did not improve conclusively");

    const integrityStage = loadStage(options, pipelineRoot, "integrity");
    integrity = integrityStage?.integrity ?? checkIntegrity({ proposal, application, verification, comparison, beforeQaIr: prepared.qaIr, afterQaIr: after.qaIr, cwd: options.cwd });
    validateContract("ExpectationIntegrityResult", integrity, { proposal, application, verification, comparison });
    if (!integrityStage) persistStage(options, pipelineRoot, "integrity", { integrity });
    if (integrity.weakened || integrity.manualReview) throw new PipelineFallback("expectation integrity requires Issue fallback");

    const reviewStage = loadStage(options, pipelineRoot, "review");
    if (reviewStage) {
      review = reviewStage.review;
      validateContract("IndependentRemediationReview", review, { proposal, application, verification, comparison, integrity });
    } else {
      const reviewer = overrides.reviewer ?? createHermesRemediationReviewer({ invocationId: `review-${proposal.proposalId}`, model: config.review.model });
      review = await createReview({ ...base, proposal, application, verification, comparison, integrity, generatorIdentity: generatorIdentity(proposal), reviewerIdentity: reviewer.identity ?? { provider: "injected", model: "injected", invocationId: `review-${proposal.proposalId}` }, reviewer, cwd: options.cwd });
      persistStage(options, pipelineRoot, "review", { review });
    }
    if (review.decision !== "APPROVE_DRAFT") throw new PipelineFallback("independent remediation review did not approve a Draft PR");
  } catch (error) {
    if (overrides.stopAfterVerification) return 1;
    if (proposal && pipelineRoot) {
      try {
        const decision = decide({ repository: options.repository, publicationFingerprint, ...base, proposal, application, verification, comparison, integrity, review, policy: config.publication });
        persistStage(options, pipelineRoot, "decision", { decision, fallbackReason: error instanceof Error ? error.message : "remediation stage failed" });
      } catch {
        // The evidence-backed Issue path re-derives trusted artifacts and does not consume failed pipeline state.
      }
    }
    await publishIssue(options, overrides.publishIssueOverrides);
    return 0;
  }

  const issueTransport = overrides.issueTransport ?? createGitHubCliIssueTransport();
  const open = await issueTransport.findOpenPublications({ repository: options.repository, fingerprint: publicationFingerprint });
  const existingPublications = open.map(({ publication, number, url }) => ({ publication, number, url }));
  const decisionStage = loadStage(options, pipelineRoot, "decision");
  const decision = decisionStage?.decision ?? decide({ repository: options.repository, publicationFingerprint, ...base, proposal, application, verification, comparison, integrity, review, existingPublications, policy: config.publication });
  validateContract("PublicationDecision", decision);
  if (!decisionStage) persistStage(options, pipelineRoot, "decision", { decision });
  if (["CREATE_ISSUE", "UPDATE_ISSUE", "MANUAL_REVIEW"].includes(decision.action)) {
    await publishIssue(options, overrides.publishIssueOverrides);
    return decision.action === "MANUAL_REVIEW" ? 1 : 0;
  }
  if (decision.action === "NOOP") return 0;

  const publicationStage = loadStage(options, pipelineRoot, "publication");
  if (publicationStage) {
    validateContract("GitHubPublicationResult", publicationStage.result);
    return publicationStage.result.action === "AMBIGUOUS" ? 1 : 0;
  }
  const draftTransport = overrides.draftTransport ?? createGitHubCliDraftTransport();
  const result = await (overrides.publishDraft ?? publishGitHubVerifiedDraft)({
    repository: options.repository,
    qaIr: prepared.qaIr,
    ...item,
    proposal,
    application,
    verification,
    comparison,
    integrity,
    review,
    decision,
    worktreePath: resolve(options.cwd, application.worktree.path),
    stateAuthenticationKey: options.publicationKey,
    findOpenPublications: issueTransport.findOpenPublications,
    readPublication: issueTransport.readPublication,
    listOccurrenceRecords: issueTransport.listOccurrenceRecords,
    createOccurrenceRecord: issueTransport.createOccurrenceRecord,
    publishDraft: draftTransport.publishDraft,
  });
  persistStage(options, pipelineRoot, "publication", { result });
  return result.action === "AMBIGUOUS" ? 1 : 0;
}

async function defaultLiveRerun({ options, proposal, application, verification, before }) {
  const originalEnvelope = readAuthenticatedRunEnvelope({ runDirectory: options.runDirectory, cwd: options.cwd, integrityKey: options.integrityKey });
  const semanticJudge = createHermesSemanticJudge();
  return rerunLiveScenario({
    proposal,
    application,
    verification,
    before,
    async rerun(request) {
      const worktree = resolve(options.cwd, request.worktreePath);
      const specPath = resolve(worktree, request.sourcePath);
      const fromRoot = relative(worktree, specPath);
      if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error("live rerun source path escapes the isolated worktree");
      const runDirectory = join(worktree, ".qa", "runs", `remediation-${proposal.proposalId.slice(-16)}`);
      if (!pathExists(runDirectory)) await executeQaNative({ specPath, baseUrl: `${request.targetOrigin}/`, runDirectory, integrityKey: options.integrityKey, cwd: worktree, provider: originalEnvelope.mode === "adaptive" ? "hermes" : "playwright", mode: originalEnvelope.mode });
      const qaIr = readPrivateJson(relative(worktree, join(runDirectory, "qa-ir.json")), { cwd: worktree });
      validateContract("QaIrDocument", qaIr);
      const archive = readEvidenceArchive({ directory: join(runDirectory, "evidence"), integrityKey: options.integrityKey });
      readAuthenticatedRunEnvelope({ runDirectory, cwd: worktree, integrityKey: options.integrityKey });
      const evidenceBundle = archive.bundles.filter((bundle) => bundle.scenarioId === request.scenarioId).at(-1);
      if (!evidenceBundle) throw new Error("live rerun evidence is missing");
      const completedMilestoneIds = completedMilestones({ cwd: worktree, runDirectory, qaIr, mode: originalEnvelope.mode });
      return { qaIr, evidenceBundle, authenticated: true, completedMilestoneIds, judgeInput: { manifest: archive.manifest, readBlob: archive.readBlob } };
    },
    async judge({ qaIr, evidenceBundle, judgeInput }) {
      return judgeEvidence({ qaIr, bundle: evidenceBundle, manifest: judgeInput.manifest, readBlob: judgeInput.readBlob, semanticJudge });
    },
  });
}

function originalLiveSide(options, prepared, item) {
  const envelope = readAuthenticatedRunEnvelope({ runDirectory: options.runDirectory, cwd: options.cwd, integrityKey: options.integrityKey });
  return { qaIr: prepared.qaIr, evidenceBundle: item.evidenceBundle, judgeResult: item.judgeResult, authenticated: true, completedMilestoneIds: completedMilestones({ cwd: options.cwd, runDirectory: options.runDirectory, qaIr: prepared.qaIr, mode: envelope.mode, scenarioId: item.evidenceBundle.scenarioId }) };
}

function completedMilestones({ cwd, runDirectory, qaIr, mode, scenarioId }) {
  if (mode === "adaptive") {
    const outcomes = readPrivateJson(relative(cwd, join(runDirectory, "execution-agent-outcomes.json")), { cwd });
    if (!Array.isArray(outcomes)) throw new Error("adaptive execution metadata is invalid");
    const outcome = outcomes.find((candidate) => candidate?.scenarioId === scenarioId);
    if (outcome === undefined) throw new Error("adaptive execution metadata does not match evidence");
    validateContract("ExecutionAgentOutcome", outcome);
    return outcome.completedMilestoneIds;
  }
  return qaIr.suites.flatMap((suite) => suite.scenarios.flatMap((scenario) => scenario.steps.filter((step) => ["REQUIRED_EXACT_ACTION", "REQUIRED_SEMANTIC_MILESTONE"].includes(step.milestoneClass)).map((step) => step.id)));
}

async function loadRemediationConfig(repositoryRoot, loader = loadProjectConfig) {
  const config = await loader([`--root=${repositoryRoot}`]);
  const remediation = config.remediation ?? {};
  return {
    patch: jsonObject(remediation.patch),
    verification: jsonObject(remediation.verification),
    publication: jsonObject(remediation.publication),
    review: jsonObject(remediation.review),
  };
}

function jsonObject(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("remediation project config is invalid");
  return JSON.parse(JSON.stringify(value));
}

function generatorIdentity(proposal) {
  return Object.freeze({ provider: "hermes", model: "patch-generator", invocationId: `generate-${proposal.proposalId}` });
}

function remediationRoot(options, proposalId) {
  return join(options.runDirectory, "remediation", proposalId);
}

function loadDiscoveredProposalStage(options) {
  const root = join(options.runDirectory, "remediation");
  if (!pathExists(root)) return undefined;
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isDirectory() || !/^patch-proposal-[0-9a-f]{16}$/.test(entry.name)) || entries.length > 1) throw new Error("remediation storage is ambiguous");
  return entries.length === 0 ? undefined : loadStage(options, join(root, entries[0].name), "proposal");
}

function persistStage(options, pipelineRoot, stage, payload) {
  const existing = loadStage(options, pipelineRoot, stage);
  if (existing) {
    if (canonicalHash(existing) !== canonicalHash(payload)) throw new Error(`authenticated remediation stage ${stage} is immutable`);
    return existing;
  }
  const directory = join(pipelineRoot, stage);
  let created = false;
  try {
    createExclusiveQaDirectory(relative(options.cwd, directory), { cwd: options.cwd });
    created = true;
    writePrivateJsonExclusive(relative(options.cwd, join(directory, "artifact.json")), payload, { cwd: options.cwd });
    const body = { schemaVersion: STAGE_ENVELOPE_VERSION, stage, artifactHash: canonicalHash(payload) };
    writePrivateJsonExclusive(relative(options.cwd, join(directory, "envelope.json")), { ...body, authentication: stageAuthentication(body, options.integrityKey) }, { cwd: options.cwd });
    return payload;
  } catch (error) {
    if (created) rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function loadStage(options, pipelineRoot, stage) {
  const directory = join(pipelineRoot, stage);
  if (!pathExists(directory)) return undefined;
  const artifactPath = join(directory, "artifact.json");
  const envelopePath = join(directory, "envelope.json");
  if (!pathExists(artifactPath) || !pathExists(envelopePath)) {
    rmSync(directory, { recursive: true, force: true });
    return undefined;
  }
  const artifact = readPrivateJson(relative(options.cwd, artifactPath), { cwd: options.cwd });
  const envelope = readPrivateJson(relative(options.cwd, envelopePath), { cwd: options.cwd });
  if (!envelope || Object.keys(envelope).sort().join(",") !== "artifactHash,authentication,schemaVersion,stage" || envelope.schemaVersion !== STAGE_ENVELOPE_VERSION || envelope.stage !== stage || envelope.artifactHash !== canonicalHash(artifact) || !authenticatedStage(envelope, options.integrityKey)) throw new Error(`remediation stage ${stage} authentication failed`);
  return artifact;
}

function stageAuthentication(body, key) {
  return `hmac-sha256:${createHmac("sha256", key).update("qa-native/remediation-stage/v1\0").update(canonicalHash(body)).digest("hex")}`;
}

function authenticatedStage(envelope, key) {
  if (typeof envelope.authentication !== "string" || !/^hmac-sha256:[0-9a-f]{64}$/.test(envelope.authentication)) return false;
  const { authentication, ...body } = envelope;
  const actual = Buffer.from(authentication.slice("hmac-sha256:".length), "hex");
  const expected = Buffer.from(stageAuthentication(body, key).slice("hmac-sha256:".length), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function pathExists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

class PipelineFallback extends Error {}
