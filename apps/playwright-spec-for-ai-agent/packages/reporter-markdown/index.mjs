import { canonicalHash, validateContract } from "../contracts/index.mjs";
import { redactSensitiveText } from "../evidence/index.mjs";
import { diagnoseFailure, recommendRepair } from "../remediation/index.mjs";

export function renderRemediationReport({ diagnosis, codeContext, recommendation, qaIr, judgeResult, evidenceBundle, secrets = [] }) {
  const secretList = Object.freeze([...secrets].filter(Boolean).map(String));
  const input = jsonSnapshot({ diagnosis, codeContext, recommendation, qaIr, judgeResult, evidenceBundle });
  validateContract("QaIrDocument", input.qaIr);
  validateContract("EvidenceBundle", input.evidenceBundle);
  validateContract("JudgeResult", input.judgeResult, { qaIr: input.qaIr, evidenceBundle: input.evidenceBundle });
  validateContract("FailureDiagnosis", input.diagnosis, { judgeResult: input.judgeResult, evidenceBundle: input.evidenceBundle });
  validateContract("CodeContextBundle", input.codeContext);
  validateContract("RepairRecommendation", input.recommendation, {
    diagnosis: input.diagnosis,
    codeContext: input.codeContext,
  });
  const derivedDiagnosis = diagnoseFailure({ qaIr: input.qaIr, judgeResult: input.judgeResult, evidenceBundle: input.evidenceBundle, secrets: secretList });
  if (canonicalHash(input.diagnosis) !== canonicalHash(derivedDiagnosis)) throw new Error("FailureDiagnosis does not match Judge evidence");
  const derivedRecommendation = recommendRepair({
    diagnosis: derivedDiagnosis,
    codeContext: input.codeContext,
    qaIr: input.qaIr,
    judgeResult: input.judgeResult,
    evidenceBundle: input.evidenceBundle,
    secrets: secretList,
  });
  if (canonicalHash(input.recommendation) !== canonicalHash(derivedRecommendation)) throw new Error("RepairRecommendation does not match deterministic remediation");

  const lines = [
    "# QA Remediation Report",
    "",
    `## [${input.recommendation.severity}] ${safeText(input.recommendation.title, secretList)}`,
    "",
    "### Diagnosis",
    "",
    `- Origin: **${input.diagnosis.origin}**`,
    `- Confidence: **${input.diagnosis.confidence.toFixed(2)}**`,
    `- Symptom: ${safeText(input.diagnosis.symptom, secretList)}`,
    `- Likely cause: ${safeText(input.diagnosis.likelyCause, secretList)}`,
    "",
    "### Evidence",
    "",
    ...listOrFallback(input.recommendation.evidenceRefs.map((ref) => code(ref, secretList)), "No supporting evidence references."),
    "",
    "### Recommended locations",
    "",
    ...listOrFallback(input.recommendation.locations.map((location) => {
      const range = location.range ? `:${location.range.start.line}-${location.range.end.line}` : "";
      return `${code(`${location.path}${range}`, secretList)} — ${safeText(location.reason, secretList)}`;
    }), "No repository location met the deterministic relevance threshold."),
    "",
    "### Recommended changes",
    "",
    ...listOrFallback(input.recommendation.changes.map((change) => (
      `${code(change.path, secretList)}: ${safeText(change.recommendation, secretList)} Expected effect: ${safeText(change.expectedEffect, secretList)}`
    )), "Manual review is required before suggesting a code change."),
  ];

  const risks = input.recommendation.changes.flatMap((change) => change.risks);
  lines.push(
    "",
    "### Risks",
    "",
    ...listOrFallback(risks.map((risk) => safeText(risk, secretList)), "No additional risks recorded."),
    "",
    "### Verification",
    "",
    ...input.recommendation.verificationPlan.map((step, index) => (
      `${index + 1}. ${code(step.command, secretList)} — ${safeText(step.purpose, secretList)}`
    )),
    "",
    `Patch eligibility: **${input.recommendation.patchEligibility}**`,
    `Repository revision: ${code(input.recommendation.repositoryRevision, secretList)}`,
    "",
  );
  const report = lines.join("\n");
  if (report.length > 131_072) throw new Error("Markdown remediation report exceeds size limit");
  return report;
}

function listOrFallback(items, fallback) {
  return items.length > 0 ? items.map((item) => `- ${item}`) : [`- ${fallback}`];
}

function code(value, secrets) {
  return `\`${safeText(value, secrets).replaceAll("`", "'")}\``;
}

function safeText(value, secrets) {
  return redactSensitiveText(String(value), secrets)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function jsonSnapshot(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("report input must be JSON-serializable");
  return JSON.parse(serialized);
}
