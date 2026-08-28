/**
 * GitHub Actions step summary — CI-native output for the nightly run.
 *
 * A verdict buried in job logs is a verdict nobody reads; `$GITHUB_STEP_SUMMARY`
 * puts it on the run page instead. Every failure here is swallowed on purpose:
 * a broken or read-only CI environment must never be the reason a QA run fails.
 */
import { appendFileSync } from "node:fs";

const DEFAULT_LIMIT = 10;
const MAX_CELL = 120;

const STATUS_LABELS = {
  pass: "PASS",
  fail: "FAIL",
  manual_review: "MANUAL REVIEW",
  skip: "SKIPPED",
};

/** Pipes and newlines would break out of a markdown cell, so neither survives. */
function cell(value, max = MAX_CELL) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .replaceAll("|", "\\|")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function table(headers, rows, limit) {
  if (!rows.length) return "";
  const shown = rows.slice(0, Math.max(1, limit));
  const hidden = rows.length - shown.length;
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...shown.map(row => `| ${row.join(" | ")} |`),
    ...(hidden ? ["", `+${hidden} more`] : []),
  ].join("\n");
}

/** @returns {boolean} whether anything was written — false outside GitHub Actions. */
export function appendStepSummary(markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return false;
  try {
    appendFileSync(path, `${String(markdown ?? "").trimEnd()}\n\n`);
    return true;
  } catch {
    return false;
  }
}

export function renderChecksTable(checks, { limit = DEFAULT_LIMIT } = {}) {
  const rows = (Array.isArray(checks) ? checks : []).map(check => [
    cell(check?.item ?? "(unnamed)"),
    cell(check?.result ?? "unknown", 20),
    cell(check?.detail ?? ""),
  ]);
  return table(["Check", "Result", "Detail"], rows, limit);
}

export function renderRunTable(rows, { limit = 25 } = {}) {
  const body = (Array.isArray(rows) ? rows : []).map(row => [
    cell(row?.page ?? "(unknown)", 60),
    cell(row?.status ?? "unknown", 20),
    Number.isFinite(row?.total)
      ? cell(`${row?.failed ?? 0}/${row.total} failing`, 30)
      : "—",
    cell(row?.runId ?? "—", 40),
  ]);
  return table(["Page", "Status", "Checks", "Run"], body, limit);
}

/**
 * @param {object} judgment — read defensively; an older artifact renders fine.
 * @param {{ page?: string, limit?: number }} [meta]
 */
export function renderJudgmentSummary(
  judgment,
  { page = "", limit = DEFAULT_LIMIT } = {}
) {
  const status = typeof judgment?.status === "string" ? judgment.status : "unknown";
  const label = STATUS_LABELS[status] ?? "UNKNOWN";
  const agentMeta = judgment?.agentMeta ?? {};
  const identity = [
    judgment?.runId ? `run \`${cell(judgment.runId, 40)}\`` : "",
    agentMeta.adapter
      ? `${cell(agentMeta.adapter, 40)}${agentMeta.model ? ` (${cell(agentMeta.model, 40)})` : ""}`
      : "",
    judgment?.judgedAt ? cell(judgment.judgedAt, 40) : "",
  ].filter(Boolean);

  const coverage = judgment?.coverage;
  const missing = Array.isArray(coverage?.missing) ? coverage.missing : [];
  const evidence = Array.isArray(judgment?.evidence) ? judgment.evidence : [];
  const checksTable = renderChecksTable(judgment?.checks, { limit });

  return [
    `### ${page ? `${page} ` : ""}QA — ${label}`,
    "",
    [
      `**Status:** ${cell(status, 40)}`,
      judgment?.cause ? `**Cause:** ${cell(judgment.cause, 40)}` : "",
      ...identity,
    ]
      .filter(Boolean)
      .join(" · "),
    ...(judgment?.summary ? ["", cell(judgment.summary, 600)] : []),
    ...(checksTable ? ["", checksTable] : []),
    ...(Number.isFinite(coverage?.planned)
      ? [
          "",
          `**Coverage:** ${coverage.addressed ?? 0}/${coverage.planned} addressed${
            missing.length
              ? ` — missing: ${missing.slice(0, limit).map(item => cell(item, 60)).join(", ")}`
              : ""
          }`,
        ]
      : []),
    ...(evidence.length
      ? [
          "",
          `**Evidence:** ${evidence
            .slice(0, limit)
            .map(item => cell(String(item).split("/").pop(), 60))
            .join(", ")}`,
        ]
      : []),
  ].join("\n");
}
