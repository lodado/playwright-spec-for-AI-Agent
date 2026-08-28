#!/usr/bin/env node
/**
 * Cross-page digest of the stored artifacts.
 *
 * Every other command speaks about one page. Nobody could answer "what is the
 * state of QA right now" without opening five JSON files, so a page that has
 * never run at all read as silence rather than as a gap. This renders one table
 * over every configured page, and a page with no artifacts is reported as
 * `not run`, never skipped.
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent report --format=md
 *   npx playwright-spec-for-ai-agent report --pages=dashboard,pricing --out=qa.md
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listConfiguredPages } from "./hermes-qa-project-config.mjs";
import { artifactPaths, ensureProjectConfig } from "./page-qa-paths.mjs";
import { readArtifact } from "./artifact-schema.mjs";
import { lastEntry } from "./qa-run-ledger.mjs";
import { appendStepSummary } from "./github-summary.mjs";
import {
  EXIT_ENVIRONMENT,
  EXIT_OK,
  EXIT_VERDICT_FAIL,
  runMain,
  UsageError,
} from "./errors.mjs";

const FORMATS = ["md", "json"];
const FAIL_ON_MODES = ["fail", "manual_review", "never"];

const HELP = `Usage: npx playwright-spec-for-ai-agent report [options]

  Render one table over every configured page's latest judgment.

Options:
  --pages=<a,b>        Only these pages (default: every configured page)
  --format=<md|json>   Output format (default: md)
  --out=<path>         Also write the rendered report to this file
  --fail-on=<mode>     fail (default) | manual_review | never
  --config=<path>      Project config file
  --project-root=<dir> Project root directory

Appends to $GITHUB_STEP_SUMMARY when that variable is set.
`;

function parseValueFlag(argv, prefix, fallback, allowed) {
  const arg = argv.find(item => item.startsWith(prefix));
  if (!arg) return fallback;
  const value = arg.slice(prefix.length).trim();
  if (allowed && !allowed.includes(value)) {
    throw new UsageError(`Unknown ${prefix}${value}.`, {
      hint: `Use one of: ${allowed.map(item => `${prefix}${item}`).join(", ")}.`,
    });
  }
  return value;
}

export function selectPages(argv = []) {
  const arg = argv.find(item => item.startsWith("--pages="));
  const pages = arg
    ? arg
        .slice("--pages=".length)
        .split(",")
        .map(item => item.trim())
        .filter(Boolean)
    : listConfiguredPages();
  if (!pages.length) {
    throw new UsageError("No pages to report on.", {
      hint: "Add a `pages` block to your config, or pass --pages=<a,b>.",
    });
  }
  return pages;
}

/** Every read here is best-effort: one corrupt artifact must not hide the rest. */
function readOptional(path, kind) {
  if (!existsSync(path)) return null;
  try {
    return readArtifact(path, kind ? { kind } : {});
  } catch (error) {
    return { __unreadable: error.message };
  }
}

function countChecks(checks) {
  const counts = { pass: 0, fail: 0, manual_review: 0, skip: 0, total: 0 };
  for (const check of Array.isArray(checks) ? checks : []) {
    counts.total += 1;
    if (check?.result in counts) counts[check.result] += 1;
  }
  return counts;
}

export function staleness(judgedAt, now = new Date()) {
  const at = Date.parse(judgedAt ?? "");
  if (Number.isNaN(at)) return { hours: null, label: "—" };
  const hours = Math.max(0, (now.getTime() - at) / 3_600_000);
  const label = hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
  return { hours, label };
}

/**
 * @returns {{ page: string, status: string, cause: string, checks: object,
 *             coverage: object, adapter: string, model: string,
 *             judgedAt: string|null, runId: string|null, ageLabel: string,
 *             quarantined: boolean, review: string|null, lastEvent: string|null }}
 */
