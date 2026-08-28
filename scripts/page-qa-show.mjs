#!/usr/bin/env node
/**
 * show — one screen for debugging one verdict.
 *
 * A page's `__QA__` directory holds up to a dozen files (spec, abstracted spec,
 * live plan, judge plan, raw agent output, judgment, review, ledger, evidence,
 * quarantine marker). Working out *why* a verdict is wrong meant opening most
 * of them and correlating by hand. Every read here is defensive: a missing or
 * older artifact prints "not run" and the rest of the report still renders.
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent show --page=dashboard [--failed] [--json]
 */
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMain } from "./errors.mjs";
import {
  artifactPaths,
  ensureProjectConfig,
  parsePageArg,
} from "./page-qa-paths.mjs";
import { hashSpecDefinition } from "./spec-hash.mjs";

const MAX_DETAIL = 110;

const HELP = `Usage: npx playwright-spec-for-ai-agent show --page=<slug> [options]

  Print the latest verdict, per-check table, coverage, and artifacts for a page.

Options:
  --page=<slug>      Page id (required)
  --json             Machine-readable report on stdout
  --checks-only      Print only the per-check table
  --failed           Only checks whose result is not "pass"
  --evidence         Print artifact and evidence paths only
  --output-dir=<template>
  --config=<path>    Project config file
  --help, -h         Show this help
`;

/** Any artifact may be absent, truncated, or written by an older version. */
function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function truncate(text, max = MAX_DETAIL) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Relative only while it stays inside cwd — `../../../tmp/x` reads worse than absolute. */
function shortPath(path) {
  const rel = relative(process.cwd(), path);
  return !rel || rel.startsWith("..") ? path : rel;
}

/**
 * Compares the judgment's recorded specHash against the spec on disk, so a
 * verdict judged from a stale plan is visible instead of merely confusing.
 */
function specStaleness(judgment, specPath) {
  const recorded = judgment?.specHash ?? null;
  if (!recorded) return { state: "unrecorded", recorded: null, actual: null };
  const spec = readJson(specPath);
  if (!spec) return { state: "spec-missing", recorded, actual: null };
  const actual = hashSpecDefinition(spec);
  return {
    state: actual === recorded ? "current" : "stale",
    recorded,
    actual,
  };
}

function collectChecks(judgment) {
  const checks = Array.isArray(judgment?.checks) ? judgment.checks : [];
  return checks.map(entry => ({
    item: String(entry?.item ?? "(untitled)"),
    result: String(entry?.result ?? "unknown"),
    cause: entry?.cause ? String(entry.cause) : "",
    confidence: entry?.confidence ? String(entry.confidence) : "",
    detail: String(entry?.detail ?? ""),
    evidenceRefs: Array.isArray(entry?.evidenceRefs)
      ? entry.evidenceRefs.map(String)
      : [],
  }));
}

function collectRunnerEvidence(judgment) {
  const runner = judgment?.runnerEvidence;
  if (!runner || typeof runner !== "object") return [];
  const files = [];
  for (const key of ["tracePath", "harPath", "videoPath"]) {
    if (runner[key]) files.push({ kind: key, path: String(runner[key]) });
  }
  for (const key of ["screenshots", "ariaSnapshots"]) {
    for (const item of Array.isArray(runner[key]) ? runner[key] : []) {
      files.push({ kind: key, path: String(item) });
    }
  }
  return files.map(file => ({ ...file, exists: existsSync(file.path) }));
}

/**
 * @param {string} page
 * @returns {object} report — every field is present even when the stage never ran
 */
