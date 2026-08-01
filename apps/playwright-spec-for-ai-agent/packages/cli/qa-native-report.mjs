import { rmSync } from "node:fs";
import { join, relative } from "node:path";

import { RUNTIME_OUTCOME_VERSION, canonicalHash } from "../contracts/index.mjs";
import { diagnoseFailure, recommendRepair } from "../remediation/index.mjs";
import { createLocalRepositorySnapshot, locateCode } from "../repository-provider/index.mjs";
import { renderRemediationReport } from "../reporter-markdown/index.mjs";
import { loadCompletedJudgmentSet, loadCompletedReviewSet, loadValidatedExecution } from "./qa-native-result-set.mjs";
import { createExclusiveQaDirectory, writePrivateFileExclusive, writePrivateJsonExclusive } from "./qa-native.mjs";

export async function reportQaNative({ runDirectory, repositoryRoot, revision, judgmentPath, integrityKey, cwd }, overrides = {}) {
  const reportSummary = overrides.reportSummary ?? defaultReportSummary;
  const prepare = overrides.prepare ?? prepareQaNativeRemediation;
  const prepared = prepare({ runDirectory, repositoryRoot, revision, judgmentPath, integrityKey, cwd, requireFailing: false, requireApprovedReviews: false });
  if (prepared.items.length === 0 && prepared.unapprovedReviews.length === 0) {
    reportSummary({ judged: prepared.judged, failing: 0, ...(prepared.notApplicable > 0 ? { notApplicable: prepared.notApplicable } : {}) });
    return 0;
  }
  const reportHash = shortHash({ results: prepared.items.map(({ judgeResult }) => judgeResult.resultId), reviews: prepared.unapprovedReviews.map((review) => review.reviewId), repositoryRevision: prepared.repositoryRevision });
  const reportDirectory = join(runDirectory, "reports", `report-${reportHash}`);
  let created = false;
  try {
    createExclusiveQaDirectory(relative(cwd, reportDirectory), { cwd });
    created = true;
    for (const { judgeResult, evidenceBundle, diagnosis, codeContext, recommendation } of prepared.items) {
      const suffix = shortHash(judgeResult.resultId);
      writePrivateJsonExclusive(relative(cwd, join(reportDirectory, `diagnosis-${suffix}.json`)), diagnosis, { cwd });
      writePrivateJsonExclusive(relative(cwd, join(reportDirectory, `code-context-${suffix}.json`)), codeContext, { cwd });
      writePrivateJsonExclusive(relative(cwd, join(reportDirectory, `repair-recommendation-${suffix}.json`)), recommendation, { cwd });
      writePrivateFileExclusive(relative(cwd, join(reportDirectory, `report-${suffix}.md`)), renderRemediationReport({ diagnosis, codeContext, recommendation, qaIr: prepared.qaIr, judgeResult, evidenceBundle }), { cwd });
    }
    for (const review of prepared.unapprovedReviews) {
      const suffix = shortHash(review.reviewId);
      writePrivateJsonExclusive(relative(cwd, join(reportDirectory, `judgment-review-${suffix}.json`)), review, { cwd });
      writePrivateFileExclusive(relative(cwd, join(reportDirectory, `judgment-review-${suffix}.md`)), renderJudgmentReview(review), { cwd });
    }
    writePrivateJsonExclusive(relative(cwd, join(reportDirectory, "run.json")), { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "report", type: "COMPLETED" }, { cwd });
    reportSummary({ judged: prepared.judged, failing: prepared.items.length, ...(prepared.notApplicable > 0 ? { notApplicable: prepared.notApplicable } : {}), ...(prepared.unapprovedReviews.length === 0 ? {} : { reviewRequired: prepared.unapprovedReviews.length }), reportDirectory: relative(cwd, reportDirectory) });
    return 0;
  } catch (error) {
    if (created) rmSync(reportDirectory, { recursive: true, force: true });
    throw error;
  }
}

