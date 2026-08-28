#!/usr/bin/env node
/**
 * Orchestrate spec -> abstract-ai -> judge -> review -> (optional slack) for one
 * or many pages.
 *
 * Stages stay child processes on purpose: a stage that crashes, hangs, or leaks
 * a browser must not take the orchestrator down with it. What this file adds is
 * what happens around them:
 *
 *   1. Results are aggregated by severity, not by "last one wins". An
 *      environment failure in `judge` must not be overwritten by a Slack
 *      failure — a nightly that reports the wrong failure class pages the
 *      wrong person.
 *   2. The two agent stages are skipped when their inputs provably did not
 *      change (same spec hash, same staging build with a passing verdict).
 *      Every night's full agent run is the single largest cost here.
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent nightly --page=pricing --with-slack
 *   npx playwright-spec-for-ai-agent nightly --all --with-slack
 *
 * Flags:
 *   --page=              single page
 *   --pages=a,b          explicit page list (run sequentially)
 *   --all                every page in the project config
 *   --target-path=       optional when targetPaths / pages.*.targetPath is set
 *   --with-slack         post Slack on fail/manual_review
 *   --review-on=         always | fail (default) | never
 *   --force-abstract     re-run abstract-ai even when the spec is unchanged
 *   --force-judge        judge even when staging is on an already-passed build
 *   --with-issues        file/close a GitHub issue per page that needs action
 *   --skip-abstract-ai   skip abstract-ai (use the rule-abstracted spec only)
 *   --skip-review        alias of --review-on=never
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPackageScriptsDir,
  getStagingVersionUrl,
  listConfiguredPages,
  resolveJudgeTarget,
} from "./hermes-qa-project-config.mjs";
import { artifactPaths, ensureProjectConfig } from "./page-qa-paths.mjs";
import { readArtifact } from "./artifact-schema.mjs";
import { hashSpecDefinition } from "./spec-hash.mjs";
import { appendRunEvent, findLast } from "./qa-run-ledger.mjs";
import {
  EXIT_AGENT_OUTPUT,
  EXIT_ENVIRONMENT,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_VERDICT_FAIL,
  runMain,
  UsageError,
} from "./errors.mjs";

const STAGE_SCRIPTS = {
  spec: "extract-page-e2e-spec.mjs",
  "abstract-ai": "run-hermes-spec-abstractor.mjs",
  judge: "run-hermes-page-judge.mjs",
  review: "run-hermes-judge-review.mjs",
  slack: "slack-page-qa-report.mjs",
  issues: "page-qa-issues.mjs",
};

const REVIEW_MODES = ["always", "fail", "never"];

/** Flags this file consumes; every other argv entry is forwarded to the stages. */
const OWN_FLAGS = new Set([
  "--with-slack",
  "--with-issues",
  "--skip-abstract-ai",
  "--skip-review",
  "--all",
  "--force-abstract",
  "--force-judge",
]);
const OWN_VALUE_FLAGS = ["--page=", "--pages=", "--target-path=", "--review-on="];

const HELP = `Usage: npx playwright-spec-for-ai-agent nightly [options]

  spec → abstract-ai → judge → review → (optional slack, issues)

Options:
  --page=<slug>        Page id
  --pages=<a,b>        Run these pages sequentially
  --all                Run every page in the project config
  --target-path=<path> Staging URL path (single page only; config wins otherwise)
  --with-slack         Post to Slack on fail/manual_review
  --with-issues        File/close a GitHub issue per page that needs action
  --review-on=<mode>   always | fail (default) | never
  --force-abstract     Re-run abstract-ai even when the spec hash is unchanged
  --force-judge        Judge even when staging reports an already-passed build
  --skip-abstract-ai   Reuse the existing live plan
  --skip-review        Alias of --review-on=never
  --config=<path>      Project config file
  --project-root=<dir> Project root directory
`;

/**
 * Severity order, worst last. A verdict failure and an infrastructure failure
 * must never collapse into each other, so the run exits with the *worst*
 * outcome rather than the last one.
 */
const SEVERITY_ORDER = [
  EXIT_OK,
  EXIT_VERDICT_FAIL,
  EXIT_USAGE,
  EXIT_AGENT_OUTPUT,
  EXIT_ENVIRONMENT,
];

