import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  FAILURE_DIAGNOSIS_VERSION,
  EVIDENCE_COMPARISON_VERSION,
  EXPECTATION_INTEGRITY_RESULT_VERSION,
  INDEPENDENT_REMEDIATION_REVIEW_VERSION,
  PUBLICATION_DECISION_VERSION,
  PATCH_APPLICATION_RESULT_VERSION,
  REPAIR_RECOMMENDATION_VERSION,
  VERIFICATION_RESULT_VERSION,
  canonicalHash,
  snapshotContract,
  validateContract,
} from "../contracts/index.mjs";
import { redactSensitiveText, verifyEvidenceBundleIdentity } from "../evidence/index.mjs";

const ORIGIN_BY_FACT_KIND = new Map([
  ["TEST_ERROR", "TEST_CODE"],
  ["QA_SPEC_ERROR", "QA_SPEC"],
  ["API_CONTRACT_ERROR", "API_CONTRACT"],
  ["FIXTURE_OR_MOCK_ERROR", "FIXTURE_OR_MOCK"],
  ["TEST_DATA_ERROR", "TEST_DATA"],
  ["ENVIRONMENT_ERROR", "ENVIRONMENT"],
  ["THIRD_PARTY_ERROR", "THIRD_PARTY"],
]);
const EXPLICIT_ORIGINS = new Set(ORIGIN_BY_FACT_KIND.values());
const PATCH_ELIGIBLE_ORIGINS = new Set(["PRODUCT_CODE", "TEST_CODE", "QA_SPEC", "API_CONTRACT", "FIXTURE_OR_MOCK", "TEST_DATA"]);
const DEFAULT_PATCH_POLICY = Object.freeze({ minimumConfidence: 0.5, maxFiles: 5, maxChangedLines: 200, allowedPaths: [""], deniedPaths: [] });
const DEFAULT_DENIED_PATH = /(?:^|\/)(?:\.git|\.github\/workflows|infra|infrastructure|terraform|prisma\/migrations|database\/migrations|migrations|(?:auth|security|secrets|billing|payments)(?:[._-][^/]*)?)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|\.envrc|[^/]+\.env|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx|keystore)|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|[^/]*\.lock)$/i;
const MAX_MODEL_OUTPUT_BYTES = 256 * 1024;
const VERIFICATION_STAGES = Object.freeze(["format", "lint", "typecheck", "unit", "playwright"]);
const VERIFICATION_EXECUTABLES = new Set(["node", "npm", "pnpm", "yarn", "bun"]);
const DEFAULT_VERIFICATION_POLICY = Object.freeze({ perCommandTimeoutMs: 120_000, totalTimeoutMs: 600_000, maxOutputBytes: 65_536 });
const INTEGRITY_RULES = Object.freeze(["SKIP_OR_ONLY", "ASSERTION_REMOVAL", "MILESTONE_STRENGTH", "EXPECTATION_STRENGTH", "TIMEOUT_RETRY_INFLATION", "CONDITIONAL_BYPASS", "SWALLOWED_ERROR", "FORCED_RESULT", "QA_POLICY_WEAKENING", "GATE_LOWERING", "QA_IR_CHANGE"]);

export function diagnoseFailure({ qaIr, judgeResult, evidenceBundle, secrets = [] }) {
  const input = jsonSnapshot({ qaIr, judgeResult, evidenceBundle });
  const secretList = Object.freeze([...secrets].filter(Boolean).map(String));
  validateContract("QaIrDocument", input.qaIr);
  validateContract("EvidenceBundle", input.evidenceBundle);
  validateContract("JudgeResult", input.judgeResult, {
    qaIr: input.qaIr,
    evidenceBundle: input.evidenceBundle,
  });

  const failed = input.judgeResult.expectationResults.filter((item) => item.status === "CONTRADICTED");
  const unresolved = input.judgeResult.expectationResults.filter((item) => ["NOT_OBSERVED", "AMBIGUOUS"].includes(item.status));
  const supportingEvidenceRefs = unique([...failed, ...unresolved].flatMap((item) => item.evidenceRefs));
  const origin = classifyOrigin(input.evidenceBundle, supportingEvidenceRefs, failed.length > 0);
  const remediationEligible = !["UNKNOWN", "ENVIRONMENT", "THIRD_PARTY"].includes(origin);
  const manualReviewReasons = remediationEligible ? [] : [manualReviewReason(origin, input.judgeResult.verdict)];
  const symptom = failed.length > 0
    ? `Contradicted expectations: ${failed.map((item) => item.expectationId).join(", ")}`
    : `Unresolved expectations: ${unresolved.map((item) => item.expectationId).join(", ") || "none"}`;
  const body = {
    schemaVersion: FAILURE_DIAGNOSIS_VERSION,
    judgeResultId: input.judgeResult.resultId,
    origin,
    confidence: diagnosisConfidence(origin, input.judgeResult.confidence),
    symptom: symptom.slice(0, 4_096),
    likelyCause: redactSensitiveText(likelyCause(origin, failed), secretList),
    supportingEvidenceRefs,
    contradictingEvidenceRefs: [],
    remediationEligible,
    manualReviewReasons,
  };

  return validateContract("FailureDiagnosis", {
    ...body,
    diagnosisId: stableId("diagnosis", body),
  }, { judgeResult: input.judgeResult, evidenceBundle: input.evidenceBundle });
}

export function recommendRepair({ diagnosis, codeContext, qaIr, judgeResult, evidenceBundle, secrets = [] }) {
  const input = jsonSnapshot({ diagnosis, codeContext, qaIr, judgeResult, evidenceBundle });
  const secretList = Object.freeze([...secrets].filter(Boolean).map(String));
  validateContract("QaIrDocument", input.qaIr);
  validateContract("EvidenceBundle", input.evidenceBundle);
  validateContract("JudgeResult", input.judgeResult, { qaIr: input.qaIr, evidenceBundle: input.evidenceBundle });
  validateContract("FailureDiagnosis", input.diagnosis, { judgeResult: input.judgeResult, evidenceBundle: input.evidenceBundle });
  const derivedDiagnosis = diagnoseFailure({ qaIr: input.qaIr, judgeResult: input.judgeResult, evidenceBundle: input.evidenceBundle, secrets: secretList });
  if (canonicalHash(input.diagnosis) !== canonicalHash(derivedDiagnosis)) throw new Error("FailureDiagnosis does not match Judge evidence");
  validateContract("CodeContextBundle", input.codeContext);
  if (input.codeContext.failureDiagnosisId !== input.diagnosis.diagnosisId) {
    throw new Error("CodeContextBundle does not belong to the diagnosis");
  }

  const candidates = input.codeContext.candidates.slice(0, 3);
  const primary = candidates[0];
  const suggestionOnly = input.diagnosis.remediationEligible && primary;
  const body = {
    schemaVersion: REPAIR_RECOMMENDATION_VERSION,
    diagnosisId: input.diagnosis.diagnosisId,
    repositoryRevision: input.codeContext.revision,
    title: (primary ? `Review ${primary.path}` : "Manual QA failure review required").slice(0, 500),
    severity: severityFor(input.diagnosis.origin),
    summary: input.diagnosis.symptom,
    rootCause: input.diagnosis.likelyCause,
    confidence: primary ? Math.min(input.diagnosis.confidence, primary.relevanceScore) : input.diagnosis.confidence,
    locations: candidates.map((candidate) => ({
      path: candidate.path,
      ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
      ...(candidate.range ? { range: candidate.range } : {}),
      reason: candidate.matchReasons.join(", "),
    })),
    changes: suggestionOnly ? [{
      path: primary.path,
      recommendation: `Align the matched implementation with ${input.diagnosis.symptom.toLowerCase()} without weakening the QA expectation.`.slice(0, 4_096),
      expectedEffect: "The cited expectation should match on the next evidence-backed QA run.",
      risks: ["The deterministic locator identifies likely code, not a proven root cause; review the cited evidence before editing."],
    }] : [],
    verificationPlan: [{
      command: "npm test",
      purpose: "Run repository regression tests before accepting any implementation change.",
    }],
    evidenceRefs: input.diagnosis.supportingEvidenceRefs,
    codeContextRefs: [input.codeContext.bundleId],
    patchEligibility: suggestionOnly ? "SUGGESTION_ONLY" : "MANUAL_REVIEW_REQUIRED",
  };

  return validateContract("RepairRecommendation", {
    ...body,
    recommendationId: stableId("recommendation", body),
  }, { diagnosis: input.diagnosis, codeContext: input.codeContext });
}

