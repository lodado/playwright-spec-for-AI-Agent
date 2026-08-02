import { join, relative } from "node:path";
import { loadCompletedJudgmentSet, loadCompletedReviewSet, loadValidatedExecution } from "./qa-native-result-set.mjs";
import { writePrivateFileExclusive } from "./qa-native.mjs";

export function reportQaNative({ runDirectory, judgmentPath, integrityKey, cwd }, overrides = {}) {
  const loadExecution = overrides.loadExecution ?? loadValidatedExecution;
  const loadJudgments = overrides.loadJudgments ?? loadCompletedJudgmentSet;
  const loadReviews = overrides.loadReviews ?? loadCompletedReviewSet;
  const report = overrides.report ?? defaultReport;
  const { qaIr, bundles } = loadExecution({ runDirectory, integrityKey, cwd });
  const judgments = loadJudgments({ runDirectory, judgmentPath, cwd, qaIr, bundles, requireComplete: true });
  const reviews = loadReviews({ runDirectory, cwd, qaIr, judgments });
  const reviewByJudgment = new Map(reviews.map(review => [review.judgeResultId, review]));
  const rows = judgments.map(({ result }) => ({
    scenarioId: result.scenarioId,
    verdict: result.verdict,
    confidence: result.confidence,
    review: reviewByJudgment.get(result.resultId)?.status ?? "MISSING",
  }));
  const markdown = renderReport(rows);
  const reportPath = relative(cwd, join(runDirectory, "report.md"));
  writePrivateFileExclusive(reportPath, markdown, { cwd });
  report({ reportPath, rows });
  return rows.every(row => row.review === "APPROVED") ? 0 : 1;
}

export function renderReport(rows) {
  const counts = rows.reduce((result, row) => ({ ...result, [row.verdict]: (result[row.verdict] ?? 0) + 1 }), {});
  return [
    "# QA Native report",
    "",
    `- PASS: ${counts.PASS ?? 0}`,
    `- FAIL: ${counts.FAIL ?? 0}`,
    `- SKIP: ${counts.SKIP ?? 0}`,
    `- MANUAL_REVIEW: ${counts.MANUAL_REVIEW ?? 0}`,
    "",
    "| Scenario | Verdict | Confidence | Review |",
    "| --- | --- | ---: | --- |",
    ...rows.map(row => `| ${cell(row.scenarioId)} | ${row.verdict} | ${row.confidence} | ${row.review} |`),
    "",
  ].join("\n");
}

function defaultReport({ reportPath, rows }) {
  const failing = rows.filter(row => ["FAIL", "MANUAL_REVIEW"].includes(row.verdict)).length;
  process.stdout.write(`qa-native report: ${rows.length} judgment(s), ${failing} failing → ${reportPath}\n`);
}

function cell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
