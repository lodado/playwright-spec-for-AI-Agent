#!/usr/bin/env node
import { executeQaNative } from "../packages/cli/qa-native-execute.mjs";
import { judgeQaNative } from "../packages/cli/qa-native-judge.mjs";
import { reportQaNative } from "../packages/cli/qa-native-report.mjs";
import { runQaNative } from "../packages/cli/qa-native.mjs";

process.exitCode = await runQaNative(process.argv.slice(2), {
  handlers: { execute: executeQaNative, judge: judgeQaNative, diagnose: reportQaNative, "suggest-fix": reportQaNative, report: reportQaNative },
});