export function createPatchProposal({ diagnosis, codeContext, recommendation, modelOutput, repositoryRoot, policy = {}, secrets = [] }) {
  const input = jsonSnapshot({ diagnosis, codeContext, recommendation });
  validateContract("FailureDiagnosis", input.diagnosis);
  validateContract("CodeContextBundle", input.codeContext);
  validateContract("RepairRecommendation", input.recommendation, { diagnosis: input.diagnosis, codeContext: input.codeContext });
  if (!input.diagnosis.remediationEligible || !PATCH_ELIGIBLE_ORIGINS.has(input.diagnosis.origin)) throw new Error("failure origin is not eligible for a patch proposal");
  const gate = patchPolicy(policy);
  if (input.diagnosis.confidence < gate.minimumConfidence) throw new Error("diagnosis confidence is below the patch threshold");
  if (input.codeContext.candidates.length !== 1 || input.codeContext.snippets.length !== 1) throw new Error("patch proposal requires one unambiguous code candidate");
  if (input.recommendation.patchEligibility !== "SUGGESTION_ONLY") throw new Error("repair recommendation is not patch eligible");

  const serialized = JSON.stringify(modelOutput);
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_MODEL_OUTPUT_BYTES) throw new Error("patch model output is invalid or oversized");
  const rawSnapshot = JSON.parse(serialized);
  const redactedSnapshot = redactModelValue(rawSnapshot, Object.freeze([...secrets].filter(Boolean).map(String)));
  if (canonicalHash(rawSnapshot) !== canonicalHash(redactedSnapshot)) throw new Error("patch model output contains sensitive content");
  const candidate = snapshotContract("PatchProposal", redactedSnapshot, {
    diagnosis: input.diagnosis,
    codeContext: input.codeContext,
    recommendation: input.recommendation,
  });
  if (candidate.files.length > gate.maxFiles) throw new Error("patch proposal exceeds the changed-file limit");
  if (!candidate.files.some((file) => file.action === "MODIFY")) throw new Error("patch proposal must modify the unambiguous code candidate");

  const root = repositoryAtRevision(repositoryRoot, candidate.baseRevision);
  const codeCandidate = input.codeContext.candidates[0];
  const snippet = input.codeContext.snippets[0];
  let changedLines = 0;
  for (const file of candidate.files) {
    assertAllowedPatchPath(file.path, gate);
    if (file.action === "MODIFY") {
      if (file.path !== codeCandidate.path || file.path !== snippet.path) throw new Error("modified file is not the unambiguous code candidate");
      const blob = readPinnedBlob(root, candidate.baseRevision, file.path);
      const contentHash = `sha256:${createHash("sha256").update(blob).digest("hex")}`;
      if (contentHash !== file.originalContentHash || contentHash !== snippet.contentHash) throw new Error("patch proposal contains a stale original content hash");
      const lineCount = decodeTextBlob(blob).split(/\r\n|\r|\n/).length;
      for (const operation of candidate.operations.filter((item) => item.path === file.path)) {
        if (operation.startLine < codeCandidate.range.start.line || operation.endLine > codeCandidate.range.end.line || operation.endLine > lineCount) throw new Error("replacement range is outside the bounded code candidate");
        changedLines += operation.endLine - operation.startLine + 1 + textLineCount(operation.replacement);
      }
    } else {
      assertPinnedPathAbsent(root, candidate.baseRevision, file.path);
      const operations = candidate.operations.filter((item) => item.path === file.path);
      if (operations.length !== 1) throw new Error("created files require exactly one CREATE_FILE operation");
      decodeTextBlob(Buffer.from(operations[0].content));
      changedLines += textLineCount(operations[0].content);
    }
  }
  if (changedLines > gate.maxChangedLines) throw new Error("patch proposal exceeds the changed-line limit");

  const body = { ...candidate };
  delete body.proposalId;
  return snapshotContract("PatchProposal", {
    ...body,
    proposalId: stableId("patch-proposal", body),
  }, { diagnosis: input.diagnosis, codeContext: input.codeContext, recommendation: input.recommendation });
}

export function applyPatchProposal({ proposal, repositoryRoot, cwd = repositoryRoot, policy = {}, retainOnFailure = false }) {
  const candidate = snapshotContract("PatchProposal", proposal);
  const gate = patchPolicy(policy);
  const root = repositoryAtRevision(repositoryRoot, candidate.baseRevision);
  const workspaceRoot = realpathSync(resolve(cwd));
  const qaRoot = resolve(workspaceRoot, ".qa");
  const worktreesRoot = resolve(qaRoot, "worktrees");
  if (!/^patch-proposal-[0-9a-f]{16}$/.test(candidate.proposalId)) throw new Error("patch proposal identity is invalid");
  ensurePrivateDirectory(qaRoot);
  ensurePrivateDirectory(worktreesRoot);

  const suffix = candidate.proposalId.slice("patch-proposal-".length);
  const worktreeId = `worktree-${suffix}`;
  const worktreeRelativePath = `.qa/worktrees/${worktreeId}`;
  const worktreePath = resolve(workspaceRoot, worktreeRelativePath);
  const branch = `qa/fix-${suffix}`;
  if (pathEscapes(worktreesRoot, worktreePath) || exists(worktreePath) || gitStatus(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) === 0) {
    return failedApplication(candidate, "REJECTED", "isolated worktree identity already exists");
  }

  let created = false;
  try {
    for (const file of candidate.files) {
      try { assertAllowedPatchPath(file.path, gate); } catch { throw new PatchApplicationFailure("REJECTED", `patch path is forbidden: ${file.path}`); }
    }
    const createdWorktree = spawnGit(root, ["worktree", "add", "-b", branch, worktreePath, candidate.baseRevision]);
    if (createdWorktree.status !== 0) throw new Error("git worktree add failed");
    created = true;

    const prepared = candidate.files.map((file) => prepareAppliedFile({ file, proposal: candidate, worktreePath }));
    for (const file of prepared) writeAppliedFile(file, worktreePath);
    const createdPaths = candidate.files.filter((file) => file.action === "CREATE").map((file) => file.path);
    if (createdPaths.length > 0) git(worktreePath, ["add", "--intent-to-add", "--", ...createdPaths]);
    git(worktreePath, ["diff", "--check"]);
    const names = git(worktreePath, ["diff", "--name-only", "--no-renames", "--"]).toString("utf8").trim().split("\n").filter(Boolean).sort();
    const expectedNames = candidate.files.map((file) => file.path).sort();
    if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) throw new PatchApplicationFailure("REJECTED", "applied diff contains unexpected files");
    assertDiffSummary(git(worktreePath, ["diff", "--summary", "--"]).toString("utf8"), createdPaths);

    const diff = git(worktreePath, ["diff", "--no-ext-diff", "--no-renames", "--"]);
    if (diff.includes(0)) throw new PatchApplicationFailure("REJECTED", "applied diff is binary");
    const changedLines = changedLineCount(git(worktreePath, ["diff", "--numstat", "--no-renames", "--"]).toString("utf8"));
    if (candidate.files.length > gate.maxFiles || changedLines > gate.maxChangedLines) throw new PatchApplicationFailure("REJECTED", "applied diff exceeds configured limits");
    const appliedFiles = prepared.map(({ path, action, beforeHash }) => ({
      path,
      action,
      ...(beforeHash === undefined ? {} : { beforeHash }),
      afterHash: hashBytes(readSafeWorktreeFile(worktreePath, path)),
    }));
    const body = {
      schemaVersion: PATCH_APPLICATION_RESULT_VERSION,
      proposalId: candidate.proposalId,
      baseRevision: candidate.baseRevision,
      status: "APPLIED",
      worktree: { worktreeId, path: worktreeRelativePath, branch, revision: candidate.baseRevision },
      appliedFiles,
      diff: { fileCount: appliedFiles.length, changedLines, contentHash: hashBytes(diff) },
    };
    return snapshotContract("PatchApplicationResult", { ...body, applicationId: stableId("patch-application", body) }, { proposal: candidate });
  } catch (error) {
    const status = error instanceof PatchApplicationFailure ? error.status : "ERROR";
    if (created && !retainOnFailure) cleanupWorktree(root, worktreePath, branch);
    return failedApplication(candidate, status, error instanceof PatchApplicationFailure ? error.message : "isolated patch application failed");
  }
}

