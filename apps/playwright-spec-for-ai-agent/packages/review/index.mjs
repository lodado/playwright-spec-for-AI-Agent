import { JUDGMENT_REVIEW_VERSION, canonicalHash, validateContract } from "../contracts/index.mjs";
import { buildSemanticJudgeInput, evaluateDeterministically } from "../judge/index.mjs";

export async function reviewJudgment({ qaIr, bundle, manifest, readBlob, judgeResult, reviewer } = {}) {
  if (typeof reviewer !== "function") throw new TypeError("reviewer must be a function");
  validateContract("JudgeResult", judgeResult, { qaIr, evidenceBundle: bundle });
  const evaluation = evaluateDeterministically({ qaIr, bundle, manifest, readBlob });
  const semanticInput = buildSemanticJudgeInput({ qaIr, bundle, manifest, readBlob, evaluation });
  const scenario = qaIr.suites.flatMap((suite) => suite.scenarios).find((item) => item.id === bundle.scenarioId);
  const input = {
    qaIrId: qaIr.id,
    scenario: {
      id: scenario.id,
      title: scenario.title,
      ...(scenario.semantics === undefined ? {} : { semantics: structuredClone(scenario.semantics) }),
      ...(semanticInput.scenario.requiredPath === undefined ? {} : { requiredPath: semanticInput.scenario.requiredPath }),
      expectations: structuredClone(scenario.expectations),
    },
    evidence: semanticInput.evidence,
    judgment: structuredClone(judgeResult),
  };
  const decision = normalizeJudgmentReviewDecision(await reviewer(input));
  const body = {
    schemaVersion: JUDGMENT_REVIEW_VERSION,
    qaIrId: qaIr.id,
    evidenceBundleId: bundle.bundleId,
    judgeResultId: judgeResult.resultId,
    status: decision.status,
    issues: decision.issues ?? [],
    reviewer: reviewerRecord(reviewer),
    inputHash: canonicalHash(input),
  };
  return validateContract("JudgmentReview", { ...body, reviewId: `review-${canonicalHash(body).slice("sha256:".length, "sha256:".length + 16)}` }, { qaIr, judgeResult, evidenceBundle: bundle });
}

export function normalizeJudgmentReviewDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["status", "issues"].includes(key))) throw new TypeError("judgment review decision is invalid");
  if (value.status === "APPROVED") {
    if (value.issues !== undefined) throw new TypeError("approved judgment review cannot contain issues");
    return { status: "APPROVED" };
  }
  if (!["REVISE", "MANUAL_REVIEW"].includes(value.status) || !Array.isArray(value.issues) || value.issues.length === 0 || value.issues.length > 20) throw new TypeError("judgment review decision is invalid");
  return { status: value.status, issues: value.issues.map((issue) => boundedText(issue)) };
}

function reviewerRecord(reviewer) {
  return {
    provider: reviewer.identity?.provider ?? "unknown",
    model: reviewer.identity?.model ?? "unknown",
    ...(reviewer.identity?.modelVersion ? { modelVersion: reviewer.identity.modelVersion } : {}),
    promptVersion: reviewer.promptVersion ?? "unknown",
  };
}

function boundedText(value) {
  if (typeof value !== "string") throw new TypeError("judgment review issue is invalid");
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 2_000) throw new TypeError("judgment review issue is invalid");
  return normalized;
}
