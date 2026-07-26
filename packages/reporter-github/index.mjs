import { GITHUB_PUBLICATION_RESULT_VERSION, canonicalHash, validateContract } from "../contracts/index.mjs";
import { redactSensitiveText, verifyEvidenceBundleIdentity } from "../evidence/index.mjs";
import { diagnoseFailure, recommendRepair } from "../remediation/index.mjs";

const DEFAULT_LABELS = ["qa-runtime", "auto-generated"];

export async function publishGitHubFailureIssue({
  repository,
  qaIr,
  judgeResult,
  evidenceBundle,
  diagnosis,
  codeContext,
  recommendation,
  labels,
  secrets = [],
  verifyCodeContext,
  transport,
} = {}) {
  if (typeof transport !== "function") throw new TypeError("GitHub Issue transport must be a function");
  if (typeof verifyCodeContext !== "function") throw new TypeError("GitHub Code Context verifier must be a function");
  const input = jsonSnapshot({ qaIr, judgeResult, evidenceBundle, diagnosis, codeContext, recommendation });
  const targetRepository = repositorySlug(repository);
  validateInputs(input, secrets, targetRepository);
  const safeLabels = validateLabels(labels ?? issueLabels(input, secrets), secrets);
  const title = issueTitle(input, secrets);
  const body = renderGitHubFailureIssue({ ...input, secrets });
  const files = input.codeContext.snippets.map(({ path, contentHash }) => ({ path, contentHash }));
  if (await verifyCodeContext({ repository: targetRepository, revision: input.codeContext.revision, files }) !== true) throw new Error("GitHub repository does not match the pinned Code Context");
  const published = await transport({ repository: targetRepository, title, body, labels: safeLabels });
  if (!published || !Number.isInteger(published.number) || published.number < 1 || typeof published.url !== "string") throw new Error("GitHub Issue transport returned an invalid result");
  return validateContract("GitHubPublicationResult", {
    schemaVersion: GITHUB_PUBLICATION_RESULT_VERSION,
    repository,
    publication: "ISSUE",
    action: "CREATED",
    issue: { number: published.number, url: published.url },
    source: {
      runId: input.evidenceBundle.runId,
      judgeResultId: input.judgeResult.resultId,
      failureDiagnosisId: input.diagnosis.diagnosisId,
      codeContextBundleId: input.codeContext.bundleId,
      ...(input.recommendation ? { repairRecommendationId: input.recommendation.recommendationId } : {}),
    },
    publicationFingerprint: "UNASSIGNED",
  });
}