export function verifyAppliedPatch({ proposal, application, cwd, config = {}, secrets = [], spawn = spawnSync, platform = process.platform, isolate = isolatedVerificationInvocation }) {
  const trustedProposal = snapshotContract("PatchProposal", proposal);
  const trustedApplication = snapshotContract("PatchApplicationResult", application, { proposal: trustedProposal });
  if (trustedApplication.status !== "APPLIED") throw new Error("only an applied patch can be verified");
  if (typeof spawn !== "function") throw new TypeError("verification spawn must be a function");
  if (typeof isolate !== "function") throw new TypeError("verification isolation must be a function");
  const policy = verificationPolicy(config);
  const workspaceRoot = realpathSync(resolve(cwd));
  const expectedPath = resolve(workspaceRoot, trustedApplication.worktree.path);
  const worktreePath = realpathSync(expectedPath);
  if (worktreePath !== expectedPath || pathEscapes(resolve(workspaceRoot, ".qa/worktrees"), worktreePath)) throw new Error("verification worktree is invalid");
  if (git(worktreePath, ["rev-parse", "HEAD"]).toString("utf8").trim() !== trustedApplication.baseRevision) throw new Error("verification worktree revision is stale");
  const initialDiff = git(worktreePath, ["diff", "--no-ext-diff", "--no-renames", "--"]);
  if (hashBytes(initialDiff) !== trustedApplication.diff.contentHash) throw new Error("verification worktree diff does not match the application result");
  const initialStatus = git(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

  const outputs = [];
  const checks = [];
  const startedAt = Date.now();
  const home = mkdtempSync(join(tmpdir(), "qa-native-verify-"));
  chmodSync(home, 0o700);
  let stopped = false;
  try {
    for (const name of VERIFICATION_STAGES) {
      const definition = policy.checks[name];
      if (stopped) {
        checks.push(notRunCheck(name, "SKIPPED"));
        continue;
      }
      if (definition === undefined) {
        checks.push(notRunCheck(name, "MISSING"));
        stopped = true;
        continue;
      }
      const elapsed = Date.now() - startedAt;
      const remaining = policy.totalTimeoutMs - elapsed;
      if (remaining <= 0) {
        checks.push({ name, required: true, status: "TIMEOUT", durationMs: 0, resourceOutcome: "TIMEOUT" });
        stopped = true;
        continue;
      }
      const timeout = Math.min(definition.timeoutMs, remaining);
      const checkStarted = Date.now();
      let invocation;
      try {
        invocation = isolate(definition, platform);
      } catch {
        checks.push({ name, required: true, status: "ERROR", durationMs: 0, resourceOutcome: "NOT_RUN" });
        stopped = true;
        continue;
      }
      const executed = spawn(invocation.command, invocation.args, {
        cwd: worktreePath,
        encoding: "buffer",
        env: verificationEnvironment(home, workspaceRoot),
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        shell: false,
      });
      const durationMs = Math.min(Date.now() - checkStarted, 3_600_000);
      const stdout = outputArtifact(name, "stdout", executed?.stdout, policy.maxOutputBytes, secrets);
      const stderr = outputArtifact(name, "stderr", executed?.stderr, policy.maxOutputBytes, secrets);
      outputs.push(stdout.output, stderr.output);
      const timedOut = executed?.error?.code === "ETIMEDOUT" || (executed?.status === null && executed?.signal === "SIGKILL");
      const outputLimited = stdout.reference.truncated || stderr.reference.truncated || executed?.error?.code === "ENOBUFS";
      const status = timedOut ? "TIMEOUT" : outputLimited || executed?.error || !Number.isInteger(executed?.status) ? "ERROR" : executed.status === 0 ? "PASS" : "FAIL";
      checks.push({
        name,
        required: true,
        status,
        ...(Number.isInteger(executed?.status) && executed.status >= 0 ? { exitCode: executed.status } : {}),
        ...(typeof executed?.signal === "string" ? { signal: executed.signal } : {}),
        durationMs,
        stdoutArtifact: stdout.reference,
        stderrArtifact: stderr.reference,
        resourceOutcome: timedOut ? "TIMEOUT" : outputLimited ? "OUTPUT_LIMIT" : "WITHIN_LIMITS",
      });
      if (status !== "PASS") stopped = true;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const finalDiff = git(worktreePath, ["diff", "--no-ext-diff", "--no-renames", "--"]);
  const finalStatus = git(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  let reason;
  if (hashBytes(finalDiff) !== trustedApplication.diff.contentHash || !finalStatus.equals(initialStatus)) {
    const index = checks.findLastIndex((check) => check.status === "PASS");
    if (index >= 0) checks[index] = { ...checks[index], status: "ERROR" };
    else if (checks.every((check) => ["MISSING", "SKIPPED"].includes(check.status))) checks[0] = { name: checks[0].name, required: true, status: "ERROR", durationMs: 0, resourceOutcome: "NOT_RUN" };
    reason = "verification commands changed the isolated patch";
  }
  const status = verificationStatus(checks);
  if (status !== "PASS" && reason === undefined) reason = verificationReason(status);
  const body = {
    schemaVersion: VERIFICATION_RESULT_VERSION,
    proposalId: trustedProposal.proposalId,
    applicationId: trustedApplication.applicationId,
    worktreeRevision: trustedApplication.baseRevision,
    diffHash: trustedApplication.diff.contentHash,
    status,
    checks,
    ...(reason === undefined ? {} : { reason }),
  };
  const result = snapshotContract("VerificationResult", { ...body, verificationId: stableId("verification", body) }, { proposal: trustedProposal, application: trustedApplication });
  return Object.freeze({ result, outputs: Object.freeze(outputs) });
}

export function compareEvidence({ proposal, application, verification, before, after }) {
  const trustedProposal = snapshotContract("PatchProposal", proposal);
  const trustedApplication = snapshotContract("PatchApplicationResult", application, { proposal: trustedProposal });
  const trustedVerification = snapshotContract("VerificationResult", verification, { proposal: trustedProposal, application: trustedApplication });
  if (trustedVerification.status !== "PASS") throw new Error("live comparison requires passing deterministic verification");
  const beforeSnapshot = comparisonSide(before, "before");
  const afterSnapshot = comparisonSide(after, "after");
  validateContract("JudgeResult", beforeSnapshot.judgeResult, { qaIr: beforeSnapshot.qaIr, evidenceBundle: beforeSnapshot.evidenceBundle });
  validateContract("JudgeResult", afterSnapshot.judgeResult, { qaIr: afterSnapshot.qaIr, evidenceBundle: afterSnapshot.evidenceBundle });
  verifyEvidenceBundleIdentity(beforeSnapshot.evidenceBundle);
  verifyEvidenceBundleIdentity(afterSnapshot.evidenceBundle);

  const beforeFailures = failedExpectationIds(beforeSnapshot.judgeResult);
  const afterFailures = failedExpectationIds(afterSnapshot.judgeResult);
  const fixedExpectationIds = [...beforeFailures].filter((id) => !afterFailures.has(id)).sort();
  const newlyFailedExpectationIds = [...afterFailures].filter((id) => !beforeFailures.has(id)).sort();
  const unchangedFailureIds = [...beforeFailures].filter((id) => afterFailures.has(id)).sort();
  const requiredMilestoneIds = requiredMilestones(beforeSnapshot.qaIr, beforeSnapshot.evidenceBundle.scenarioId);
  const preservedMilestoneIds = requiredMilestoneIds.filter((id) => afterSnapshot.completedMilestoneIds.includes(id));
  const beforeScenario = scenarioFor(beforeSnapshot.qaIr, beforeSnapshot.evidenceBundle.scenarioId);
  const afterScenario = scenarioFor(afterSnapshot.qaIr, afterSnapshot.evidenceBundle.scenarioId);
  const beforePolicyHash = canonicalHash(beforeScenario.policy);
  const afterPolicyHash = canonicalHash(afterScenario.policy);
  const policyChanges = beforePolicyHash === afterPolicyHash ? [] : [{ scenarioId: beforeScenario.id, beforeHash: beforePolicyHash, afterHash: afterPolicyHash }];
  const beforeRoute = comparisonRoute(beforeSnapshot.evidenceBundle.environment.targetUrl);
  const afterRoute = comparisonRoute(afterSnapshot.evidenceBundle.environment.targetUrl);
  const routeChanges = beforeRoute === afterRoute ? [] : [{ before: beforeRoute, after: afterRoute }];
  const inconclusiveReasons = [];
  const beforeQaIrHash = canonicalHash(beforeSnapshot.qaIr);
  const afterQaIrHash = canonicalHash(afterSnapshot.qaIr);
  if (!beforeSnapshot.authenticated || !afterSnapshot.authenticated) inconclusiveReasons.push("before and after evidence must be authenticated");
  if (beforeSnapshot.evidenceBundle.runId === afterSnapshot.evidenceBundle.runId) inconclusiveReasons.push("the live rerun must use a distinct run identity");
  if (beforeSnapshot.evidenceBundle.scenarioId !== afterSnapshot.evidenceBundle.scenarioId) inconclusiveReasons.push("the live rerun used a different scenario");
  if (beforeQaIrHash !== afterQaIrHash || policyChanges.length > 0) inconclusiveReasons.push("the live rerun used different QA IR or policy");
  if (preservedMilestoneIds.length !== requiredMilestoneIds.length) inconclusiveReasons.push("required exact-action or semantic milestones were not preserved");
  if (!["PASS", "FAIL"].includes(afterSnapshot.judgeResult.verdict)) inconclusiveReasons.push("the independent after Judge did not produce a conclusive verdict");
  const conclusion = inconclusiveReasons.length > 0
    ? "INCONCLUSIVE"
    : newlyFailedExpectationIds.length > 0
      ? "REGRESSED"
      : fixedExpectationIds.length > 0 && afterSnapshot.judgeResult.verdict === "PASS"
        ? "IMPROVED"
        : "UNCHANGED";
  const body = {
    schemaVersion: EVIDENCE_COMPARISON_VERSION,
    proposalId: trustedProposal.proposalId,
    applicationId: trustedApplication.applicationId,
    verificationId: trustedVerification.verificationId,
    before: comparisonReference(beforeSnapshot, beforeQaIrHash),
    after: comparisonReference(afterSnapshot, afterQaIrHash),
    fixedExpectationIds,
    newlyFailedExpectationIds,
    unchangedFailureIds,
    requiredMilestoneIds,
    preservedMilestoneIds,
    policyChanges,
    routeChanges,
    conclusion,
    inconclusiveReasons,
  };
  return snapshotContract("EvidenceComparison", { ...body, comparisonId: stableId("evidence-comparison", body) }, { proposal: trustedProposal, application: trustedApplication, verification: trustedVerification });
}

export async function rerunLiveScenario({ proposal, application, verification, before, rerun, judge }) {
  if (typeof rerun !== "function" || typeof judge !== "function" || rerun === judge) throw new TypeError("live rerun and Judge must be separate invocations");
  const trustedProposal = snapshotContract("PatchProposal", proposal);
  const trustedApplication = snapshotContract("PatchApplicationResult", application, { proposal: trustedProposal });
  const trustedVerification = snapshotContract("VerificationResult", verification, { proposal: trustedProposal, application: trustedApplication });
  if (trustedVerification.status !== "PASS") throw new Error("live rerun requires passing deterministic verification");
  const beforeSnapshot = comparisonSide(before, "before");
  if (!beforeSnapshot.authenticated) throw new Error("live rerun requires authenticated before evidence");
  verifyEvidenceBundleIdentity(beforeSnapshot.evidenceBundle);
  validateContract("JudgeResult", beforeSnapshot.judgeResult, { qaIr: beforeSnapshot.qaIr, evidenceBundle: beforeSnapshot.evidenceBundle });
  const request = Object.freeze({
    scenarioId: beforeSnapshot.evidenceBundle.scenarioId,
    qaIrHash: canonicalHash(beforeSnapshot.qaIr),
    sourcePath: beforeSnapshot.qaIr.source.uri,
    targetOrigin: comparisonOrigin(beforeSnapshot.evidenceBundle.environment.targetUrl),
    worktreePath: trustedApplication.worktree.path,
    baseRevision: trustedApplication.baseRevision,
  });
  const executed = await rerun(request);
  if (!executed || typeof executed !== "object" || Object.keys(executed).some((key) => !["qaIr", "evidenceBundle", "authenticated", "completedMilestoneIds", "judgeInput"].includes(key))) throw new Error("live rerun returned invalid evidence");
  const qaIr = snapshotContract("QaIrDocument", executed.qaIr);
  const evidenceBundle = snapshotContract("EvidenceBundle", executed.evidenceBundle);
  verifyEvidenceBundleIdentity(evidenceBundle);
  if (evidenceBundle.scenarioId !== request.scenarioId || evidenceBundle.runId === beforeSnapshot.evidenceBundle.runId) throw new Error("live rerun scenario identity is invalid");
  if (typeof executed.authenticated !== "boolean" || !Array.isArray(executed.completedMilestoneIds)) throw new Error("live rerun authentication metadata is invalid");
  const judged = await judge(Object.freeze({ qaIr, evidenceBundle, judgeInput: executed.judgeInput }));
  const judgeResult = snapshotContract("JudgeResult", judged, { qaIr, evidenceBundle });
  const after = { qaIr, evidenceBundle, judgeResult, authenticated: executed.authenticated, completedMilestoneIds: executed.completedMilestoneIds };
  return Object.freeze({ after: Object.freeze(after), comparison: compareEvidence({ proposal: trustedProposal, application: trustedApplication, verification: trustedVerification, before: beforeSnapshot, after }) });
}

export function checkExpectationIntegrity({ proposal, application, verification, comparison, beforeQaIr, afterQaIr, cwd }) {
  const trustedProposal = snapshotContract("PatchProposal", proposal);
  const trustedApplication = snapshotContract("PatchApplicationResult", application, { proposal: trustedProposal });
  const trustedVerification = snapshotContract("VerificationResult", verification, { proposal: trustedProposal, application: trustedApplication });
  const trustedComparison = snapshotContract("EvidenceComparison", comparison, { proposal: trustedProposal, application: trustedApplication, verification: trustedVerification });
  const before = snapshotContract("QaIrDocument", beforeQaIr);
  const after = snapshotContract("QaIrDocument", afterQaIr);
  const beforeQaIrHash = canonicalHash(before);
  const afterQaIrHash = canonicalHash(after);
  if (beforeQaIrHash !== trustedComparison.before.qaIrHash || afterQaIrHash !== trustedComparison.after.qaIrHash) throw new Error("integrity QA IR does not match the evidence comparison");
  const workspaceRoot = realpathSync(resolve(cwd));
  const worktreePath = realpathSync(resolve(workspaceRoot, trustedApplication.worktree.path));
  if (pathEscapes(resolve(workspaceRoot, ".qa/worktrees"), worktreePath)) throw new Error("integrity worktree is invalid");
  const diff = git(worktreePath, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-renames", "--unified=0", "--"]);
  const canonicalDiff = git(worktreePath, ["diff", "--no-ext-diff", "--no-renames", "--"]);
  if (hashBytes(canonicalDiff) !== trustedApplication.diff.contentHash) throw new Error("integrity diff does not match the application result");
  const entries = parseUnifiedDiff(diff.toString("utf8"));
  const findings = Object.fromEntries(INTEGRITY_RULES.map((rule) => [rule, []]));
  const suspiciousRanges = [];
  const structuralPath = integritySourcePath(before, trustedProposal);
  const addFinding = (rule, reason, entry, status = "FAIL") => {
    findings[rule].push({ status, reason });
    if (entry) suspiciousRanges.push({ path: entry.path, startLine: entry.line, endLine: entry.line, rule, reason });
  };

  for (const entry of entries.filter((item) => item.type === "add")) {
    if (/\b(?:test|describe)\.(?:skip|only)\b|\b(?:live[-_ ]?skip|qa[-_ ]?skip)\b/i.test(entry.text)) addFinding("SKIP_OR_ONLY", "skip/only or live-skip was added", entry);
    if (isTestPath(entry.path) && /\bif\s*\(/.test(entry.text)) addFinding("CONDITIONAL_BYPASS", "conditional logic was added in a test or QA source", entry);
    if (isTestPath(entry.path) && /\bcatch\b|\.catch\s*\(/.test(entry.text)) addFinding("SWALLOWED_ERROR", "catch/error swallowing was added in a test or QA source", entry);
    if (/\b(?:verdict|status|result)\s*[:=]\s*["'](?:PASS|MANUAL_REVIEW)["']|\breturn\s+["'](?:PASS|MANUAL_REVIEW)["']/i.test(entry.text)) addFinding("FORCED_RESULT", "forced PASS or MANUAL_REVIEW result was added", entry);
    if (/\b(?:verificationRequired|requiredVerification)\s*[:=]\s*false\b/i.test(entry.text)) addFinding("GATE_LOWERING", "a required verification gate was disabled", entry);
  }

  for (const [path, changes] of groupDiffEntries(entries)) {
    const removedAssertions = changes.filter((entry) => entry.type === "remove" && assertionLine(entry.text)).length;
    const addedAssertions = changes.filter((entry) => entry.type === "add" && assertionLine(entry.text)).length;
    if (removedAssertions > addedAssertions) addFinding("ASSERTION_REMOVAL", "assertion count was reduced without an in-diff replacement", changes.find((entry) => entry.type === "remove" && assertionLine(entry.text)) ?? { path, line: 1 });
    const removedTimeout = maximumConfiguredNumber(changes, "remove", /\b(?:setTimeout|timeout|retries)\b\D{0,20}(\d+)/gi);
    const addedTimeout = maximumConfiguredNumber(changes, "add", /\b(?:setTimeout|timeout|retries)\b\D{0,20}(\d+)/gi);
    if (addedTimeout !== undefined && (removedTimeout === undefined || addedTimeout > removedTimeout)) addFinding("TIMEOUT_RETRY_INFLATION", "timeout or retry limit was increased", changes.find((entry) => entry.type === "add" && /\b(?:setTimeout|timeout|retries)\b/i.test(entry.text)));
    const removedConfidence = maximumConfiguredNumber(changes, "remove", /\b(?:minimumConfidence|confidenceThreshold)\b\D{0,20}(\d+(?:\.\d+)?)/gi);
    const addedConfidence = maximumConfiguredNumber(changes, "add", /\b(?:minimumConfidence|confidenceThreshold)\b\D{0,20}(\d+(?:\.\d+)?)/gi);
    if (addedConfidence !== undefined && removedConfidence !== undefined && addedConfidence < removedConfidence) addFinding("GATE_LOWERING", "a confidence threshold was lowered", changes.find((entry) => entry.type === "add" && /confidence/i.test(entry.text)));
  }

  const beforeExpectations = qaExpectations(before);
  const afterExpectations = qaExpectations(after);
  const removedExpectationIds = [...beforeExpectations.keys()].filter((id) => !afterExpectations.has(id)).sort();
  for (const id of removedExpectationIds) addFinding("EXPECTATION_STRENGTH", `required expectation was removed: ${id}`, { path: structuralPath, line: 1 });
  const modifiedSemanticStrength = [];
  for (const [id, expectation] of beforeExpectations) {
    const updated = afterExpectations.get(id);
    if (!updated || canonicalHash(expectation) === canonicalHash(updated)) continue;
    const beforeStrength = expectationStrength(expectation);
    const afterStrength = expectationStrength(updated);
    const reason = afterStrength < beforeStrength ? "expectation semantic strength decreased" : "expectation semantics changed and require review";
    modifiedSemanticStrength.push({ expectationId: id, beforeStrength, afterStrength, reason });
    addFinding("EXPECTATION_STRENGTH", `${reason}: ${id}`, { path: structuralPath, line: 1 }, afterStrength < beforeStrength ? "FAIL" : "MANUAL_REVIEW");
  }
  compareMilestones(before, after, (reason) => addFinding("MILESTONE_STRENGTH", reason, { path: structuralPath, line: 1 }));
  compareQaPolicies(before, after, (reason) => addFinding("QA_POLICY_WEAKENING", reason, { path: structuralPath, line: 1 }));
  if (beforeQaIrHash !== afterQaIrHash) addFinding("QA_IR_CHANGE", "recompiled QA IR changed and requires human review", { path: structuralPath, line: 1 }, "MANUAL_REVIEW");

  const ruleResults = INTEGRITY_RULES.map((rule) => {
    const matches = findings[rule];
    const status = matches.some((finding) => finding.status === "FAIL") ? "FAIL" : matches.length > 0 ? "MANUAL_REVIEW" : "PASS";
    return { rule, status, matches: matches.length };
  });
  const body = {
    schemaVersion: EXPECTATION_INTEGRITY_RESULT_VERSION,
    proposalId: trustedProposal.proposalId,
    applicationId: trustedApplication.applicationId,
    comparisonId: trustedComparison.comparisonId,
    weakened: ruleResults.some((rule) => rule.status === "FAIL"),
    manualReview: ruleResults.some((rule) => rule.status === "MANUAL_REVIEW"),
    removedExpectationIds,
    modifiedSemanticStrength,
    suspiciousRanges,
    beforeQaIrHash,
    afterQaIrHash,
    ruleResults,
  };
  return snapshotContract("ExpectationIntegrityResult", { ...body, integrityId: stableId("expectation-integrity", body) }, { proposal: trustedProposal, application: trustedApplication, verification: trustedVerification, comparison: trustedComparison });
}

export async function createIndependentRemediationReview({ diagnosis, codeContext, recommendation, proposal, application, verification, comparison, integrity, generatorIdentity, reviewerIdentity, reviewer, cwd, secrets = [] }) {
  const trustedDiagnosis = snapshotContract("FailureDiagnosis", diagnosis);
  const trustedCodeContext = snapshotContract("CodeContextBundle", codeContext);
  const trustedRecommendation = snapshotContract("RepairRecommendation", recommendation, { diagnosis: trustedDiagnosis, codeContext: trustedCodeContext });
  const trustedProposal = snapshotContract("PatchProposal", proposal, { diagnosis: trustedDiagnosis, codeContext: trustedCodeContext, recommendation: trustedRecommendation });
  const trustedApplication = snapshotContract("PatchApplicationResult", application, { proposal: trustedProposal });
  const trustedVerification = snapshotContract("VerificationResult", verification, { proposal: trustedProposal, application: trustedApplication });
  const trustedComparison = snapshotContract("EvidenceComparison", comparison, { proposal: trustedProposal, application: trustedApplication, verification: trustedVerification });
  const trustedIntegrity = snapshotContract("ExpectationIntegrityResult", integrity, { proposal: trustedProposal, application: trustedApplication, verification: trustedVerification, comparison: trustedComparison });
  const generator = reviewIdentity(generatorIdentity, "generator");
  const reviewerActor = reviewIdentity(reviewerIdentity, "reviewer");
  if (generator.invocationId === reviewerActor.invocationId) throw new Error("independent reviewer cannot use the patch generator invocation");
  if (typeof reviewer !== "function") throw new TypeError("independent reviewer invocation is required");
  const workspaceRoot = realpathSync(resolve(cwd));
  const worktreePath = realpathSync(resolve(workspaceRoot, trustedApplication.worktree.path));
  if (pathEscapes(resolve(workspaceRoot, ".qa/worktrees"), worktreePath)) throw new Error("review worktree is invalid");
  const diff = git(worktreePath, ["diff", "--no-ext-diff", "--no-renames", "--"]);
  if (hashBytes(diff) !== trustedApplication.diff.contentHash) throw new Error("review diff does not match the application result");
  const referenceHashes = {
    proposal: canonicalHash(trustedProposal),
    application: canonicalHash(trustedApplication),
    verification: canonicalHash(trustedVerification),
    comparison: canonicalHash(trustedComparison),
    integrity: canonicalHash(trustedIntegrity),
    diff: trustedApplication.diff.contentHash,
  };
  const redactedDiff = redactSensitiveText(diff.toString("utf8"), secrets);
  const common = {
    schemaVersion: INDEPENDENT_REMEDIATION_REVIEW_VERSION,
    proposalId: trustedProposal.proposalId,
    applicationId: trustedApplication.applicationId,
    verificationId: trustedVerification.verificationId,
    comparisonId: trustedComparison.comparisonId,
    integrityId: trustedIntegrity.integrityId,
    generator,
    reviewer: reviewerActor,
    referenceHashes,
  };
  if (Buffer.byteLength(redactedDiff) > 65_536) return independentReviewResult(common, { decision: "MANUAL_REVIEW", confidence: 0, risks: ["Applied diff exceeds the independent-review input limit."], unsupportedClaims: [], rationale: "Independent review requires a bounded diff." }, { proposal: trustedProposal, application: trustedApplication, verification: trustedVerification, comparison: trustedComparison, integrity: trustedIntegrity });
  const input = Object.freeze({
    schemaVersion: "independent-remediation-review-input/0.1",
    diagnosis: trustedDiagnosis,
    codeContext: trustedCodeContext,
    recommendation: trustedRecommendation,
    proposal: trustedProposal,
    appliedDiff: redactedDiff,
    verification: trustedVerification,
    comparison: trustedComparison,
    integrity: trustedIntegrity,
    referenceHashes: Object.freeze(referenceHashes),
  });
  let raw;
  try {
    raw = await reviewer(input);
  } catch {
    return independentReviewResult(common, { decision: "MANUAL_REVIEW", confidence: 0, risks: ["Independent reviewer invocation failed."], unsupportedClaims: [], rationale: "Provider failure requires manual review." }, { proposal: trustedProposal, application: trustedApplication, verification: trustedVerification, comparison: trustedComparison, integrity: trustedIntegrity });
  }
  const serialized = JSON.stringify(raw);
  if (serialized === undefined || Buffer.byteLength(serialized) > 128 * 1024) throw new Error("independent reviewer output is invalid or oversized");
  const candidate = JSON.parse(serialized);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || Object.keys(candidate).some((key) => !["decision", "confidence", "risks", "unsupportedClaims", "rationale", "referenceHashes"].includes(key))) throw new Error("independent reviewer output is invalid");
  if (canonicalHash(candidate.referenceHashes) !== canonicalHash(referenceHashes)) throw new Error("independent reviewer references do not match immutable artifacts");
  const redacted = redactModelValue(candidate, Object.freeze([...secrets].filter(Boolean).map(String)));
  if (canonicalHash(candidate) !== canonicalHash(redacted)) throw new Error("independent reviewer output contains sensitive content");
  const risks = [...new Set([...(redacted.risks ?? []), ...(generator.provider === reviewerActor.provider && generator.model === reviewerActor.model ? ["Reviewer uses the same provider/model configuration through a distinct invocation."] : [])])];
  return independentReviewResult(common, { ...redacted, risks }, { proposal: trustedProposal, application: trustedApplication, verification: trustedVerification, comparison: trustedComparison, integrity: trustedIntegrity });
}

export function decidePublication({ repository, publicationFingerprint, diagnosis, codeContext, recommendation, proposal, application, verification, comparison, integrity, review, existingPublications = [], currentSourcePublished = false, policy = {} }) {
  const trustedDiagnosis = snapshotContract("FailureDiagnosis", diagnosis);
  const trustedCodeContext = snapshotContract("CodeContextBundle", codeContext);
  if (trustedCodeContext.failureDiagnosisId !== trustedDiagnosis.diagnosisId || trustedCodeContext.repositoryId.toLowerCase() !== String(repository).toLowerCase()) throw new Error("publication Code Context repository binding is invalid");
  const trustedRecommendation = recommendation === undefined ? undefined : snapshotContract("RepairRecommendation", recommendation, { diagnosis: trustedDiagnosis, codeContext: trustedCodeContext });
  const trustedProposal = proposal === undefined ? undefined : snapshotContract("PatchProposal", proposal, { diagnosis: trustedDiagnosis, codeContext: trustedCodeContext, recommendation: trustedRecommendation });
  const trustedApplication = application === undefined ? undefined : snapshotContract("PatchApplicationResult", application, { proposal: trustedProposal });
  const trustedVerification = verification === undefined ? undefined : snapshotContract("VerificationResult", verification, { proposal: trustedProposal, application: trustedApplication });
  const trustedComparison = comparison === undefined ? undefined : snapshotContract("EvidenceComparison", comparison, { proposal: trustedProposal, application: trustedApplication, verification: trustedVerification });
  const trustedIntegrity = integrity === undefined ? undefined : snapshotContract("ExpectationIntegrityResult", integrity, { proposal: trustedProposal, application: trustedApplication, verification: trustedVerification, comparison: trustedComparison });
  const trustedReview = review === undefined ? undefined : snapshotContract("IndependentRemediationReview", review, { proposal: trustedProposal, application: trustedApplication, verification: trustedVerification, comparison: trustedComparison, integrity: trustedIntegrity });
  if ((trustedProposal && !trustedRecommendation) || (trustedApplication && !trustedProposal) || (trustedVerification && !trustedApplication) || (trustedComparison && !trustedVerification) || (trustedIntegrity && !trustedComparison) || (trustedReview && !trustedIntegrity)) throw new Error("publication artifact chain is incomplete or out of order");
  const minimumConfidence = publicationPolicy(policy);
  const existingTargets = normalizePublicationTargets(existingPublications, repository);
  if (typeof currentSourcePublished !== "boolean" || (currentSourcePublished && existingTargets.length !== 1)) throw new TypeError("publication recurrence state is invalid");
  const gates = [
    publicationGate("ORIGIN", ["PRODUCT_CODE", "TEST_CODE"].includes(trustedDiagnosis.origin), `origin ${trustedDiagnosis.origin} ${["PRODUCT_CODE", "TEST_CODE"].includes(trustedDiagnosis.origin) ? "is" : "is not"} Draft-PR eligible`),
    publicationGate("CONFIDENCE", trustedDiagnosis.confidence >= minimumConfidence, `diagnosis confidence must be at least ${minimumConfidence}`),
    publicationGate("LOCATION", trustedCodeContext.candidates.length === 1 && trustedCodeContext.snippets.length === 1, "exactly one pinned code location is required"),
    stagePublicationGate("PATCH_APPLICATION", trustedApplication, trustedApplication?.status === "APPLIED", "an isolated applied patch is required"),
    stagePublicationGate("DETERMINISTIC_VERIFICATION", trustedVerification, trustedVerification?.status === "PASS", "all trusted deterministic checks must pass"),
    stagePublicationGate("LIVE_COMPARISON", trustedComparison, trustedComparison?.conclusion === "IMPROVED" && trustedComparison.newlyFailedExpectationIds.length === 0, "the original live scenario must improve without new failures"),
    stagePublicationGate("EXPECTATION_INTEGRITY", trustedIntegrity, trustedIntegrity && !trustedIntegrity.weakened && !trustedIntegrity.manualReview, "expectation integrity must pass without manual-review findings"),
    stagePublicationGate("INDEPENDENT_REVIEW", trustedReview, trustedReview?.decision === "APPROVE_DRAFT", "an independent reviewer must approve the Draft PR"),
    publicationGate("PUBLICATION_MATCH", existingTargets.length <= 1, "publication fingerprint must resolve to at most one open target"),
  ];
  const eligibleDraft = gates.every((gate) => gate.status === "PASS");
  const target = existingTargets[0];
  let action;
  let publication;
  if (currentSourcePublished) {
    action = "NOOP";
    publication = "NONE";
  } else if (existingTargets.length > 1 || (!eligibleDraft && target?.publication === "DRAFT_PR")) {
    action = "MANUAL_REVIEW";
    publication = "NONE";
  } else if (eligibleDraft && target?.publication === "DRAFT_PR") {
    action = "UPDATE_DRAFT_PR";
    publication = "DRAFT_PR";
  } else if (eligibleDraft && target?.publication === "ISSUE") {
    action = "UPDATE_ISSUE";
    publication = "ISSUE";
  } else if (eligibleDraft) {
    action = "CREATE_DRAFT_PR";
    publication = "DRAFT_PR";
  } else if (target?.publication === "ISSUE") {
    action = "UPDATE_ISSUE";
    publication = "ISSUE";
  } else {
    action = "CREATE_ISSUE";
    publication = "ISSUE";
  }
  const source = {
    diagnosisId: trustedDiagnosis.diagnosisId,
    codeContextBundleId: trustedCodeContext.bundleId,
    ...(trustedRecommendation ? { repairRecommendationId: trustedRecommendation.recommendationId } : {}),
    ...(trustedProposal ? { proposalId: trustedProposal.proposalId } : {}),
    ...(trustedApplication ? { applicationId: trustedApplication.applicationId } : {}),
    ...(trustedVerification ? { verificationId: trustedVerification.verificationId } : {}),
    ...(trustedComparison ? { comparisonId: trustedComparison.comparisonId } : {}),
    ...(trustedIntegrity ? { integrityId: trustedIntegrity.integrityId } : {}),
    ...(trustedReview ? { reviewId: trustedReview.reviewId } : {}),
  };
  const body = {
    schemaVersion: PUBLICATION_DECISION_VERSION,
    repository,
    action,
    publication,
    eligibleDraft,
    publicationFingerprint,
    source,
    gates,
    existingTargets,
    ...(["UPDATE_ISSUE", "UPDATE_DRAFT_PR", "NOOP"].includes(action) ? { target } : {}),
    ...(eligibleDraft && trustedApplication ? { branch: trustedApplication.worktree.branch, baseRevision: trustedApplication.baseRevision } : {}),
  };
  return snapshotContract("PublicationDecision", { ...body, decisionId: stableId("publication-decision", body) });
}

function classifyOrigin(bundle, evidenceRefs, hasContradiction) {
  const referenced = new Set(evidenceRefs);
  for (const fact of bundle.facts) {
    if (referenced.has(fact.id) && ORIGIN_BY_FACT_KIND.has(fact.kind)) return ORIGIN_BY_FACT_KIND.get(fact.kind);
  }
  return hasContradiction ? "PRODUCT_CODE" : "UNKNOWN";
}

function verificationPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["checks", "perCommandTimeoutMs", "totalTimeoutMs", "maxOutputBytes"].includes(key))) throw new TypeError("verification config is invalid");
  const checks = value.checks ?? {};
  if (!checks || typeof checks !== "object" || Array.isArray(checks) || Object.keys(checks).some((name) => !VERIFICATION_STAGES.includes(name))) throw new TypeError("verification checks are invalid");
  const configured = { ...DEFAULT_VERIFICATION_POLICY, ...value };
  for (const key of ["perCommandTimeoutMs", "totalTimeoutMs", "maxOutputBytes"]) {
    if (!Number.isInteger(configured[key]) || configured[key] < 1) throw new TypeError(`verification ${key} is invalid`);
  }
  const policy = {
    perCommandTimeoutMs: Math.min(configured.perCommandTimeoutMs, DEFAULT_VERIFICATION_POLICY.perCommandTimeoutMs),
    totalTimeoutMs: Math.min(configured.totalTimeoutMs, DEFAULT_VERIFICATION_POLICY.totalTimeoutMs),
    maxOutputBytes: Math.min(configured.maxOutputBytes, DEFAULT_VERIFICATION_POLICY.maxOutputBytes),
    checks: {},
  };
  for (const [name, definition] of Object.entries(checks)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition) || Object.keys(definition).some((key) => !["command", "args", "timeoutMs"].includes(key))) throw new TypeError(`verification check ${name} is invalid`);
    if (!VERIFICATION_EXECUTABLES.has(definition.command) || !Array.isArray(definition.args) || definition.args.length > 100 || definition.args.some((arg) => typeof arg !== "string" || arg.length > 1_000 || /[\0\r\n]/.test(arg))) throw new TypeError(`verification check ${name} is invalid`);
    const timeoutMs = definition.timeoutMs ?? policy.perCommandTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError(`verification check ${name} timeout is invalid`);
    policy.checks[name] = Object.freeze({ command: definition.command, args: Object.freeze([...definition.args]), timeoutMs: Math.min(timeoutMs, policy.perCommandTimeoutMs) });
  }
  return Object.freeze({ ...policy, checks: Object.freeze(policy.checks) });
}

function isolatedVerificationInvocation(definition, platform) {
  if (platform === "darwin" && exists("/usr/bin/sandbox-exec")) {
    return { command: "/usr/bin/sandbox-exec", args: ["-p", "(version 1)(allow default)(deny network*)", definition.command, ...definition.args] };
  }
  const unshare = ["/usr/bin/unshare", "/bin/unshare"].find(exists);
  if (platform === "linux" && unshare) return { command: unshare, args: ["--user", "--map-root-user", "--net", "--", definition.command, ...definition.args] };
  throw new PatchApplicationFailure("ERROR", "deterministic verification network isolation is unavailable");
}

function verificationEnvironment(home, workspaceRoot) {
  const path = [join(workspaceRoot, "node_modules", ".bin"), process.env.PATH].filter(Boolean).join(":");
  return {
    PATH: path,
    HOME: home,
    TMPDIR: home,
    TEMP: home,
    TMP: home,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_offline: "true",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
  };
}

function outputArtifact(check, stream, raw, limit, secrets) {
  const original = raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.alloc(0);
  const redacted = Buffer.from(redactSensitiveText(original.toString("utf8"), secrets), "utf8");
  const truncated = original.byteLength > limit || redacted.byteLength > limit;
  let content = truncated ? new TextDecoder("utf8").decode(redacted.subarray(0, limit)) : redacted.toString("utf8");
  while (Buffer.byteLength(content) > limit) content = content.slice(0, -1);
  const bytes = Buffer.from(content, "utf8");
  const contentHash = hashBytes(bytes);
  const artifactId = `verification-output-${check}-${stream}-${contentHash.slice("sha256:".length, "sha256:".length + 16)}`;
  return {
    reference: { artifactId, contentHash, size: bytes.byteLength, truncated },
    output: Object.freeze({ artifactId, content }),
  };
}

function notRunCheck(name, status) {
  return { name, required: true, status, durationMs: 0, resourceOutcome: "NOT_RUN" };
}

function verificationStatus(checks) {
  if (checks.some((check) => check.required && ["FAIL", "TIMEOUT"].includes(check.status))) return "FAILED";
  if (checks.some((check) => check.required && check.status === "ERROR")) return "ERROR";
  if (checks.some((check) => check.required && ["MISSING", "SKIPPED"].includes(check.status))) return "MANUAL_REVIEW";
  return "PASS";
}

function verificationReason(status) {
  if (status === "FAILED") return "a required deterministic check failed or timed out";
  if (status === "ERROR") return "deterministic verification could not complete safely";
  return "required deterministic verification commands are missing";
}

function comparisonSide(value, label) {
  if (!value || typeof value !== "object" || !Array.isArray(value.completedMilestoneIds) || value.completedMilestoneIds.some((id) => typeof id !== "string")) throw new TypeError(`${label} live evidence input is invalid`);
  const qaIr = snapshotContract("QaIrDocument", value.qaIr);
  const evidenceBundle = snapshotContract("EvidenceBundle", value.evidenceBundle);
  const judgeResult = snapshotContract("JudgeResult", value.judgeResult, { qaIr, evidenceBundle });
  if (typeof value.authenticated !== "boolean") throw new TypeError(`${label} live evidence authentication is invalid`);
  return Object.freeze({ qaIr, evidenceBundle, judgeResult, authenticated: value.authenticated, completedMilestoneIds: Object.freeze([...new Set(value.completedMilestoneIds)]) });
}

function failedExpectationIds(judgeResult) {
  return new Set(judgeResult.expectationResults.filter((result) => ["CONTRADICTED", "NOT_OBSERVED", "AMBIGUOUS"].includes(result.status)).map((result) => result.expectationId));
}

function scenarioFor(qaIr, scenarioId) {
  const scenario = qaIr.suites.flatMap((suite) => suite.scenarios).find((item) => item.id === scenarioId);
  if (!scenario) throw new Error("live evidence scenario is not present in QA IR");
  return scenario;
}

function requiredMilestones(qaIr, scenarioId) {
  return scenarioFor(qaIr, scenarioId).steps
    .filter((step) => ["REQUIRED_EXACT_ACTION", "REQUIRED_SEMANTIC_MILESTONE"].includes(step.milestoneClass))
    .map((step) => step.id)
    .sort();
}

function comparisonRoute(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "unavailable";
    return `${url.origin}${url.pathname}`.slice(0, 4_096);
  } catch {
    return "unavailable";
  }
}

function comparisonOrigin(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    return url.origin;
  } catch {
    throw new Error("live evidence target origin is invalid");
  }
}

function comparisonReference(side, qaIrHash) {
  return {
    runId: side.evidenceBundle.runId,
    evidenceBundleId: side.evidenceBundle.bundleId,
    judgeResultId: side.judgeResult.resultId,
    qaIrHash,
    authenticated: side.authenticated,
  };
}

function parseUnifiedDiff(value) {
  const entries = [];
  let path;
  let oldLine = 0;
  let newLine = 0;
  for (const line of value.split("\n")) {
    if (line.startsWith("+++ ")) {
      const name = line.slice(4).trim();
      path = name === "/dev/null" ? undefined : name.replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!path || line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      entries.push({ path, line: Math.max(newLine, 1), type: "add", text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-")) {
      entries.push({ path, line: Math.max(newLine, 1), type: "remove", text: line.slice(1) });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return entries;
}

function groupDiffEntries(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    if (!grouped.has(entry.path)) grouped.set(entry.path, []);
    grouped.get(entry.path).push(entry);
  }
  return grouped;
}

function assertionLine(value) {
  return /\b(?:expect|assert(?:Equals?|That)?|toBe|toEqual|toMatch|toContain)\s*\(/.test(value);
}

function isTestPath(path) {
  return /(?:^|\/)(?:__tests__|tests?|e2e|qa)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(path);
}

function maximumConfiguredNumber(entries, type, pattern) {
  const values = [];
  for (const entry of entries.filter((item) => item.type === type)) {
    const matcher = new RegExp(pattern.source, pattern.flags);
    for (const match of entry.text.matchAll(matcher)) values.push(Number(match[1]));
  }
  return values.length === 0 ? undefined : Math.max(...values);
}

function qaExpectations(qaIr) {
  return new Map(qaIr.suites.flatMap((suite) => suite.scenarios.flatMap((scenario) => scenario.expectations.map((expectation) => [expectation.id, expectation]))));
}

function expectationStrength(expectation) {
  const kindStrength = { ATTRIBUTE: 30, URL: 30, URL_MATCH: 28, NAME: 28, ROLE: 28, CONTAINS_TEXT: 26, VISIBLE_TEXT: 24, VISUAL_CONSISTENCY: 22, VISUAL_STABILITY: 22, VISIBLE: 18, NOT_VISIBLE: 18, PRESENT: 12 };
  let score = kindStrength[expectation.kind] ?? 0;
  const target = expectation.target ?? {};
  if (target.testId !== undefined) score += 10;
  if (target.role !== undefined) score += 6;
  for (const key of ["accessibleName", "text"]) {
    if (target[key]?.kind === "literal") score += 8;
    else if (target[key]?.kind === "regex") score += 4;
  }
  for (const key of ["expected", "text", "value", "attribute", "url"]) if (expectation[key] !== undefined) score += 4;
  return Math.min(score, 100);
}

function compareMilestones(beforeQaIr, afterQaIr, finding) {
  const afterScenarios = new Map(afterQaIr.suites.flatMap((suite) => suite.scenarios.map((scenario) => [scenario.id, scenario])));
  const rank = { REQUIRED_EXACT_ACTION: 2, REQUIRED_SEMANTIC_MILESTONE: 1, OPTIONAL_HINT: 0 };
  for (const beforeScenario of beforeQaIr.suites.flatMap((suite) => suite.scenarios)) {
    const afterScenario = afterScenarios.get(beforeScenario.id);
    const afterSteps = new Map((afterScenario?.steps ?? []).map((step) => [step.id, step]));
    for (const step of beforeScenario.steps.filter((item) => rank[item.milestoneClass] > 0)) {
      const updated = afterSteps.get(step.id);
      if (!updated) {
        finding(`required milestone was removed: ${step.id}`);
        continue;
      }
      if ((rank[updated.milestoneClass] ?? 0) < rank[step.milestoneClass]) finding(`required milestone class was weakened: ${step.id}`);
      if (step.milestoneClass === "REQUIRED_EXACT_ACTION" && (updated.action !== step.action || canonicalHash(updated.target) !== canonicalHash(step.target))) finding(`required exact action changed: ${step.id}`);
    }
  }
}

function compareQaPolicies(beforeQaIr, afterQaIr, finding) {
  const afterScenarios = new Map(afterQaIr.suites.flatMap((suite) => suite.scenarios.map((scenario) => [scenario.id, scenario])));
  const ranks = {
    navigation: { BLOCKED: 0, ALLOWED: 1 },
    click: { NONE: 0, SAFE_ONLY: 1, ALL: 2 },
    type: { NONE: 0, NON_SECRET: 1, ALL: 2 },
    confirmation: { DENY: 0, ALLOW_SAFE: 1 },
  };
  for (const scenario of beforeQaIr.suites.flatMap((suite) => suite.scenarios)) {
    const updated = afterScenarios.get(scenario.id);
    if (!updated) {
      finding(`QA scenario was removed: ${scenario.id}`);
      continue;
    }
    for (const [key, values] of Object.entries(ranks)) if ((values[updated.policy[key]] ?? -1) < (values[scenario.policy[key]] ?? -1)) finding(`QA policy ${key} became less executable: ${scenario.id}`);
    for (const key of ["readDom", "readNetwork", "upload", "submit"]) if (scenario.policy[key] === true && updated.policy[key] === false) finding(`QA policy ${key} was disabled: ${scenario.id}`);
  }
}

function integritySourcePath(qaIr, proposal) {
  const value = qaIr.source.uri;
  if (typeof value === "string" && value.length <= 4_096 && !/^(?:[a-z]:[\\/]|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)|[\0\r\n]/i.test(value)) return value;
  return proposal.files[0].path;
}

function reviewIdentity(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "invocationId,model,provider") throw new TypeError(`${label} identity is invalid`);
  for (const key of ["provider", "model", "invocationId"]) if (typeof value[key] !== "string" || value[key].length === 0 || value[key].length > 512) throw new TypeError(`${label} identity is invalid`);
  return Object.freeze({ provider: value.provider, model: value.model, invocationId: value.invocationId });
}

function independentReviewResult(common, output, context) {
  const { referenceHashes: _ignored, ...reviewOutput } = output;
  const body = { ...common, ...reviewOutput };
  return snapshotContract("IndependentRemediationReview", { ...body, reviewId: stableId("remediation-review", body) }, context);
}

function publicationPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "minimumConfidence")) throw new TypeError("publication policy is invalid");
  const minimumConfidence = value.minimumConfidence ?? 0.5;
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) throw new TypeError("publication policy minimumConfidence is invalid");
  return Math.max(0.5, minimumConfidence);
}