// A successful report was previously silent (and an all-pass run was an error); one summary line
// tells CI and operators what was judged and where the remediation artifacts landed.
function defaultReportSummary({ judged, failing, notApplicable = 0, reviewRequired = 0, reportDirectory }) {
  const applicabilityNote = notApplicable > 0 ? `, ${notApplicable} not-applicable` : "";
  if (failing === 0 && reviewRequired === 0) {
    process.stdout.write(`qa-native report: ${judged} judgment(s), 0 failing${applicabilityNote} — nothing to remediate\n`);
  } else if (reviewRequired === 0) {
    process.stdout.write(`qa-native report: ${judged} judgment(s), ${failing} failing${applicabilityNote} → ${reportDirectory}\n`);
  } else {
    process.stdout.write(`qa-native report: ${judged} judgment(s), ${failing} failing${applicabilityNote}, ${reviewRequired} review-required → ${reportDirectory}\n`);
  }
}

export function prepareQaNativeRemediation({ runDirectory, repositoryRoot, revision, judgmentPath, integrityKey, cwd, repositoryId, requireFailing = true, requireApprovedReviews = true }) {
  const { qaIr, bundles } = loadValidatedExecution({ runDirectory, integrityKey, cwd });
  const notApplicable = qaIr.extensions?.applicabilityDecisions?.filter((decision) => decision.status === "NOT_APPLICABLE").length ?? 0;
  const judgments = loadCompletedJudgmentSet({ runDirectory, judgmentPath, cwd, qaIr, bundles });
  const reviews = qaIr.suites.some((suite) => suite.scenarios.some((scenario) => scenario.semantics !== undefined))
    ? loadCompletedReviewSet({ runDirectory, cwd, qaIr, judgments })
    : [];
  const unapprovedReviews = reviews.filter((review) => review.status !== "APPROVED");
  if (requireApprovedReviews && unapprovedReviews.length > 0) throw new Error("QA judgment review is not approved");
  const approvedJudgeResultIds = new Set(reviews.filter((review) => review.status === "APPROVED").map((review) => review.judgeResultId));
  const selected = judgments.filter(({ result }) => ["FAIL", "MANUAL_REVIEW"].includes(result.verdict) && (reviews.length === 0 || approvedJudgeResultIds.has(result.resultId)));
  if (selected.length === 0) {
    if (requireFailing) throw new Error("QA report has no failing judgments");
    return Object.freeze({ qaIr, judged: judgments.length, notApplicable, unapprovedReviews: Object.freeze(unapprovedReviews), items: Object.freeze([]) });
  }

  const snapshot = createLocalRepositorySnapshot({ root: repositoryRoot, revision, repositoryId });
  const items = selected.map(({ result, bundle }) => {
    const diagnosis = diagnoseFailure({ qaIr, judgeResult: result, evidenceBundle: bundle });
    const codeContext = locateCode({ snapshot, diagnosis, judgeResult: result, qaIr, evidenceBundle: bundle });
    const recommendation = recommendRepair({ diagnosis, codeContext, qaIr, judgeResult: result, evidenceBundle: bundle });
    return { judgeResult: result, evidenceBundle: bundle, diagnosis, codeContext, recommendation };
  });
  return Object.freeze({ qaIr, repositoryRevision: snapshot.revision, judged: judgments.length, notApplicable, unapprovedReviews: Object.freeze(unapprovedReviews), items: Object.freeze(items) });
}

function renderJudgmentReview(review) {
  return [
    "# QA Judgment Review",
    "",
    `- Judge result: \`${review.judgeResultId}\``,
    `- Status: **${review.status}**`,
    "",
    "## Issues",
    "",
    ...review.issues.map((issue) => `- ${safeMarkdownText(issue)}`),
    "",
  ].join("\n");
}

function safeMarkdownText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1").replaceAll("@", "@\u200b");
}

function shortHash(value) {
  return canonicalHash(value).slice("sha256:".length, "sha256:".length + 16);
}