export function collectPageReport(page, now = new Date()) {
  const paths = artifactPaths(page);
  const marker = existsSync(paths.runInvalidMarker);
  const judgment = readOptional(paths.hermesJudgmentJson, "judgment");
  const review = readOptional(paths.hermesReviewJson, "review");
  const ledgerTail = lastEntry(paths.runsLedger);

  let status;
  if (marker) status = "quarantined";
  else if (!judgment) status = "not run";
  else if (judgment.__unreadable) status = "unreadable";
  else status = typeof judgment.status === "string" ? judgment.status : "unknown";

  const coverage = judgment?.coverage ?? {};
  const missing = Array.isArray(coverage.missing) ? coverage.missing : [];

  return {
    page,
    status,
    cause: judgment?.cause ?? (marker ? "ENVIRONMENT_DEFECT" : "—"),
    checks: countChecks(judgment?.checks),
    coverage: {
      planned: Number(coverage.planned ?? 0),
      addressed: Number(coverage.addressed ?? 0),
      missing: missing.length,
    },
    adapter: judgment?.agentMeta?.adapter ?? "—",
    model: judgment?.agentMeta?.model ?? "",
    judgedAt: judgment?.judgedAt ?? null,
    runId: judgment?.runId ?? ledgerTail?.runId ?? null,
    ageLabel: staleness(judgment?.judgedAt, now).label,
    quarantined: marker,
    review: review?.overallReview ?? null,
    lastEvent: ledgerTail?.kind ?? null,
  };
}

const FAILING_STATUSES = new Set(["fail", "quarantined", "unreadable"]);
const ATTENTION_STATUSES = new Set(["manual_review", "not run", "skip", "unknown"]);

export function isFailing(row, mode = "fail") {
  if (mode === "never") return false;
  if (FAILING_STATUSES.has(row.status)) return true;
  return mode === "manual_review" && ATTENTION_STATUSES.has(row.status);
}

function agentCell(row) {
  if (row.adapter === "—") return "—";
  return row.model ? `${row.adapter} (${row.model})` : row.adapter;
}

export function renderMarkdown(rows, { title = "Page QA report" } = {}) {
  const header = [
    "Page",
    "Status",
    "Cause",
    "Checks (p/f/m)",
    "Coverage",
    "Agent",
    "Judged",
    "Age",
    "Run",
  ];
  const body = rows.map(row => [
    row.page,
    row.status,
    row.cause,
    `${row.checks.pass}/${row.checks.fail}/${row.checks.manual_review}`,
    row.coverage.planned
      ? `${row.coverage.addressed}/${row.coverage.planned}${row.coverage.missing ? ` (${row.coverage.missing} missing)` : ""}`
      : "—",
    agentCell(row),
    row.judgedAt ?? "—",
    row.ageLabel,
    row.runId ?? "—",
  ]);
  return [
    `## ${title}`,
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map(cells => `| ${cells.join(" | ")} |`),
    "",
  ].join("\n");
}

export function renderJson(rows) {
  return `${JSON.stringify({ generatedAt: new Date().toISOString(), pages: rows }, null, 2)}\n`;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} process exit code
 */
export async function run(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return EXIT_OK;
  }

  await ensureProjectConfig(argv);

  const format = parseValueFlag(argv, "--format=", "md", FORMATS);
  const failOn = parseValueFlag(argv, "--fail-on=", "fail", FAIL_ON_MODES);
  const outPath = parseValueFlag(argv, "--out=", "");

  const rows = selectPages(argv).map(page => collectPageReport(page));
  const rendered = format === "json" ? renderJson(rows) : renderMarkdown(rows);

  process.stdout.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
  if (outPath) writeFileSync(resolve(outPath), rendered);
  appendStepSummary(renderMarkdown(rows));

  const failing = rows.filter(row => isFailing(row, failOn));
  if (!failing.length) return EXIT_OK;
  console.error(
    `Failing pages: ${failing.map(row => `${row.page} (${row.status})`).join(", ")}`
  );
  // A quarantined or unreadable run is an infrastructure failure, not a verdict.
  return failing.some(row => row.status === "quarantined" || row.status === "unreadable")
    ? EXIT_ENVIRONMENT
    : EXIT_VERDICT_FAIL;
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) runMain(() => run());