function severityOf(code) {
  const rank = SEVERITY_ORDER.indexOf(code);
  // An exit code we do not know is worse than any we do: it is unexplained.
  return rank === -1 ? SEVERITY_ORDER.length : rank;
}

export function worstExitCode(codes) {
  let worst = EXIT_OK;
  for (const code of codes) {
    if (severityOf(code) > severityOf(worst)) worst = code;
  }
  return worst;
}

export function parseReviewOn(argv = []) {
  if (argv.includes("--skip-review")) return "never";
  const arg = argv.find(item => item.startsWith("--review-on="));
  if (!arg) return "fail";
  const mode = arg.slice("--review-on=".length).trim();
  if (!REVIEW_MODES.includes(mode)) {
    throw new UsageError(`Unknown --review-on=${mode}.`, {
      hint: `Use one of: ${REVIEW_MODES.map(m => `--review-on=${m}`).join(", ")}.`,
    });
  }
  return mode;
}

export function selectPages(argv = []) {
  const pagesArg = argv.find(item => item.startsWith("--pages="));
  if (pagesArg) {
    const pages = pagesArg
      .slice("--pages=".length)
      .split(",")
      .map(item => item.trim())
      .filter(Boolean);
    if (!pages.length) {
      throw new UsageError("--pages= listed no pages.", {
        hint: "Write --pages=dashboard,pricing, or use --all.",
      });
    }
    return pages;
  }
  if (argv.includes("--all")) {
    const pages = listConfiguredPages();
    if (!pages.length) {
      throw new UsageError("--all found no pages in the project config.", {
        hint: "Add a `pages` block to playwright-spec-for-ai-agent.config.mjs, or pass --page=<slug>.",
      });
    }
    return pages;
  }
  const pageArg = argv.find(item => item.startsWith("--page="));
  if (!pageArg) {
    throw new UsageError("Missing --page= argument.", {
      hint: "Pass --page=<slug>, --pages=<a,b>, or --all.",
    });
  }
  return [pageArg.slice("--page=".length).trim()];
}

function forwardArgs(argv) {
  return argv.filter(
    arg =>
      !OWN_FLAGS.has(arg) && !OWN_VALUE_FLAGS.some(prefix => arg.startsWith(prefix))
  );
}

/**
 * Same resolution as `parseTargetPathArg`, but it throws instead of exiting so a
 * multi-page run reports which page is misconfigured through the normal
 * failure path. `--target-path=` is honoured only for a single page — one CLI
 * path cannot be right for several pages.
 */
function resolveTargetPath(argv, page, { multi }) {
  const target = resolveJudgeTarget(multi ? [] : argv, page);
  if (target.pageUrl) {
    try {
      const url = new URL(target.pageUrl);
      return `${url.pathname}${url.search}${url.hash}` || "/";
    } catch {
      return target.pageUrl;
    }
  }
  if (target.targetPath) return target.targetPath;
  throw new UsageError(`Missing target path for page "${page}".`, {
    hint: `Set pages.${page}.pageUrl or pages.${page}.targetPath in your config, or pass --target-path=/${page}.`,
  });
}

function spawnStage(script, args) {
  const result = spawnSync(process.execPath, [join(getPackageScriptsDir(), script), ...args], {
    stdio: "inherit",
    env: process.env,
  });
  // A stage that never reported a status (spawn error, signal) is an
  // infrastructure failure, never a verdict.
  if (result.error || result.signal) return EXIT_ENVIRONMENT;
  return result.status ?? EXIT_ENVIRONMENT;
}

function runStage(ctx, page, stage, args) {
  const startedAt = ctx.now();
  const exitCode = ctx.spawn(STAGE_SCRIPTS[stage], args);
  ctx.stages.push({
    page,
    stage,
    status: exitCode === 0 ? "ok" : "fail",
    exitCode,
    durationMs: ctx.now() - startedAt,
    note: "",
  });
  return exitCode;
}

function skipStage(ctx, page, stage, note) {
  ctx.stages.push({ page, stage, status: "skipped", exitCode: null, durationMs: 0, note });
  console.log(`[nightly] ${page}: ${stage} skipped — ${note}`);
}

function readJsonArtifact(path, kind) {
  if (!existsSync(path)) return null;
  try {
    return readArtifact(path, kind ? { kind } : {});
  } catch (error) {
    console.warn(`[nightly] ignoring unreadable ${path}: ${error.message}`);
    return null;
  }
}