export function buildShowReport(page) {
  const paths = artifactPaths(page);
  const judgment = readJson(paths.hermesJudgmentJson);
  // A corrupt artifact and a stage that never ran are different failures:
  // reporting the first as "not run" hides the one an operator must fix.
  const judgmentUnreadable =
    judgment === null && existsSync(paths.hermesJudgmentJson);
  const review = readJson(paths.hermesReviewJson);
  const quarantine = existsSync(paths.runInvalidMarker)
    ? (readJson(paths.runInvalidMarker) ?? {
        reason: "unreadable quarantine marker",
        at: "unknown",
      })
    : null;

  const coverage = judgment?.coverage ?? null;

  return {
    page,
    outputDir: paths.outputDir,
    quarantine,
    judgmentUnreadable,
    judgment: judgment
      ? {
          status: String(judgment.status ?? "unknown"),
          cause: judgment.cause ? String(judgment.cause) : "",
          summary: String(judgment.summary ?? ""),
          recommendedAction: String(judgment.recommendedAction ?? ""),
          runId: judgment.runId ? String(judgment.runId) : "",
          judgedAt: judgment.judgedAt ? String(judgment.judgedAt) : "",
          targetUrl: judgment.targetUrl ? String(judgment.targetUrl) : "",
          targetPath: judgment.targetPath ? String(judgment.targetPath) : "",
          planSource: judgment.planSource ? String(judgment.planSource) : "",
          source: judgment.source ? String(judgment.source) : "",
          agentMeta: judgment.agentMeta ?? null,
          evidence: Array.isArray(judgment.evidence)
            ? judgment.evidence.map(String)
            : [],
        }
      : null,
    spec: specStaleness(judgment, paths.specJson),
    checks: collectChecks(judgment),
    coverage: coverage
      ? {
          planned: Number(coverage.planned ?? 0),
          addressed: Number(coverage.addressed ?? 0),
          missing: Array.isArray(coverage.missing)
            ? coverage.missing.map(String)
            : [],
        }
      : null,
    runnerEvidence: collectRunnerEvidence(judgment),
    review: review
      ? {
          overallReview: String(review.overallReview ?? "unknown"),
          summary: String(review.summary ?? ""),
          reviewedAt: review.reviewedAt ? String(review.reviewedAt) : "",
          criteria: (Array.isArray(review.criteria) ? review.criteria : []).map(
            criterion => ({
              id: String(criterion?.id ?? "criterion"),
              verdict: String(criterion?.verdict ?? "unknown"),
              detail: String(criterion?.detail ?? ""),
            })
          ),
        }
      : null,
    artifacts: Object.entries(paths)
      .filter(([key, value]) => typeof value === "string" && key !== "slug")
      .map(([key, value]) => ({ key, path: value, exists: existsSync(value) }))
      .filter(entry => entry.exists),
  };
}

function table(rows, headers) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => String(row[index]).length))
  );
  const line = cells =>
    `  ${cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  ")}`.trimEnd();
  return [
    line(headers),
    line(widths.map(width => "-".repeat(width))),
    ...rows.map(line),
  ];
}

function checkLines(report, { failedOnly = false } = {}) {
  const checks = failedOnly
    ? report.checks.filter(entry => entry.result !== "pass")
    : report.checks;
  if (checks.length === 0) {
    return [failedOnly ? "  No failing checks." : "  No checks recorded."];
  }
  return table(
    checks.map(entry => [
      entry.result,
      entry.item,
      entry.cause || "-",
      entry.confidence || "-",
      truncate(entry.detail) || "-",
    ]),
    ["RESULT", "ITEM", "CAUSE", "CONF", "DETAIL"]
  );
}

function identityLines(report) {
  const judgment = report.judgment;
  const meta = judgment.agentMeta ?? {};
  const duration =
    typeof meta.durationMs === "number"
      ? `${Math.round(meta.durationMs / 1000)}s`
      : "unknown";
  const spec =
    report.spec.state === "current"
      ? `current (${report.spec.recorded})`
      : report.spec.state === "stale"
        ? `STALE — judged ${report.spec.recorded}, spec on disk is ${report.spec.actual}`
        : report.spec.state === "spec-missing"
          ? `recorded ${report.spec.recorded}, but the spec JSON is missing`
          : "not recorded by this judgment";

  return [
    `  Run:       ${judgment.runId || "(no runId)"}  ${judgment.judgedAt || ""}`.trimEnd(),
    `  Agent:     ${meta.adapter ?? judgment.source ?? "unknown"}${
      meta.model ? ` (${meta.model})` : ""
    }, ${duration}`,
    `  Target:    ${judgment.targetUrl || judgment.targetPath || "(not recorded)"}`,
    `  Plan:      ${judgment.planSource || "(not recorded)"}`,
    `  Spec hash: ${spec}`,
  ];
}

