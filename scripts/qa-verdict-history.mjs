/**
 * Verdict history — the only place a nondeterministic check becomes visible.
 *
 * One night's verdict cannot distinguish a real regression from a check that
 * simply does not settle. Only the sequence can, and only within a single
 * `specHash`: a verdict that changed after the spec changed is a new
 * expectation, not a flake.
 *
 * Every threshold below is policy, so each is a named parameter with a
 * documented default rather than a literal buried in a branch.
 */
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { readArtifact, withSchema } from "./artifact-schema.mjs";

/** How many runs the ring keeps; older runs stop being evidence of anything. */
export const DEFAULT_KEEP = 30;
/** How many recent same-spec runs flakiness looks at. */
export const DEFAULT_WINDOW = 10;
/** Share of transitions that must flip before a check is called flaky. */
export const DEFAULT_THRESHOLD = 0.3;
/** Runs that must agree before a verdict is considered stable (n-of-m). */
export const DEFAULT_SAMPLES = 3;

function normalizeVerdict(verdict) {
  return {
    runId: verdict?.runId ?? null,
    judgedAt: verdict?.judgedAt ?? new Date().toISOString(),
    status: typeof verdict?.status === "string" ? verdict.status : "unknown",
    specHash: verdict?.specHash ?? null,
    checks: (Array.isArray(verdict?.checks) ? verdict.checks : []).map(check => ({
      item: String(check?.item ?? ""),
      result: typeof check?.result === "string" ? check.result : "unknown",
    })),
  };
}

/** @returns {{ runs: Array<object> }} — an absent history reads as empty, not as an error. */
export function readHistory(historyPath) {
  if (!existsSync(historyPath)) return { runs: [] };
  const parsed = readArtifact(historyPath);
  return { ...parsed, runs: Array.isArray(parsed?.runs) ? parsed.runs : [] };
}

/** Accepts the history object or a bare runs array, so callers can pass either. */
function runsOf(history) {
  if (Array.isArray(history)) return history;
  return Array.isArray(history?.runs) ? history.runs : [];
}

/**
 * Append one run to the bounded ring, oldest first, written atomically — a
 * crashed nightly must not leave a half-written history that reads as clean.
 */
export function appendVerdict(historyPath, verdict, { keep = DEFAULT_KEEP } = {}) {
  const limit = Math.max(1, keep);
  const runs = [...runsOf(readHistory(historyPath)), normalizeVerdict(verdict)].slice(
    -limit
  );
  const history = withSchema(
    { updatedAt: new Date().toISOString(), keep: limit, runs },
    "verdict-history"
  );
  const temporary = `${historyPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(history, null, 2)}\n`);
  renameSync(temporary, historyPath);
  return history;
}

/** The cohort every rule below is computed over: same spec, most recent first N. */
function cohortFor(history, window) {
  const runs = runsOf(history);
  const specHash = runs.length ? runs[runs.length - 1].specHash ?? null : null;
  const sameSpec = runs.filter(run => (run?.specHash ?? null) === specHash);
  return { specHash, cohort: sameSpec.slice(-Math.max(1, window)) };
}

function countFlips(results) {
  let flips = 0;
  for (let index = 1; index < results.length; index += 1) {
    if (results[index] !== results[index - 1]) flips += 1;
  }
  return flips;
}

/**
 * @param {object|Array} history
 * @param {{ window?: number, threshold?: number }} [policy]
 */
export function flakinessReport(
  history,
  { window = DEFAULT_WINDOW, threshold = DEFAULT_THRESHOLD } = {}
) {
  const { specHash, cohort } = cohortFor(history, window);

  const byItem = new Map();
  for (const run of cohort) {
    for (const check of Array.isArray(run?.checks) ? run.checks : []) {
      const item = String(check?.item ?? "");
      if (!byItem.has(item)) byItem.set(item, []);
      byItem.get(item).push(check?.result ?? "unknown");
    }
  }

  const checks = [...byItem.entries()].map(([item, lastResults]) => {
    const flips = countFlips(lastResults);
    // flipRate is flips per transition, so two runs can already be 1.0 — but a
    // single run has no transition to flip and can never be flaky.
    const flipRate = lastResults.length > 1 ? flips / (lastResults.length - 1) : 0;
    return {
      item,
      runs: lastResults.length,
      flips,
      flipRate,
      flaky: lastResults.length > 1 && flipRate >= threshold,
      lastResults,
    };
  });

  const verdicts = cohort.map(run => run?.status ?? "unknown");
  const verdictFlips = countFlips(verdicts);
  const verdictFlipRate =
    verdicts.length > 1 ? verdictFlips / (verdicts.length - 1) : 0;

  return {
    specHash,
    window,
    threshold,
    checks,
    summary: {
      runs: cohort.length,
      checks: checks.length,
      flakyChecks: checks.filter(check => check.flaky).length,
      flakyItems: checks.filter(check => check.flaky).map(check => check.item),
      verdictFlips,
      verdictFlipRate,
      verdictFlaky: verdicts.length > 1 && verdictFlipRate >= threshold,
    },
  };
}

/**
 * n-of-m rule: over the last `samples` same-spec runs, the verdict is stable
 * only when one status holds a strict majority AND the sample is full — so
 * 2-of-3 agreeing counts, 1-of-2 and a first-ever run do not.
 */
export function stableVerdict(history, { samples = DEFAULT_SAMPLES } = {}) {
  const { specHash, cohort } = cohortFor(history, samples);
  if (!cohort.length) {
    return { verdict: null, agreement: 0, unstable: true, considered: 0, samples, specHash };
  }

  const counts = new Map();
  for (const run of cohort) {
    const status = run?.status ?? "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  let verdict = cohort[cohort.length - 1]?.status ?? "unknown";
  let best = 0;
  for (const [status, count] of counts) {
    if (count > best) {
      best = count;
      verdict = status;
    }
  }

  const agreement = best / cohort.length;
  return {
    verdict,
    agreement,
    unstable: cohort.length < samples || agreement <= 0.5,
    considered: cohort.length,
    samples,
    specHash,
  };
}
