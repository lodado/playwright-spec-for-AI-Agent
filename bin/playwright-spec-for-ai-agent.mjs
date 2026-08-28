#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as nodeUtil from "node:util";
import { EXIT_ENVIRONMENT, EXIT_OK, EXIT_USAGE } from "../scripts/errors.mjs";
import { printProjectConfigHelp } from "../scripts/hermes-qa-project-config.mjs";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPTS_DIR = join(PACKAGE_ROOT, "scripts");
const ENV_FILE_PREFIX = "--env-file=";

/**
 * `flags` lists the command's own options; a command without it forwards
 * `--help` to its stage script rather than have this file invent flag docs.
 */
const COMMANDS = {
  spec: {
    script: "extract-page-e2e-spec.mjs",
    summary: "Parse @qa-scenario specs → raw + rule-abstracted JSON",
    flags: [
      "--page",
      "--spec-dir",
      "--output-dir",
      "--allow-missing-fixtures",
      "--config",
      "--project-root",
      "--strict-config",
    ],
  },
  "abstract-ai": {
    script: "run-hermes-spec-abstractor.mjs",
    summary: "Agent writes Given/When/Then livePlan → qa-spec-live.json/.md",
    flags: [
      "--page",
      "--output-dir",
      "--dry-run",
      "--force",
      "--config",
      "--project-root",
      "--strict-config",
    ],
  },
  login: {
    script: "run-qa-login.mjs",
    summary: "Open a headed browser to log in once; judge reuses the session",
    flags: [
      "--base-url",
      "--login-path",
      "--channel",
      "--attach",
      "--config",
      "--project-root",
    ],
  },
  judge: {
    script: "run-hermes-page-judge.mjs",
    summary: "Agent opens the target page in a browser and judges live DOM",
    flags: [
      "--page",
      "--target-path",
      "--base-url",
      "--login-path",
      "--email",
      "--password",
      "--auth-required",
      "--credentials-in-prompt",
      "--expected-plan",
      "--expected-subscription-status",
      "--account-notes",
      "--output-dir",
      "--config",
      "--project-root",
      "--strict-config",
      "--non-interactive",
      "--dry-run",
      "--fail-on",
      "--cdp-url",
    ],
  },
  review: {
    script: "run-hermes-judge-review.mjs",
    summary: "Agent re-reviews judge results (evidence + pedantic pass/fail)",
    flags: [
      "--page",
      "--target-path",
      "--output-dir",
      "--samples",
      "--dry-run",
      "--config",
      "--project-root",
      "--strict-config",
    ],
  },
  slack: {
    script: "slack-page-qa-report.mjs",
    summary: "Post verdict to Slack webhook",
    flags: [
      "--page",
      "--notify",
      "--base-url",
      "--output-dir",
      "--config",
      "--project-root",
      "--strict-config",
    ],
  },
  nightly: {
    script: "run-page-qa-nightly.mjs",
    summary: "spec → abstract-ai → judge → review → (optional slack)",
    flags: [
      "--page",
      "--target-path",
      "--with-slack",
      "--skip-abstract-ai",
      "--skip-review",
      "--pages",
      "--all",
      "--review-on",
      "--force-abstract",
      "--force-judge",
      "--config",
      "--project-root",
      "--strict-config",
      "--non-interactive",
    ],
  },
  doctor: {
    script: "run-qa-doctor.mjs",
    summary: "Check config, credentials, agent CLI, and staging reachability",
  },
  show: {
    script: "page-qa-show.mjs",
    summary: "Print the latest artifacts for a page",
  },
  report: {
    script: "page-qa-report.mjs",
    summary: "Render a run report from stored artifacts",
  },
  ack: {
    script: "page-qa-ack.mjs",
    summary: "Acknowledge a verdict so the next run can compare against it",
  },
  demo: {
    script: "run-qa-demo.mjs",
    summary: "Run the pipeline end to end against bundled sample specs",
  },
};

