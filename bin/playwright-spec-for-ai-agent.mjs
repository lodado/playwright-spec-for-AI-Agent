#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { printProjectConfigHelp } from "../scripts/hermes-qa-project-config.mjs";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPTS_DIR = join(PACKAGE_ROOT, "scripts");

const COMMANDS = {
  spec: "extract-page-e2e-spec.mjs",
  "abstract-ai": "run-hermes-spec-abstractor.mjs",
  judge: "run-hermes-page-judge.mjs",
  review: "run-hermes-judge-review.mjs",
  slack: "slack-page-qa-report.mjs",
  nightly: "run-page-qa-nightly.mjs",
};

const HELP = `playwright-spec-for-AI-Agent — AI staging QA for Playwright specs

Usage:
  npx playwright-spec-for-ai-agent <command> [options]

Commands:
  spec        Parse @qa-scenario specs → raw + rule-abstracted JSON
  abstract-ai Hermes writes Given/When/Then livePlan → qa-spec-live.json/.md
  judge       Hermes logs into staging, visits the page, and judges live DOM
  review      Hermes re-reviews judge results (evidence + pedantic pass/fail)
  slack       Post verdict to Slack webhook
  nightly     spec → abstract-ai → judge → review → (optional slack)

Common options:
  --page=<slug>              Page id (required for most commands)
  --target-path=<path>       Staging URL path (or set in config)
  --config=<path>            Project config file
  --project-root=<path>      Project root directory
  --spec-dir=<template>      Spec dir, supports {page} and {root}
  --output-dir=<template>    Output dir, supports {page} and {root}
  --email= / --password=     Staging credentials (or env vars)
  --non-interactive          Skip prompts (CI)

Examples:
  npx playwright-spec-for-ai-agent spec --page=pricing
  npx playwright-spec-for-ai-agent judge --page=pricing --target-path=/pricing
  npx playwright-spec-for-ai-agent nightly --page=dashboard --with-slack

Config: playwright-spec-for-ai-agent.config.mjs in your project root
         (see playwright-spec-for-ai-agent.config.example.mjs)
`;

function printHelp() {
  console.log(HELP);
  printProjectConfigHelp();
}

function runScript(scriptName, args) {
  const scriptPath = join(SCRIPTS_DIR, scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  });
  process.exit(result.status ?? 1);
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const [command, ...rest] = argv;

  if (command === "help" || command === "--help") {
    printHelp();
    process.exit(0);
  }

  const script = COMMANDS[command];
  if (!script) {
    console.error(`Unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
  }

  runScript(script, rest);
}

main();