/** Hash of what `spec` just produced — the input `abstract-ai` would consume. */
function readSpecHash(paths) {
  const spec = readJsonArtifact(paths.specJson, "qa-spec");
  return spec ? hashSpecDefinition(spec) : null;
}

/**
 * `abstract-ai` stamps the spec hash it consumed onto the live plan, so an
 * unchanged spec means last night's plan is still exactly what this run would
 * regenerate.
 */
function liveSpecSourceHash(paths) {
  const live = readJsonArtifact(paths.specLiveJson);
  return typeof live?.sourceHash === "string" ? live.sourceHash : null;
}

/** First recognisable build identifier in a version endpoint's response. */
export function extractBuildId(payload) {
  if (payload == null) return null;
  if (typeof payload === "string") {
    const text = payload.trim();
    if (!text) return null;
    try {
      return extractBuildId(JSON.parse(text));
    } catch {
      return text.slice(0, 200);
    }
  }
  if (typeof payload !== "object") return String(payload);
  for (const key of ["buildId", "build", "version", "commit", "sha", "revision"]) {
    if (payload[key] != null && typeof payload[key] !== "object") {
      return String(payload[key]);
    }
  }
  return null;
}

/** The gate is an optimisation: an unreachable endpoint must judge, not block. */
async function fetchBuildId(url, fetchImpl) {
  if (typeof fetchImpl !== "function") return null;
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json, text/plain" },
    });
    if (!response?.ok) {
      console.warn(
        `[nightly] version endpoint ${url} returned ${response?.status ?? "no status"}; judging anyway.`
      );
      return null;
    }
    return extractBuildId(await response.text());
  } catch (error) {
    console.warn(
      `[nightly] version endpoint ${url} unreachable (${error.message}); judging anyway.`
    );
    return null;
  }
}

function recordDeployEvent(paths, page, event) {
  mkdirSync(paths.outputDir, { recursive: true });
  appendRunEvent(paths.runsLedger, { kind: "deploy", page, ...event });
}

/**
 * Judge only what could have changed: a staging build that already passed with
 * this exact spec has nothing new to say.
 */
async function deployGate(page, paths, specHash, ctx) {
  const versionUrl = getStagingVersionUrl(page);
  if (!versionUrl) return { skip: false, reason: "" };

  const buildId = await fetchBuildId(versionUrl, ctx.fetchImpl);
  if (!buildId) return { skip: false, reason: "" };

  const judgment = readJsonArtifact(paths.hermesJudgmentJson, "judgment");
  const lastDeploy = findLast(
    paths.runsLedger,
    entry => entry?.kind === "deploy" && entry.page === page
  );
  const judgedBuildId = judgment?.stagingBuildId ?? lastDeploy?.buildId ?? null;
  const judgedSpecHash = judgment?.specHash ?? lastDeploy?.specHash ?? null;
  const unchanged = Boolean(
    specHash &&
      buildId === judgedBuildId &&
      judgment?.status === "pass" &&
      judgedSpecHash === specHash
  );

  const skip = unchanged && !ctx.options.forceJudge;
  recordDeployEvent(paths, page, { buildId, specHash, judgeSkipped: skip });

  if (!skip) return { skip: false, reason: "" };
  return {
    skip: true,
    reason: `staging build ${buildId} already passed with this spec (--force-judge to re-judge)`,
  };
}

/**
 * Under the default `fail` mode the review agent runs only when a human would
 * have to look anyway. A green judgment with no failing check has nothing for
 * the reviewer to re-review.
 */
export function needsReview(judgment, mode = "fail") {
  if (mode === "never") return false;
  if (mode === "always") return true;
  if (!judgment) return true;
  if (judgment.status !== "pass") return true;
  return (Array.isArray(judgment.checks) ? judgment.checks : []).some(
    check => check?.result === "fail" || check?.result === "manual_review"
  );
}

