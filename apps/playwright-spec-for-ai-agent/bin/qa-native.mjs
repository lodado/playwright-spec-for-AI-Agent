#!/usr/bin/env node
import { executeQaNative } from "../packages/cli/qa-native-execute.mjs";
import { judgeQaNative } from "../packages/cli/qa-native-judge.mjs";
import { publishIssueQaNative } from "../packages/cli/qa-native-publish-issue.mjs";
import { proposePatchQaNative } from "../packages/cli/qa-native-propose-patch.mjs";
import { remediateQaNative, verifyPatchQaNative } from "../packages/cli/qa-native-remediate.mjs";
import { reportQaNative } from "../packages/cli/qa-native-report.mjs";
import { runQaNative } from "../packages/cli/qa-native.mjs";

process.exitCode = await runQaNative(process.argv.slice(2), {
  handlers: { execute: executeQaNative, judge: judgeQaNative, diagnose: reportQaNative, "suggest-fix": reportQaNative, report: reportQaNative, "publish-issue": publishIssueQaNative, "propose-patch": proposePatchQaNative, "verify-patch": verifyPatchQaNative, publish: remediateQaNative, remediate: remediateQaNative },
});
