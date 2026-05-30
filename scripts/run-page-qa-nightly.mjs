#!/usr/bin/env node
/**
 * Orchestrate spec -> (optional run) -> judge -> (optional slack) for any page.
 *
 * Usage:
 *   node scripts/run-page-qa-nightly.mjs --page=dashboard --with-run --with-slack
 *   node scripts/run-page-qa-nightly.mjs --page=pricing
 *
 * Flags:
 *   --page=              (required)
 *   --target-path=       optional when DEFAULT_TARGET_PATHS has an entry
 *   --with-run           run Playwright staging checks (dashboard only by default)
 *   --without-run        skip Playwright even for dashboard
 *   --with-slack         post Slack on fail/manual_review
 *
 * Additional args (--email=, --non-interactive, ...) are forwarded to each step.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pageSupportsPlaywrightRun,
  parsePageArg,
  parseTargetPathArg,
} from "./page-qa-paths.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function forwardArgs(argv) {
  return argv.filter(
    arg => !["--with-run", "--without-run", "--with-slack"].includes(arg)
  );
}

function runNode(script, args) {
  const result = spawnSync("node", [join(SCRIPT_DIR, script), ...args], {
    stdio: "inherit",
    env: process.env,
  });
  return result.status ?? 1;
}

function main() {
  const argv = process.argv.slice(2);
  const page = parsePageArg(argv);
  const targetPath = parseTargetPathArg(argv, page);
  const rest = forwardArgs(argv);

  const withRun =
    hasFlag(argv, "--with-run") ||
    (!hasFlag(argv, "--without-run") && pageSupportsPlaywrightRun(page));
  const withSlack = hasFlag(argv, "--with-slack");

  let exitCode = 0;

  exitCode = runNode("extract-page-e2e-spec.mjs", [`--page=${page}`, ...rest]);
  if (exitCode !== 0) process.exit(exitCode);

  if (withRun) {
    const runExit = runNode("run-staging-page-ai-qa.mjs", [
      `--page=${page}`,
      `--target-path=${targetPath}`,
      ...rest,
    ]);
    if (runExit !== 0) exitCode = runExit;
  }

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

main();