function publicationGate(gate, passed, reason) {
  return { gate, status: passed ? "PASS" : "FAIL", reason };
}

function stagePublicationGate(gate, artifact, passed, reason) {
  return { gate, status: artifact === undefined ? "UNKNOWN" : passed ? "PASS" : "FAIL", reason };
}

function normalizePublicationTargets(value, repository) {
  if (!Array.isArray(value) || value.length > 10) throw new TypeError("existing publications are invalid");
  const targets = value.map((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target) || Object.keys(target).sort().join(",") !== "number,publication,url" || !["ISSUE", "DRAFT_PR"].includes(target.publication) || !Number.isSafeInteger(target.number) || target.number < 1 || typeof target.url !== "string") throw new TypeError("existing publication is invalid");
    const expected = `https://github.com/${repository}/${target.publication === "ISSUE" ? "issues" : "pull"}/${target.number}`;
    if (target.url.toLowerCase() !== expected.toLowerCase()) throw new TypeError("existing publication URL is invalid");
    return Object.freeze({ publication: target.publication, number: target.number, url: target.url });
  });
  if (new Set(targets.map((target) => `${target.publication}:${target.number}`)).size !== targets.length) throw new TypeError("existing publications contain duplicates");
  return Object.freeze(targets);
}

function prepareAppliedFile({ file, proposal, worktreePath }) {
  if (file.action === "CREATE") {
    assertSafeWorktreeParents(worktreePath, file.path);
    if (exists(resolve(worktreePath, file.path))) throw new PatchApplicationFailure("PATCH_STALE", `created file already exists: ${file.path}`);
    const operation = proposal.operations.find((item) => item.path === file.path);
    const content = Buffer.from(operation.content, "utf8");
    decodeTextBlob(content);
    return { path: file.path, action: file.action, content };
  }

  const original = readSafeWorktreeFile(worktreePath, file.path);
  const beforeHash = hashBytes(original);
  if (beforeHash !== file.originalContentHash) throw new PatchApplicationFailure("PATCH_STALE", `original content hash changed: ${file.path}`);
  const source = decodeTextBlob(original);
  const newline = source.includes("\r\n") ? "\r\n" : source.includes("\r") ? "\r" : "\n";
  const lines = source.split(/\r\n|\r|\n/);
  const operations = proposal.operations
    .filter((item) => item.path === file.path)
    .sort((left, right) => right.startLine - left.startLine);
  for (const operation of operations) {
    if (operation.endLine > lines.length) throw new PatchApplicationFailure("PATCH_STALE", `replacement range is stale: ${file.path}`);
    const replacement = operation.replacement === "" ? [] : operation.replacement.split(/\r\n|\r|\n/);
    lines.splice(operation.startLine - 1, operation.endLine - operation.startLine + 1, ...replacement);
  }
  const content = Buffer.from(lines.join(newline), "utf8");
  decodeTextBlob(content);
  return { path: file.path, action: file.action, beforeHash, content };
}

