#!/usr/bin/env node
/**
 * Orchestrate spec -> judge -> (optional slack) for any page.
 *
 * Usage:
 *   npx playwright-spec-qa nightly --page=pricing --with-slack
 *
 * Flags:
 *   --page=       (required)
 *   --target-path= optional when targetPaths / pages.*.targetPath is set
 *   --with-slack  post Slack on fail/manual_review
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { getPackageScriptsDir } from "./hermes-qa-project-config.mjs";
import {
  ensureProjectConfig,
  parsePageArg,
  parseTargetPathArg,
} from "./page-qa-paths.mjs";

const SCRIPT_DIR = getPackageScriptsDir();

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function forwardArgs(argv) {
  return argv.filter(arg => arg !== "--with-slack");
}

function runNode(script, args) {
  const result = spawnSync("node", [join(SCRIPT_DIR, script), ...args], {
    stdio: "inherit",
    env: process.env,
  });
  return result.status ?? 1;
}

async function main() {
  const argv = process.argv.slice(2);
  await ensureProjectConfig(argv);
  const page = parsePageArg(argv);
  const targetPath = parseTargetPathArg(argv, page);
  const rest = forwardArgs(argv);
  const withSlack = hasFlag(argv, "--with-slack");

  let exitCode = 0;

  exitCode = runNode("extract-page-e2e-spec.mjs", [`--page=${page}`, ...rest]);
  if (exitCode !== 0) process.exit(exitCode);

  const judgeExit = runNode("run-hermes-page-judge.mjs", [
    `--page=${page}`,
    `--target-path=${targetPath}`,
    ...rest,
  ]);
  if (judgeExit !== 0) exitCode = judgeExit;

  if (withSlack) {
    const slackExit = runNode("slack-page-qa-report.mjs", [
      `--page=${page}`,
      `--target-path=${targetPath}`,
      ...rest,
    ]);
    if (slackExit !== 0) exitCode = slackExit;
  }

  process.exit(exitCode);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
