import { executeQaNative } from "./qa-native-execute.mjs";
import { judgeQaNative } from "./qa-native-judge.mjs";
import { reportQaNative } from "./qa-native-report.mjs";
import { reviewQaNative } from "./qa-native-review.mjs";

export async function runPipelineQaNative(options, overrides = {}) {
  const execute = overrides.execute ?? executeQaNative;
  const judge = overrides.judge ?? judgeQaNative;
  const review = overrides.review ?? reviewQaNative;
  const report = overrides.report ?? reportQaNative;
  await requireSuccess("execute", execute(options, overrides.executeOverrides));
  await requireSuccess("judge", judge(options, overrides.judgeOverrides));
  const reviewStatus = await review(options, overrides.reviewOverrides);
  const reportStatus = await report(options, overrides.reportOverrides);
  return reviewStatus === 0 && reportStatus === 0 ? 0 : 1;
}

async function requireSuccess(stage, result) {
  if (await result !== 0) throw new Error(`${stage} did not complete`);
}