function writeAppliedFile(file, worktreePath) {
  const target = resolve(worktreePath, file.path);
  assertWithinWorktree(worktreePath, target);
  if (file.action === "CREATE") {
    createSafeWorktreeParents(worktreePath, dirname(target));
    const descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { writeFileSync(descriptor, file.content); } finally { closeSync(descriptor); }
    return;
  }
  const descriptor = openSync(target, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new PatchApplicationFailure("REJECTED", `patch target is not a bounded regular file: ${file.path}`);
    if (hashBytes(readDescriptor(descriptor, stat.size)) !== file.beforeHash) throw new PatchApplicationFailure("PATCH_STALE", `original content hash changed: ${file.path}`);
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, file.content);
  } finally {
    closeSync(descriptor);
  }
}

function readSafeWorktreeFile(worktreePath, path) {
  assertSafeWorktreeParents(worktreePath, path);
  const target = resolve(worktreePath, path);
  let descriptor;
  try {
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new PatchApplicationFailure("REJECTED", `patch target is not a bounded regular file: ${path}`);
    const content = readDescriptor(descriptor, stat.size);
    decodeTextBlob(content);
    return content;
  } catch (error) {
    if (error instanceof PatchApplicationFailure) throw error;
    if (error?.code === "ENOENT") throw new PatchApplicationFailure("PATCH_STALE", `patch target is missing: ${path}`);
    if (error?.code === "ELOOP") throw new PatchApplicationFailure("REJECTED", `patch target is a symbolic link: ${path}`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readDescriptor(descriptor, size) {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < content.length) {
    const bytes = readSync(descriptor, content, offset, content.length - offset, offset);
    if (bytes === 0) break;
    offset += bytes;
  }
  if (offset !== content.length) throw new PatchApplicationFailure("ERROR", "patch target could not be read");
  return content;
}

function assertSafeWorktreeParents(worktreePath, path) {
  const target = resolve(worktreePath, path);
  assertWithinWorktree(worktreePath, target);
  const parts = relative(worktreePath, target).split(sep);
  let current = worktreePath;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!exists(current)) return;
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PatchApplicationFailure("REJECTED", `patch path contains an unsafe component: ${path}`);
  }
}

