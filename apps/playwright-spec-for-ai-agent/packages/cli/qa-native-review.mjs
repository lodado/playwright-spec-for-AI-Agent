import { rmSync } from "node:fs";
import { join, relative } from "node:path";

import { RUNTIME_OUTCOME_VERSION, canonicalHash, validateContract } from "../contracts/index.mjs";
import { createHermesJudgmentReviewer } from "../provider-hermes/index.mjs";
import { reviewJudgment } from "../review/index.mjs";
import { loadCompletedJudgmentSet, loadValidatedExecution } from "./qa-native-result-set.mjs";
import { createExclusiveQaDirectory, writePrivateJsonExclusive } from "./qa-native.mjs";

export async function reviewQaNative({ runDirectory, judgmentPath, integrityKey, cwd }, overrides = {}) {
  const loadExecution = overrides.loadExecution ?? loadValidatedExecution;
  const loadJudgments = overrides.loadJudgments ?? loadCompletedJudgmentSet;
  const reviewOne = overrides.reviewOne ?? reviewJudgment;
  const reviewer = overrides.reviewer ?? createHermesJudgmentReviewer();
  const report = overrides.report ?? defaultReport;
  const { qaIr, archive, bundles } = loadExecution({ runDirectory, integrityKey, cwd });
  const judgments = loadJudgments({ runDirectory, judgmentPath, cwd, qaIr, bundles, requireComplete: true });
  const reviews = [];
  for (const { result, bundle } of judgments) {
    const review = await reviewOne({ qaIr, bundle, manifest: archive.manifest, readBlob: archive.readBlob, judgeResult: result, reviewer });
    validateContract("JudgmentReview", review, { qaIr, judgeResult: result, evidenceBundle: bundle });
    reviews.push(review);
  }

  const reviewHash = shortHash(reviews.map((review) => review.reviewId));
  const reviewDirectory = join(runDirectory, "reviews", `review-${reviewHash}`);
  let created = false;
  try {
    createExclusiveQaDirectory(relative(cwd, reviewDirectory), { cwd });
    created = true;
    for (const review of reviews) writePrivateJsonExclusive(relative(cwd, join(reviewDirectory, `review-result-${shortHash(review.judgeResultId)}.json`)), review, { cwd });
    writePrivateJsonExclusive(relative(cwd, join(reviewDirectory, "run.json")), { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "review", type: "COMPLETED" }, { cwd });
    const totals = reviews.reduce((counts, review) => ({ ...counts, [review.status]: counts[review.status] + 1 }), { APPROVED: 0, REVISE: 0, MANUAL_REVIEW: 0 });
    report({ reviewDirectory: relative(cwd, reviewDirectory), reviews, totals });
    return totals.REVISE === 0 && totals.MANUAL_REVIEW === 0 ? 0 : 1;
  } catch (error) {
    if (created) rmSync(reviewDirectory, { recursive: true, force: true });
    throw error;
  }
}

function defaultReport({ reviewDirectory, reviews, totals }) {
  for (const review of reviews) {
    process.stdout.write(`qa-native review: ${review.judgeResultId} ${review.status}\n`);
    for (const issue of review.issues) process.stdout.write(`  - ${issue}\n`);
  }
  process.stdout.write(`reviews: ${totals.APPROVED} approved, ${totals.REVISE} revise, ${totals.MANUAL_REVIEW} manual-review → ${reviewDirectory}\n`);
}

function shortHash(value) {
  return canonicalHash(value).slice("sha256:".length, "sha256:".length + 16);
}