export function renderGitHubFailureIssue({ qaIr, judgeResult, evidenceBundle, diagnosis, codeContext, recommendation, secrets = [] } = {}) {
  const input = jsonSnapshot({ qaIr, judgeResult, evidenceBundle, diagnosis, codeContext, recommendation });
  validateInputs(input, secrets);
  const scenario = input.qaIr.suites.flatMap((suite) => suite.scenarios).find((item) => item.id === input.evidenceBundle.scenarioId);
  const unresolved = input.judgeResult.expectationResults.filter((item) => !["MATCHED", "NOT_APPLICABLE"].includes(item.status));
  const expected = unresolved.map((result) => {
    const expectation = scenario.expectations.find((item) => item.id === result.expectationId);
    return `${code(result.expectationId, secrets)} — ${safeText(expectationSummary(expectation), secrets)}`;
  });
  const observed = unresolved.map((result) => `${code(result.expectationId, secrets)} — ${safeText(result.rationale, secrets)}`);
  const locations = input.codeContext.candidates.map((candidate) => {
    const range = candidate.range ? `:${candidate.range.start.line}-${candidate.range.end.line}` : "";
    return `${code(`${candidate.path}${range}`, secrets)} — ${safeText(candidate.matchReasons.join(", "), secrets)}`;
  });
  const finalUrl = safeUrl(input.evidenceBundle.environment.targetUrl, secrets);
  const lines = [
    "## QA failure",
    "",
    `- Scenario: **${safeText(scenario.title, secrets)}** (${code(scenario.id, secrets)})`,
    `- Verdict: **${input.judgeResult.verdict}**`,
    `- Origin: **${input.diagnosis.origin}**`,
    `- Confidence: **${input.diagnosis.confidence.toFixed(2)}**`,
    `- Run: ${code(input.evidenceBundle.runId, secrets)}`,
    `- Judge Result: ${code(input.judgeResult.resultId, secrets)}`,
    `- Repository revision: ${code(input.codeContext.revision, secrets)}`,
    "",
    "## Symptom",
    "",
    safeText(input.diagnosis.symptom, secrets),
    "",
    "## Expected",
    "",
    ...list(expected, "No bounded expectation summary is available."),
    "",
    "## Observed",
    "",
    ...list(observed, "The Judge did not provide a bounded observation rationale."),
    "",
    "## Evidence",
    "",
    ...list(input.diagnosis.supportingEvidenceRefs.map((ref) => code(ref, secrets)), "No supporting evidence reference."),
    `- Final safe URL: ${code(finalUrl, secrets)}`,
    `- Final checkpoint: ${code(input.evidenceBundle.checkpointId, secrets)}`,
    "",
    "## Suspected locations",
    "",
    ...list(locations, "No repository location met the deterministic relevance threshold."),
    "",
    "## Uncertainty / manual review",
    "",
    ...list([
      ...input.judgeResult.uncertainty.map((item) => `${safeText(item.code, secrets)} — ${safeText(item.description, secrets)}`),
      ...input.diagnosis.manualReviewReasons.map((reason) => safeText(reason, secrets)),
    ], "No additional uncertainty was recorded."),
    "",
    "## Reproduction",
    "",
    code(`qa-native replay --run-dir=.qa/runs/${safeRunId(input.evidenceBundle.runId)}`, secrets),
    "",
    `Diagnosis: ${code(input.diagnosis.diagnosisId, secrets)}`,
    `Code context: ${code(input.codeContext.bundleId, secrets)}`,
    ...(input.recommendation ? [`Repair recommendation: ${code(input.recommendation.recommendationId, secrets)}`] : []),
    "",
  ];
  const body = lines.join("\n");
  if (body.length > 65_536) throw new Error("GitHub Issue body exceeds size limit");
  return body;
}

function validateInputs(input, secrets, repository) {
  validateContract("QaIrDocument", input.qaIr);
  validateContract("EvidenceBundle", input.evidenceBundle);
  verifyEvidenceBundleIdentity(input.evidenceBundle);
  validateContract("JudgeResult", input.judgeResult, { qaIr: input.qaIr, evidenceBundle: input.evidenceBundle });
  verifyStableId("judge", "resultId", input.judgeResult);
  if (!["FAIL", "MANUAL_REVIEW"].includes(input.judgeResult.verdict)) throw new Error("only failed or manual-review QA results can publish an Issue");
  validateContract("FailureDiagnosis", input.diagnosis, { judgeResult: input.judgeResult, evidenceBundle: input.evidenceBundle });
  const derivedDiagnosis = diagnoseFailure({ qaIr: input.qaIr, judgeResult: input.judgeResult, evidenceBundle: input.evidenceBundle, secrets });
  if (canonicalHash(input.diagnosis) !== canonicalHash(derivedDiagnosis)) throw new Error("Failure Diagnosis does not match Judge evidence");
  validateContract("CodeContextBundle", input.codeContext);
  if (input.codeContext.failureDiagnosisId !== input.diagnosis.diagnosisId) throw new Error("Code Context does not belong to the failure diagnosis");
  if (!/^[0-9a-f]{40,64}$/i.test(input.codeContext.revision)) throw new Error("Code Context revision is not pinned");
  if (repository && input.codeContext.repositoryId.toLowerCase() !== repository.toLowerCase()) throw new Error("Code Context belongs to a different repository");
  verifyStableId("code-context", "bundleId", input.codeContext);
  const candidateKeys = input.codeContext.candidates.map((item) => `${item.path}\0${canonicalHash(item.range ?? null)}`).sort();
  const snippetKeys = input.codeContext.snippets.map((item) => `${item.path}\0${canonicalHash(item.range)}`).sort();
  if (candidateKeys.length !== snippetKeys.length || candidateKeys.some((key, index) => key !== snippetKeys[index])) throw new Error("Code Context candidates do not match pinned snippets");
  if (input.recommendation !== undefined) {
    validateContract("RepairRecommendation", input.recommendation, { diagnosis: input.diagnosis, codeContext: input.codeContext });
    const derivedRecommendation = recommendRepair({ diagnosis: derivedDiagnosis, codeContext: input.codeContext, qaIr: input.qaIr, judgeResult: input.judgeResult, evidenceBundle: input.evidenceBundle, secrets });
    if (canonicalHash(input.recommendation) !== canonicalHash(derivedRecommendation)) throw new Error("Repair Recommendation does not match deterministic remediation");
  }
}