function createSafeWorktreeParents(worktreePath, parent) {
  assertWithinWorktree(worktreePath, parent);
  const parts = relative(worktreePath, parent).split(sep).filter(Boolean);
  let current = worktreePath;
  for (const part of parts) {
    current = join(current, part);
    if (!exists(current)) mkdirSync(current, { mode: 0o755 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PatchApplicationFailure("REJECTED", "patch path contains an unsafe component");
  }
}

function assertWithinWorktree(worktreePath, target) {
  const fromRoot = relative(worktreePath, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new PatchApplicationFailure("REJECTED", "patch path escapes the isolated worktree");
}

function assertDiffSummary(summary, createdPaths) {
  const expectedCreates = new Set(createdPaths.map((path) => `create mode 100644 ${path}`));
  const lines = summary.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.some((line) => !expectedCreates.delete(line)) || expectedCreates.size !== 0) throw new PatchApplicationFailure("REJECTED", "permission, rename, or binary changes are forbidden");
}

function changedLineCount(numstat) {
  let total = 0;
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [added, removed] = line.split("\t");
    if (!/^\d+$/.test(added) || !/^\d+$/.test(removed)) throw new PatchApplicationFailure("REJECTED", "binary changes are forbidden");
    total += Number(added) + Number(removed);
  }
  return total;
}

function failedApplication(proposal, status, reason) {
  const body = {
    schemaVersion: PATCH_APPLICATION_RESULT_VERSION,
    proposalId: proposal.proposalId,
    baseRevision: proposal.baseRevision,
    status,
    appliedFiles: [],
    diff: { fileCount: 0, changedLines: 0, contentHash: hashBytes(Buffer.alloc(0)) },
    reason,
  };
  return snapshotContract("PatchApplicationResult", { ...body, applicationId: stableId("patch-application", body) }, { proposal });
}

function cleanupWorktree(root, worktreePath, branch) {
  spawnGit(root, ["worktree", "remove", "--force", worktreePath]);
  rmSync(worktreePath, { recursive: true, force: true });
  spawnGit(root, ["branch", "-D", branch]);
  spawnGit(root, ["worktree", "prune"]);
}

function ensurePrivateDirectory(path) {
  if (!exists(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("private worktree storage is invalid");
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

function pathEscapes(root, target) {
  const value = relative(root, target);
  return value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
}

function exists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function hashBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

class PatchApplicationFailure extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function diagnosisConfidence(origin, judgeConfidence) {
  if (EXPLICIT_ORIGINS.has(origin)) return Math.min(judgeConfidence, 0.9);
  if (origin === "PRODUCT_CODE") return Math.min(judgeConfidence, 0.7);
  return Math.min(judgeConfidence, 0.4);
}

function likelyCause(origin, failed) {
  if (origin === "PRODUCT_CODE") {
    const rationale = failed.map((item) => item.rationale).filter(Boolean).join(" ").slice(0, 1_000);
    return rationale || "Observed product behavior contradicts the QA expectation.";
  }
  if (origin === "UNKNOWN") return "Available evidence does not identify a reliable owner or root cause.";
  return `Structured evidence attributes the failure to ${origin.toLowerCase().replaceAll("_", " ")}.`;
}

function manualReviewReason(origin, verdict) {
  if (origin === "ENVIRONMENT") return "Environment failures require manual recovery before code remediation.";
  if (origin === "THIRD_PARTY") return "Third-party failures are outside automatic repository remediation.";
  return `Judge verdict ${verdict} does not provide enough evidence for automatic remediation.`;
}

function severityFor(origin) {
  if (origin === "API_CONTRACT") return "HIGH";
  if (origin === "PRODUCT_CODE") return "MEDIUM";
  return "LOW";
}

function jsonSnapshot(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("remediation input must be JSON-serializable");
  return JSON.parse(serialized);
}

function patchPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_PATCH_POLICY, key))) throw new TypeError("patch policy is invalid");
  const configured = { ...DEFAULT_PATCH_POLICY, ...value };
  if (!Number.isFinite(configured.minimumConfidence) || configured.minimumConfidence < 0 || configured.minimumConfidence > 1) throw new TypeError("patch policy minimumConfidence is invalid");
  if (!Number.isInteger(configured.maxFiles) || configured.maxFiles < 1 || configured.maxFiles > 10) throw new TypeError("patch policy maxFiles is invalid");
  if (!Number.isInteger(configured.maxChangedLines) || configured.maxChangedLines < 1 || configured.maxChangedLines > 10_000) throw new TypeError("patch policy maxChangedLines is invalid");
  for (const key of ["allowedPaths", "deniedPaths"]) {
    if (!Array.isArray(configured[key]) || (key === "allowedPaths" && configured[key].length === 0) || configured[key].some((path) => typeof path !== "string" || path.includes("\0") || path.includes("..") || path.startsWith("/"))) throw new TypeError(`patch policy ${key} is invalid`);
  }
  return Object.freeze({
    minimumConfidence: Math.max(DEFAULT_PATCH_POLICY.minimumConfidence, configured.minimumConfidence),
    maxFiles: Math.min(DEFAULT_PATCH_POLICY.maxFiles, configured.maxFiles),
    maxChangedLines: Math.min(DEFAULT_PATCH_POLICY.maxChangedLines, configured.maxChangedLines),
    allowedPaths: Object.freeze([...configured.allowedPaths]),
    deniedPaths: Object.freeze([...configured.deniedPaths]),
  });
}