async function runPage(page, ctx) {
  const paths = artifactPaths(page);
  const targetPath = resolveTargetPath(ctx.argv, page, { multi: ctx.multi });
  const pageArgs = [`--page=${page}`, ...ctx.rest];
  const codes = [];

  const specExit = runStage(ctx, page, "spec", pageArgs);
  // Nothing downstream can be trusted once the spec did not build.
  if (specExit !== 0) return specExit;

  const specHash = readSpecHash(paths);

  if (ctx.options.skipAbstract) {
    skipStage(ctx, page, "abstract-ai", "--skip-abstract-ai");
  } else if (
    !ctx.options.forceAbstract &&
    specHash &&
    liveSpecSourceHash(paths) === specHash
  ) {
    skipStage(
      ctx,
      page,
      "abstract-ai",
      `live plan reused: spec unchanged since ${specHash.slice(0, 21)}… (--force-abstract to regenerate)`
    );
  } else {
    codes.push(runStage(ctx, page, "abstract-ai", pageArgs));
  }

  const gate = await deployGate(page, paths, specHash, ctx);
  if (gate.skip) {
    skipStage(ctx, page, "judge", gate.reason);
    skipStage(ctx, page, "review", gate.reason);
  } else {
    const judgeArgs = [`--page=${page}`, `--target-path=${targetPath}`, ...ctx.rest];
    const judgeExit = runStage(ctx, page, "judge", judgeArgs);
    codes.push(judgeExit);

    // Exit 1 is a verdict, not a broken run: the judge worked and the page
    // failed. Treating it as a crash skipped the review stage on exactly the
    // verdicts it exists to double-check, leaving `fail` the one outcome
    // nobody re-read. Only a usage, environment, or agent-output failure
    // leaves nothing to review.
    if (judgeExit !== 0 && judgeExit !== EXIT_VERDICT_FAIL) {
      skipStage(ctx, page, "review", `judge exited ${judgeExit}`);
    } else {
      const judgment = readJsonArtifact(paths.hermesJudgmentJson, "judgment");
      if (needsReview(judgment, ctx.options.reviewOn)) {
        codes.push(runStage(ctx, page, "review", judgeArgs));
      } else {
        skipStage(
          ctx,
          page,
          "review",
          `verdict ${judgment?.status ?? "unknown"} needs no review (--review-on=${ctx.options.reviewOn})`
        );
      }
    }
  }

  if (ctx.options.withSlack) {
    codes.push(
      runStage(ctx, page, "slack", [
        `--page=${page}`,
        `--target-path=${targetPath}`,
        ...ctx.rest,
      ])
    );
  }

  if (ctx.options.withIssues) {
    codes.push(runStage(ctx, page, "issues", [`--page=${page}`, ...ctx.rest]));
  }

  return worstExitCode(codes);
}

export function formatStageTable(stages) {
  const rows = [
    ["PAGE", "STAGE", "STATUS", "EXIT", "MS", "NOTE"],
    ...stages.map(stage => [
      stage.page,
      stage.stage,
      stage.status,
      stage.exitCode === null ? "-" : String(stage.exitCode),
      String(stage.durationMs),
      stage.note ?? "",
    ]),
  ];
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map(row => row[column].length))
  );
  return rows
    .map(row => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd())
    .join("\n");
}

/**
 * @param {string[]} argv
 * @param {{ spawn?: (script: string, args: string[]) => number,
 *           fetch?: typeof globalThis.fetch, now?: () => number }} [overrides]
 * @returns {Promise<number>} process exit code
 */
export async function run(argv = process.argv.slice(2), overrides = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return EXIT_OK;
  }

  await ensureProjectConfig(argv);

  const pages = selectPages(argv);
  const ctx = {
    argv,
    rest: forwardArgs(argv),
    multi: pages.length > 1,
    spawn: overrides.spawn ?? spawnStage,
    fetchImpl: overrides.fetch ?? globalThis.fetch,
    now: overrides.now ?? (() => Date.now()),
    stages: [],
    options: {
      withSlack: argv.includes("--with-slack"),
      withIssues: argv.includes("--with-issues"),
      skipAbstract: argv.includes("--skip-abstract-ai"),
      forceAbstract: argv.includes("--force-abstract"),
      forceJudge: argv.includes("--force-judge"),
      reviewOn: parseReviewOn(argv),
    },
  };

  const codes = [];
  for (const page of pages) {
    codes.push(await runPage(page, ctx));
  }

  console.log(`\n${formatStageTable(ctx.stages)}`);
  return worstExitCode(codes);
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) runMain(() => run());