function issueTitle({ qaIr, evidenceBundle, diagnosis }, secrets) {
  const scenario = qaIr.suites.flatMap((suite) => suite.scenarios).find((item) => item.id === evidenceBundle.scenarioId);
  return safePlainText(`[QA] ${scenario.title}: ${diagnosis.symptom}`, secrets).replaceAll("@", "@\u200b").slice(0, 240);
}

function issueLabels({ evidenceBundle, diagnosis, recommendation }, secrets) {
  const severity = recommendation?.severity.toLowerCase() ?? (diagnosis.origin === "PRODUCT_CODE" ? "medium" : "low");
  return [...DEFAULT_LABELS, `origin:${diagnosis.origin.toLowerCase().replaceAll("_", "-")}`, `severity:${severity}`, `scenario:${labelSlug(safeText(evidenceBundle.scenarioId, secrets))}`];
}

function validateLabels(labels, secrets) {
  if (!Array.isArray(labels) || labels.length === 0 || labels.length > 10 || new Set(labels).size !== labels.length || labels.some((label) => typeof label !== "string" || label.length === 0 || label.length > 50 || /[\0\r\n]/.test(label) || safePlainText(label, secrets) !== label)) throw new Error("GitHub Issue labels are invalid");
  return Object.freeze([...labels]);
}

function repositorySlug(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value) || value.split("/").some((part) => part === "." || part === "..")) throw new Error("GitHub repository must be an owner/repository slug");
  return value;
}

function expectationSummary(expectation) {
  if (!expectation) return "Expectation metadata unavailable.";
  const expected = expectation.expected?.value ?? expectation.text?.value ?? expectation.target?.text?.value ?? expectation.target?.accessibleName?.value ?? expectation.target?.testId;
  return expected === undefined ? `${expectation.kind} expectation` : `${expectation.kind}: ${String(expected).slice(0, 1_000)}`;
}

function safeUrl(value, secrets) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "unavailable";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const path = url.pathname.split("/").map((segment) => segment.includes("%") ? "[REDACTED]" : safePlainText(segment, secrets)).join("/");
    return path || "/";
  } catch {
    return "unavailable";
  }
}

function safeRunId(value) {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : "REPLACE_WITH_RUN_ID";
}

function labelSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 41) || "unknown";
}

function list(items, fallback) { return items.length > 0 ? items.map((item) => `- ${item}`) : [`- ${fallback}`]; }
function code(value, secrets) { return `\`${safePlainText(value, secrets).replaceAll("`", "'")}\``; }
function safePlainText(value, secrets) {
  const suppliedSecretsRemoved = redactSensitiveText(String(value), secrets);
  let redacted;
  try { redacted = JSON.parse(redactSensitiveText(JSON.stringify(suppliedSecretsRemoved))); } catch { redacted = "[REDACTED]"; }
  return redacted.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function safeText(value, secrets) { return safePlainText(value, secrets).replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1").replaceAll("@", "@\u200b"); }
function verifyStableId(prefix, idKey, value) { const { [idKey]: id, ...body } = value; const expected = `${prefix}-${canonicalHash(body).slice("sha256:".length, "sha256:".length + 16)}`; if (id !== expected) throw new Error(`${prefix} artifact identity is invalid`); }
function jsonSnapshot(value) { const serialized = JSON.stringify(value); if (serialized === undefined) throw new Error("GitHub publication input must be JSON-serializable"); return JSON.parse(serialized); }