function assertAllowedPatchPath(path, policy) {
  if (DEFAULT_DENIED_PATH.test(path)) throw new Error(`patch path is denied: ${path}`);
  if (!policy.allowedPaths.some((prefix) => pathPrefixMatches(path, prefix)) || policy.deniedPaths.some((prefix) => pathPrefixMatches(path, prefix))) throw new Error(`patch path is outside configured policy: ${path}`);
}

function pathPrefixMatches(path, prefix) {
  const normalized = prefix.replace(/\/$/, "");
  return normalized === "" || path === normalized || path.startsWith(`${normalized}/`);
}

function repositoryAtRevision(repositoryRoot, revision) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) throw new TypeError("repository root is required");
  const root = realpathSync(resolve(repositoryRoot));
  const resolved = git(root, ["rev-parse", "--verify", `${revision}^{commit}`]).toString("utf8").trim();
  if (resolved !== revision) throw new Error("patch proposal base revision is not an exact repository commit");
  return root;
}

function readPinnedBlob(root, revision, path) {
  const entry = pinnedTreeEntry(root, revision, path);
  if (!entry || entry.type !== "blob") throw new Error(`patch file is unknown: ${path}`);
  if (entry.mode === "120000") throw new Error(`patch file is a symbolic link: ${path}`);
  const blob = git(root, ["show", `${revision}:${path}`]);
  decodeTextBlob(blob);
  return blob;
}

