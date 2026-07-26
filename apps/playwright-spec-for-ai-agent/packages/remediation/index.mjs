import {
  FAILURE_DIAGNOSIS_VERSION,
  REPAIR_RECOMMENDATION_VERSION,
  canonicalHash,
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

function unique(values) {
  return [...new Set(values)];
}

function stableId(prefix, value) {
  return `${prefix}-${canonicalHash(value).slice("sha256:".length, "sha256:".length + 16)}`;
}
