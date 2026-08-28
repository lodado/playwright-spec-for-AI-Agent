/**
 * CTRF (Common Test Report Format) projection of a judgment.
 *
 * `judgment.checks[]` is this package's own shape and no dashboard can read it.
 * CTRF is the one public JSON test-report schema that the GitHub, Slack, Jira
 * and Jenkins reporters already consume, so the verdict is projected onto it
 * rather than published as-is.
 *
 * Field names follow ctrf-io/ctrf `schema/ctrf.schema.json`. Anything that
 * schema has no home for — cause, confidence, evidence refs, coverage — goes
 * under `extra`, the schema's own extension point; an invented top-level key
 * would simply fail validation.
 */
import { writeFileSync } from "node:fs";

/** The spec version this projection targets; the shape also validates under 1.0.0. */
export const CTRF_SPEC_VERSION = "0.0.0";

const GENERATED_BY = "playwright-spec-for-ai-agent";

const STATUS_MAP = {
  pass: "passed",
  fail: "failed",
  skip: "skipped",
  manual_review: "other",
};

/** An unrecognised result maps to `other`, never to `passed`. */
export function ctrfStatus(result) {
  return STATUS_MAP[result] ?? "other";
}

function compact(object) {
  return Object.fromEntries(
    Object.entries(object).filter(
      ([, value]) => value !== undefined && value !== null
    )
  );
}

function nested(object) {
  const value = compact(object);
  return Object.keys(value).length ? value : undefined;
}

/**
 * @param {object} judgment — a judgment artifact; every field is optional here,
 *   so an artifact written by an older version still produces a valid report.
 * @param {{ page?: string, tool?: { name?: string, version?: string } }} [meta]
 */
export function toCtrf(judgment, { page = "", tool = {} } = {}) {
  const agentMeta = judgment?.agentMeta ?? {};
  const durationMs = Number.isFinite(agentMeta.durationMs)
    ? Math.max(0, Math.round(agentMeta.durationMs))
    : 0;
  const judgedAt = Date.parse(judgment?.judgedAt ?? "");
  const stop = Number.isNaN(judgedAt) ? 0 : judgedAt;

  const tests = (Array.isArray(judgment?.checks) ? judgment.checks : []).map(
    (check, index) => {
      const detail = String(check?.detail ?? "").trim();
      return compact({
        name: String(check?.item ?? `check ${index + 1}`),
        status: ctrfStatus(check?.result),
        // The judge scores every check inside one agent pass, so per-check
        // timing does not exist; the whole run's time lives on the summary.
        duration: 0,
        message: detail || undefined,
        rawStatus: typeof check?.result === "string" ? check.result : undefined,
        extra: nested({
          cause: check?.cause,
          confidence: check?.confidence,
          evidenceRefs: Array.isArray(check?.evidenceRefs)
            ? check.evidenceRefs
            : undefined,
        }),
      });
    }
  );

  const count = status => tests.filter(test => test.status === status).length;

  return compact({
    reportFormat: "CTRF",
    specVersion: CTRF_SPEC_VERSION,
    reportId: judgment?.runId || undefined,
    timestamp: judgment?.judgedAt || undefined,
    generatedBy: GENERATED_BY,
    results: compact({
      tool: compact({
        name: tool.name || agentMeta.adapter || GENERATED_BY,
        version: tool.version || agentMeta.model || undefined,
      }),
      summary: {
        tests: tests.length,
        passed: count("passed"),
        failed: count("failed"),
        pending: count("pending"),
        skipped: count("skipped"),
        other: count("other"),
        start: Math.max(0, stop - durationMs),
        stop,
        duration: durationMs,
      },
      tests,
      environment: nested({
        reportName: page ? `${page} QA` : undefined,
        testEnvironment: judgment?.targetUrl || undefined,
      }),
      extra: nested({
        page: page || undefined,
        status: judgment?.status,
        cause: judgment?.cause,
        summary: judgment?.summary,
        recommendedAction: judgment?.recommendedAction,
        source: judgment?.source,
        planSource: judgment?.planSource,
        specHash: judgment?.specHash,
        targetPath: judgment?.targetPath,
        coverage: judgment?.coverage,
        evidence: Array.isArray(judgment?.evidence)
          ? judgment.evidence
          : undefined,
        runnerEvidence: judgment?.runnerEvidence,
      }),
    }),
  });
}

/** @returns {object} the report that was written, so the caller can cite it. */
export function writeCtrf(path, judgment, meta = {}) {
  const report = toCtrf(judgment, meta);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