function assertPinnedPathAbsent(root, revision, path) {
  if (pinnedTreeEntry(root, revision, path)) throw new Error(`created patch file already exists: ${path}`);
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const entry = pinnedTreeEntry(root, revision, parts.slice(0, index).join("/"));
    if (entry?.mode === "120000") throw new Error(`patch path contains a symbolic link: ${path}`);
  }
}

function pinnedTreeEntry(root, revision, path) {
  const output = git(root, ["ls-tree", "-z", revision, "--", `:(literal)${path}`]);
  if (output.length === 0) return undefined;
  const entries = output.toString("utf8").split("\0").filter(Boolean);
  const exact = entries.find((entry) => entry.slice(entry.indexOf("\t") + 1) === path);
  if (!exact) return undefined;
  const [mode, type] = exact.slice(0, exact.indexOf("\t")).split(" ");
  return { mode, type };
}

function decodeTextBlob(value) {
  if (value.includes(0)) throw new Error("patch content is binary");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error("patch content is not UTF-8 text");
  }
}

function textLineCount(value) {
  return value === "" ? 0 : value.split(/\r\n|\r|\n/).length;
}

function redactModelValue(value, secrets) {
  if (typeof value === "string") return redactSensitiveText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactModelValue(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactModelValue(item, secrets)]));
  return value;
}

function git(root, args) {
  const result = spawnGit(root, args);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}

function gitStatus(root, args) {
  return spawnGit(root, args).status;
}

function spawnGit(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, env: gitEnvironment() });
}

function gitEnvironment() {
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE"].map((key) => [key, process.env[key]]).filter(([, value]) => typeof value === "string"));
}

function unique(values) {
  return [...new Set(values)];
}

function stableId(prefix, value) {
  return `${prefix}-${canonicalHash(value).slice("sha256:".length, "sha256:".length + 16)}`;
}
