#!/usr/bin/env node
import { executeQaNative } from "../packages/cli/qa-native-execute.mjs";
import { abstractQaNative } from "../packages/cli/qa-native-abstract.mjs";
import { judgeQaNative } from "../packages/cli/qa-native-judge.mjs";
import { reportQaNative } from "../packages/cli/qa-native-report.mjs";
import { reviewQaNative } from "../packages/cli/qa-native-review.mjs";
import { runPipelineQaNative } from "../packages/cli/qa-native-run.mjs";
import { runQaNative } from "../packages/cli/qa-native.mjs";

process.exitCode = await runQaNative(process.argv.slice(2), {
  handlers: { run: runPipelineQaNative, abstract: abstractQaNative, execute: executeQaNative, judge: judgeQaNative, review: reviewQaNative, report: reportQaNative },
});