function evidenceLines(report) {
  const lines = ["Artifacts:"];
  for (const artifact of report.artifacts) {
    lines.push(`  ${artifact.key.padEnd(24)} ${shortPath(artifact.path)}`);
  }
  if (report.artifacts.length === 0) lines.push("  none on disk.");

  lines.push("", "Runner evidence:");
  if (report.runnerEvidence.length === 0) {
    lines.push("  none recorded by the judge run.");
  }
  for (const file of report.runnerEvidence) {
    lines.push(
      `  ${file.exists ? "ok     " : "MISSING"} ${file.kind.padEnd(14)} ${shortPath(file.path)}`
    );
  }
  return lines;
}

export function renderShowReport(report, options = {}) {
  if (options.checksOnly) {
    return checkLines(report, { failedOnly: options.failed }).join("\n");
  }
  if (options.evidence) {
    return evidenceLines(report).join("\n");
  }

  const lines = ["", `Page QA — ${report.page}`, ""];

  if (report.quarantine) {
    lines.push(
      "  !!! QUARANTINED — the last judge run failed and produced no verdict !!!",
      `      reason: ${String(report.quarantine.reason ?? "unknown").split("\n").join("\n              ")}`,
      `      at:     ${report.quarantine.at ?? "unknown"}`,
      "      Anything below is from an earlier run, if at all.",
      ""
    );
  }

  if (!report.judgment) {
    lines.push(
      report.judgmentUnreadable
        ? "  Verdict: unreadable — the judgment artifact exists but is not valid JSON."
        : "  Verdict: not run — no judgment artifact for this page.",
      `  Run \`npx playwright-spec-for-ai-agent judge --page=${report.page}\` first.`,
      ""
    );
  } else {
    lines.push(
      `  Verdict: ${report.judgment.status.toUpperCase()}${
        report.judgment.cause && report.judgment.cause !== "NONE"
          ? ` (${report.judgment.cause})`
          : ""
      }`,
      `  Summary: ${report.judgment.summary || "(none)"}`,
      ...(report.judgment.recommendedAction
        ? [`  Action:  ${report.judgment.recommendedAction}`]
        : []),
      "",
      ...identityLines(report),
      "",
      "Checks:",
      ...checkLines(report, { failedOnly: options.failed }),
      ""
    );

    lines.push("Coverage:");
    if (!report.coverage) {
      lines.push("  not recorded by this judgment.");
    } else {
      lines.push(
        `  ${report.coverage.addressed}/${report.coverage.planned} planned checks addressed.`
      );
      if (report.coverage.missing.length) {
        lines.push("  Missing:");
        for (const item of report.coverage.missing) lines.push(`    - ${item}`);
      }
    }
    lines.push("");
  }

  lines.push("Review:");
  if (!report.review) {
    lines.push("  not run.");
  } else {
    lines.push(`  ${report.review.overallReview} — ${report.review.summary}`);
    for (const criterion of report.review.criteria) {
      lines.push(`    ${criterion.verdict.padEnd(8)} ${criterion.id} — ${truncate(criterion.detail)}`);
    }
  }
  lines.push("", ...evidenceLines(report), "");

  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  await ensureProjectConfig(argv);
  const page = parsePageArg(argv);
  const report = buildShowReport(page);

  console.log(
    argv.includes("--json")
      ? JSON.stringify(report, null, 2)
      : renderShowReport(report, {
          checksOnly: argv.includes("--checks-only"),
          failed: argv.includes("--failed"),
          evidence: argv.includes("--evidence"),
        })
  );
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) runMain(main);