const FLAG_HELP = {
  "--page": ["--page=<slug>", "Page id (required for most commands)"],
  "--target-path": ["--target-path=<path>", "Staging URL path (or set in config)"],
  "--base-url": ["--base-url=<url>", "Staging base URL (env: STAGING_QA_BASE_URL)"],
  "--login-path": ["--login-path=<path>", "Login page path (env: STAGING_QA_LOGIN_PATH)"],
  "--config": ["--config=<path>", "Project config file"],
  "--project-root": ["--project-root=<path>", "Project root directory"],
  "--spec-dir": ["--spec-dir=<template>", "Spec dir, supports {page} and {root}"],
  "--output-dir": ["--output-dir=<template>", "Output dir, supports {page} and {root}"],
  "--email": ["--email=<address>", "Staging account email (env: STAGING_QA_EMAIL)"],
  "--password": ["--password=<secret>", "Staging account password (env: STAGING_QA_PASSWORD)"],
  "--auth-required": ["--auth-required=false", "Skip login for public/no-auth target pages"],
  "--credentials-in-prompt": [
    "--credentials-in-prompt",
    "Legacy: embed credentials in the agent prompt instead of the login session",
  ],
  "--expected-plan": ["--expected-plan=<plan>", "Account plan the scenarios assume"],
  "--expected-subscription-status": [
    "--expected-subscription-status=<status>",
    "ACTIVE | INACTIVE | CANCEL_PENDING",
  ],
  "--account-notes": ["--account-notes=<text>", "Free-text note forwarded to the agent prompt"],
  "--with-slack": ["--with-slack", "Post to Slack on fail/manual_review"],
  "--skip-abstract-ai": ["--skip-abstract-ai", "Reuse the existing live plan"],
  "--skip-review": ["--skip-review", "Stop after judge; do not run the review pass"],
  "--non-interactive": ["--non-interactive", "Skip prompts (CI); --yes and -y are aliases"],
  "--channel": ["--channel=<name>", "Log in with real Chrome/Edge instead of bundled Chromium"],
  "--attach": ["--attach", "Print how to attach to a browser you already run, then exit"],
  "--cdp-url": ["--cdp-url=<url>", "Judge through a browser you already run and signed into"],
  "--allow-missing-fixtures": [
    "--allow-missing-fixtures",
    "Warn instead of failing when a @qa-fixture file does not exist",
  ],
  "--dry-run": ["--dry-run", "Write the prompt and plan, then stop before calling the agent"],
  "--force": ["--force", "Regenerate even when the input hash is unchanged"],
  "--fail-on": ["--fail-on=<mode>", "fail (default) | manual_review | never — which verdict exits non-zero"],
  "--samples": ["--samples=<n>", "Run the review n times (1-9) and take a per-criterion majority"],
  "--notify": ["--notify=<mode>", "failures (default) | always | never"],
  "--pages": ["--pages=<a,b>", "Run these pages instead of one --page"],
  "--all": ["--all", "Run every page in the config's `pages` block"],
  "--review-on": ["--review-on=<mode>", "fail (default) | always | never — when to run the review stage"],
  "--force-abstract": ["--force-abstract", "Re-run abstract-ai even when the spec is unchanged"],
  "--force-judge": ["--force-judge", "Judge even when the deploy and spec are unchanged"],
  "--strict-config": ["--strict-config", "Turn config warnings into errors (env: QA_STRICT_CONFIG=1)"],
};

/**
 * Flags that consume the next argv entry when written space-separated. Every
 * value-taking flag any stage script parses belongs here: a flag left out is
 * not rejected, it is silently dropped — `judge --fail-on manual_review` would
 * gate on the default instead, and report a manual_review run as green.
 */
const VALUE_FLAGS = new Set([
  "--page",
  "--pages",
  "--cdp-url",
  "--channel",
  "--target-path",
  "--base-url",
  "--login-path",
  "--dashboard-path",
  "--config",
  "--project-root",
  "--root",
  "--spec-dir",
  "--output-dir",
  "--email",
  "--password",
  "--auth-required",
  "--expected-plan",
  "--expected-subscription-status",
  "--account-notes",
  "--env-file",
  "--fail-on",
  "--review-on",
  "--samples",
  "--notify",
  "--format",
  "--out",
  "--item",
  "--reason",
  "--by",
  "--until",
  "--remove",
]);

const GLOBAL_OPTIONS = [
  ["--env-file=<path>", "Load this env file instead of ./.env.local + ./.env"],
  ["--help, -h", "Show help (per command when placed after a command)"],
  ["--version, -V", "Print the package version"],
];

function padded(rows) {
  const width = Math.max(...rows.map(([left]) => left.length)) + 2;
  return rows.map(([left, right]) => `  ${left.padEnd(width)}${right}`).join("\n");
}

function printHelp() {
  console.log(`playwright-spec-for-AI-Agent — AI staging QA for Playwright specs

Usage:
  npx playwright-spec-for-ai-agent <command> [options]

Commands:
${padded(Object.entries(COMMANDS).map(([name, entry]) => [name, entry.summary]))}

Global options:
${padded(GLOBAL_OPTIONS)}

Run \`<command> --help\` (or \`help <command>\`) for that command's options.

Examples:
  npx playwright-spec-for-ai-agent spec --page=pricing
  npx playwright-spec-for-ai-agent judge --page=pricing --target-path=/pricing
  npx playwright-spec-for-ai-agent nightly --page=dashboard --with-slack

Config: playwright-spec-for-ai-agent.config.mjs in your project root
         (see playwright-spec-for-ai-agent.config.example.mjs)
`);
  printProjectConfigHelp();
}

function printCommandHelp(name) {
  const entry = COMMANDS[name];
  if (!entry.flags) {
    runScript(entry.script, ["--help"]);
    return;
  }
  console.log(`Usage: npx playwright-spec-for-ai-agent ${name} [options]

  ${entry.summary}

Options:
${padded(entry.flags.map(flag => FLAG_HELP[flag]))}

Global options:
${padded(GLOBAL_OPTIONS)}
`);
  process.exit(EXIT_OK);
}

function packageVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

function suggestCommand(input) {
  let best = null;
  let bestDistance = 3;
  for (const name of Object.keys(COMMANDS)) {
    const distance = editDistance(input, name);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * `--page dashboard` is the shape everyone types; every stage script only
 * understands `--page=dashboard`. Boolean flags are left untouched.
 */
function normalizeFlags(args) {
  const normalized = [];
  for (let i = 0; i < args.length; i += 1) {
    const next = args[i + 1];
    // ponytail: a value starting with "-" must use --flag=value; a password
    // shaped like a flag is rarer than a typo'd missing value.
    if (VALUE_FLAGS.has(args[i]) && next !== undefined && !next.startsWith("-")) {
      normalized.push(`${args[i]}=${next}`);
      i += 1;
      continue;
    }
    normalized.push(args[i]);
  }
  return normalized;
}

/**
 * Applies `.env` defaults to this process and every stage it spawns. Assigning
 * key by key — rather than process.loadEnvFile — is what makes the precedence
 * rule enforceable here: an exported var or a CI secret always beats a
 * checked-out file, whatever a given Node version's loader would have done.
 */
function applyEnvFile(envPath, { required }) {
  if (!existsSync(envPath)) {
    if (!required) return;
    console.error(`--env-file not found: ${envPath}`);
    process.exit(EXIT_USAGE);
  }
  // parseEnv landed in Node 20.12; engines only promise 20.
  if (typeof nodeUtil.parseEnv !== "function") {
    console.error(
      `[env] skipped ${envPath}: node ${process.versions.node} cannot parse env files (needs >= 20.12)`
    );
    return;
  }

  let parsed;
  try {
    parsed = nodeUtil.parseEnv(readFileSync(envPath, "utf8"));
  } catch (error) {
    console.error(`[env] could not read ${envPath}: ${error.message}`);
    process.exit(EXIT_ENVIRONMENT);
  }

  let applied = 0;
  let kept = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (key in process.env) {
      kept += 1;
      continue;
    }
    process.env[key] = value;
    applied += 1;
  }
  console.error(
    `[env] ${envPath}: ${applied} applied, ${kept} already set in the environment (kept)`
  );
}

function loadEnvFile(args) {
  if (process.env.QA_NO_ENV_FILE === "1") return;

  const explicit = args
    .find(arg => arg.startsWith(ENV_FILE_PREFIX))
    ?.slice(ENV_FILE_PREFIX.length);
  if (explicit) {
    applyEnvFile(resolve(process.cwd(), explicit), { required: true });
    return;
  }

  // `.env.local` before `.env`, because that is where Next/Vite/CRA projects
  // keep the untracked secrets — staging credentials included — and reading
  // only `.env` made the CLI report them as unset in a repo that had them.
  // Earlier wins: this loop never overwrites a key already in process.env.
  for (const name of [".env.local", ".env"]) {
    applyEnvFile(resolve(process.cwd(), name), { required: false });
  }
}

function runScript(scriptName, args) {
  const scriptPath = join(SCRIPTS_DIR, scriptName);
  if (!existsSync(scriptPath)) {
    console.error(`Command implementation is missing: ${scriptPath}`);
    console.error("Reinstall playwright-spec-for-ai-agent — this file ships with the package.");
    process.exit(EXIT_ENVIRONMENT);
  }

  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  });

  if (result.error) {
    console.error(`Could not start ${scriptName}: ${result.error.message}`);
    process.exit(EXIT_ENVIRONMENT);
  }
  if (result.signal) {
    console.error(`${scriptName} was killed by ${result.signal}.`);
    process.exit(EXIT_ENVIRONMENT);
  }
  // No status and no signal is an infrastructure failure, never a verdict fail.
  process.exit(result.status ?? EXIT_ENVIRONMENT);
}

function main() {
  const argv = normalizeFlags(process.argv.slice(2));
  loadEnvFile(argv);
  const args = argv.filter(arg => !arg.startsWith(ENV_FILE_PREFIX));

  if (args.includes("--version") || args.includes("-V")) {
    console.log(packageVersion());
    process.exit(EXIT_OK);
  }

  const [command, ...rest] = args;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    const topic = rest.find(arg => !arg.startsWith("-"));
    if (topic && COMMANDS[topic]) printCommandHelp(topic);
    printHelp();
    process.exit(EXIT_OK);
  }

  const entry = COMMANDS[command];
  if (!entry) {
    console.error(`Unknown command: ${command}\n`);
    const suggestion = suggestCommand(command);
    if (suggestion) console.error(`Did you mean "${suggestion}"?\n`);
    printHelp();
    process.exit(EXIT_USAGE);
  }

  if (rest.includes("--help") || rest.includes("-h")) printCommandHelp(command);

  runScript(entry.script, rest);
}

main();
