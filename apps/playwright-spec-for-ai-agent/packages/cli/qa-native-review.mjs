import { join, relative } from "node:path";

import { validateContract } from "../contracts/index.mjs";
import { createHermesJudgmentReviewer } from "../provider-hermes/index.mjs";
import { reviewJudgment } from "../review/index.mjs";
import { loadCompletedJudgmentSet, loadValidatedExecution } from "./qa-native-result-set.mjs";
import { AI_STAGE_CONCURRENCY, mapConcurrent, writePrivateJsonExclusive } from "./qa-native.mjs";

export async function reviewQaNative({ runDirectory, judgmentPath, integrityKey, cwd }, overrides = {}) {
  const loadExecution = overrides.loadExecution ?? loadValidatedExecution;
  const loadJudgments = overrides.loadJudgments ?? loadCompletedJudgmentSet;
  const reviewOne = overrides.reviewOne ?? reviewJudgment;
  const reviewer = overrides.reviewer ?? createHermesJudgmentReviewer();
  const report = overrides.report ?? defaultReport;
  const { qaIr, archive, bundles } = loadExecution({ runDirectory, integrityKey, cwd });
  const judgments = loadJudgments({ runDirectory, judgmentPath, cwd, qaIr, bundles, requireComplete: true });
  const reviews = await mapConcurrent(judgments, AI_STAGE_CONCURRENCY, async ({ result, bundle }) => {
    const review = await reviewOne({ qaIr, bundle, manifest: archive.manifest, readBlob: archive.readBlob, judgeResult: result, reviewer });
    validateContract("JudgmentReview", review, { qaIr, judgeResult: result, evidenceBundle: bundle });
    return review;
  });

  writePrivateJsonExclusive(relative(cwd, join(runDirectory, "review.json")), reviews, { cwd });
  const totals = reviews.reduce((counts, review) => ({ ...counts, [review.status]: counts[review.status] + 1 }), { APPROVED: 0, MANUAL_REVIEW: 0 });
  report({ reviewPath: relative(cwd, join(runDirectory, "review.json")), reviews, totals });
  return totals.MANUAL_REVIEW === 0 ? 0 : 1;
}

function defaultReport({ reviewPath, reviews, totals }) {
  for (const review of reviews) {
    process.stdout.write(`qa-native review: ${review.judgeResultId} ${review.status}\n`);
    for (const issue of review.issues) process.stdout.write(`  - ${issue}\n`);
  }
  process.stdout.write(`reviews: ${totals.APPROVED} approved, ${totals.MANUAL_REVIEW} manual-review → ${reviewPath}\n`);
}
