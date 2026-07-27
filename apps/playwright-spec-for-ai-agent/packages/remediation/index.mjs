import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  FAILURE_DIAGNOSIS_VERSION,
  REPAIR_RECOMMENDATION_VERSION,
  canonicalHash,
  snapshotContract,
  validateContract,
} from "../contracts/index.mjs";
import { redactSensitiveText } from "../evidence/index.mjs";

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

function classifyOrigin(bundle, evidenceRefs, hasContradiction) {
  const referenced = new Set(evidenceRefs);
  for (const fact of bundle.facts) {
    if (referenced.has(fact.id) && ORIGIN_BY_FACT_KIND.has(fact.kind)) return ORIGIN_BY_FACT_KIND.get(fact.kind);
  }
  return hasContradiction ? "PRODUCT_CODE" : "UNKNOWN";
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
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}

function unique(values) {
  return [...new Set(values)];
}

function stableId(prefix, value) {
  return `${prefix}-${canonicalHash(value).slice("sha256:".length, "sha256:".length + 16)}`;
}
