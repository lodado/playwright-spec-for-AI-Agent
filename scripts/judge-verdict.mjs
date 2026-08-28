/**
 * Verdict logic for the judge stage — the only place a "pass" is allowed to
 * survive.
 *
 * Everything here is pure (the one filesystem touch is injectable) so the rules
 * that decide whether a run is green can be tested without a browser, an agent,
 * or a network. The entry script stays orchestration.
 *
 * Every rule is a FLOOR: normalization may lower the agent's own verdict, never
 * raise it. An agent that says `fail` is believed; an agent that says `pass`
 * has to show its work.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";

export const CAUSES = [
  "PRODUCT_DEFECT",
  "SPEC_GAP",
  "ENVIRONMENT_DEFECT",
  "HARNESS_DEFECT",
  "NONE",
];

/**
 * Order in which a top-level cause is derived from the checks. PRODUCT_DEFECT
 * outranks ENVIRONMENT_DEFECT on purpose: one unreachable sub-page must not
 * quarantine (and so hide) four real product failures.
 */
const CAUSE_PRIORITY = [
  "PRODUCT_DEFECT",
  "ENVIRONMENT_DEFECT",
  "SPEC_GAP",
  "HARNESS_DEFECT",
];

const CHECK_RESULTS = new Set(["pass", "fail", "skip", "manual_review"]);
const STATUSES = new Set(["pass", "fail", "manual_review"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const SEVERITY = { pass: 0, manual_review: 1, fail: 2 };

/** Live policies that let the agent write to the app under test. */
const MUTATING_POLICIES = new Set([
  "executable-interaction",
  "judgment-interaction-no-confirm",
]);

export const JUDGE_TURNS_MIN = 20;
export const JUDGE_TURNS_MAX = 150;

function worst(a, b) {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

function normalizeItem(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * An agent that cannot classify its own failure IS the defect, so an unknown or
 * missing cause on a non-pass check becomes HARNESS_DEFECT rather than a guess
 * at the product being broken. A passing check never carries a cause.
 */
export function normalizeCause(value, { result = "fail" } = {}) {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (result === "pass") return "NONE";
  if (result === "skip") return CAUSES.includes(raw) ? raw : "NONE";
  return CAUSES.includes(raw) && raw !== "NONE" ? raw : "HARNESS_DEFECT";
}

const QUOTED_VALUE = /(?:"[^"]{2,}"|'[^']{2,}'|“[^”]{2,}”)/;
const URL_PATH = /(?:https?:\/\/\S+|(?:^|[\s(,])\/[A-Za-z0-9][^\s,)]*)/;
const NUMBER_WITH_UNIT =
  /(?:[$€£₩]\s?\d|\b\d[\d.,]*\s*(?:%|ms\b|s\b|px\b|kb\b|mb\b|items?\b|rows?\b|results?\b|credits?\b|점|개|원))/i;

/** Every file the runner actually captured, by full path and by basename. */
export function collectEvidenceArtifacts(runnerEvidence) {
  const files = [
    runnerEvidence?.tracePath,
    runnerEvidence?.harPath,
    runnerEvidence?.videoPath,
    ...(runnerEvidence?.screenshots ?? []),
    ...(runnerEvidence?.ariaSnapshots ?? []),
  ].filter(Boolean);
  const set = new Set();
  for (const file of files) {
    set.add(String(file));
    set.add(basename(String(file)));
  }
  return set;
}

/**
 * "I checked it and it was fine" is not evidence. Concrete means either an
 * `evidenceRefs` entry that resolves to a file the runner really captured, or a
 * `detail` that quotes something observed: a quoted string, a URL/path, or a
 * number carrying a unit.
 */
export function hasConcreteEvidence(
  check,
  runnerEvidence = null,
  { fileExists = existsSync } = {}
) {
  const artifacts = collectEvidenceArtifacts(runnerEvidence);
  for (const ref of check?.evidenceRefs ?? []) {
    const value = String(ref ?? "").trim();
    if (!value) continue;
    if (artifacts.has(value) || artifacts.has(basename(value))) return true;
    try {
      if (fileExists(value)) return true;
    } catch {
      // An unusable path is simply not evidence.
    }
  }

  const detail = String(check?.detail ?? "");
  return (
    QUOTED_VALUE.test(detail) ||
    URL_PATH.test(detail) ||
    NUMBER_WITH_UNIT.test(detail)
  );
}

/**
 * Real agents paraphrase a title even when told not to — dropping a project's
 * `"to be: "` prefix, or re-adding the scenario name. Exact-only matching read
 * that as "nothing was checked" and floored a complete run to manual_review, so
 * the ladder falls back to containment. The shorter side must still be
 * substantial and the match unambiguous, and each reported check can satisfy
 * only one planned item, so a single vague line cannot cover a whole plan.
 */
const MIN_FUZZY_MATCH_LENGTH = 8;

function containsEitherWay(a, b) {
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_FUZZY_MATCH_LENGTH && long.includes(short);
}

/**
 * Pair each planned check with at most one reported check, and report what was
 * left over on both sides. Coverage and the evidence manifest must agree on
 * this: when they used different rungs, a paraphrased title counted as covered
 * in one and as never-reported in the other.
 *
 * @returns {{ pairs: Map<string, object>, missing: string[], unplanned: object[] }}
 */
export function pairPlannedChecks(plannedChecks = [], checks = []) {
  const reported = checks.map(check => ({
    check,
    raw: String(check?.item ?? ""),
    norm: normalizeItem(check?.item),
    used: false,
  }));
  const pairs = new Map();
  const missing = [];

  for (const item of plannedChecks) {
    const norm = normalizeItem(item);
    let hit =
      reported.find(entry => !entry.used && entry.raw === item) ??
      reported.find(entry => !entry.used && entry.norm === norm);
    if (!hit) {
      // Several candidates is not ambiguity worth failing on — the same title
      // is judged once per scenario. Take the closest in length; consumption
      // still stops one vague line from covering the rest of the plan.
      hit = reported
        .filter(entry => !entry.used && containsEitherWay(entry.norm, norm))
        .sort(
          (a, b) =>
            Math.abs(a.norm.length - norm.length) -
            Math.abs(b.norm.length - norm.length)
        )[0];
    }
    if (hit) {
      hit.used = true;
      pairs.set(item, hit.check);
    } else {
      missing.push(item);
    }
  }

  return {
    pairs,
    missing,
    unplanned: reported.filter(entry => !entry.used).map(entry => entry.check),
  };
}

/** @returns {{ planned: number, addressed: number, missing: string[] }} */
export function buildCoverage(plannedChecks = [], checks = []) {
  const { missing } = pairPlannedChecks(plannedChecks, checks);
  return {
    planned: plannedChecks.length,
    addressed: plannedChecks.length - missing.length,
    missing,
  };
}

export function isReadOnlyPlan(checklist = []) {
  return !checklist.some(test => MUTATING_POLICIES.has(test?.liveRunPolicy));
}

function dedupeViolations(violations = []) {
  const seen = new Set();
  const unique = [];
  for (const violation of violations) {
    if (!violation?.kind) continue;
    const key = `${violation.kind}|${violation.detail ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ kind: violation.kind, detail: String(violation.detail ?? "") });
  }
  return unique;
}

/**
 * Post-run HAR inspection — the only guard available with a blocking adapter,
 * whose spawnSync freezes the event loop so no live `context.route` handler can
 * run. `allowedOrigins` is the staging origin set; with none configured there is
 * nothing to compare a request against, so mutation analysis is skipped rather
 * than guessed at.
 */
export function analyzeHarViolations(
  har,
  { allowedOrigins = [], readOnly = true } = {}
) {
  const entries = har?.log?.entries ?? [];
  const allowed = new Set(
    allowedOrigins.map(origin => {
      try {
        return new URL(origin).origin;
      } catch {
        return String(origin);
      }
    })
  );
  const violations = [];

  for (const entry of entries) {
    const url = entry?.request?.url;
    if (!url) continue;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const method = String(entry?.request?.method ?? "GET").toUpperCase();
    const isDocument = entry?._resourceType === "document";

    if (allowed.size > 0 && isDocument && !allowed.has(parsed.origin)) {
      violations.push({ kind: "off-origin-navigation", detail: url });
      continue;
    }
    if (
      readOnly &&
      allowed.has(parsed.origin) &&
      method !== "GET" &&
      method !== "HEAD"
    ) {
      violations.push({
        kind: "unexpected-mutation",
        detail: `${method} ${parsed.pathname}`,
      });
    }
  }

  return dedupeViolations(violations);
}

/**
 * One rule per violation kind, applied as a floor:
 * - off-origin-navigation: the run left the site under test, so nothing it
 *   reports about the target can be trusted -> `fail`, cause HARNESS_DEFECT.
 * - unexpected-mutation / blocked-mutation: a write landed on a read-only plan,
 *   so staging state may have changed -> `manual_review` for a human.
 * Any other kind (capture-failed, route-error) is recorded but does not move
 * the verdict: a missing screenshot is not a product signal.
 */
function violationFloor(kind) {
  if (kind === "off-origin-navigation") return "fail";
  if (
    kind === "unexpected-mutation" ||
    kind === "blocked-mutation" ||
    // The page was in a different account state than the project configured, so
    // the checks that ran are not the ones anyone planned.
    kind === "account-state-mismatch"
  ) {
    return "manual_review";
  }
  return "pass";
}

function deriveCause({ status, declared, checks, violations }) {
  if (status === "pass") return "NONE";
  if (violations.some(violation => violation.kind === "off-origin-navigation")) {
    return "HARNESS_DEFECT";
  }
  if (violations.some(violation => violation.kind === "account-state-mismatch")) {
    return "ENVIRONMENT_DEFECT";
  }
  const raw = typeof declared === "string" ? declared.trim().toUpperCase() : "";
  if (CAUSES.includes(raw) && raw !== "NONE") return raw;
  for (const cause of CAUSE_PRIORITY) {
    if (checks.some(check => check.cause === cause)) return cause;
  }
  return "HARNESS_DEFECT";
}

/**
 * @param {object} raw agent JSON
 * @param {{ plannedChecks?: string[], runnerEvidence?: object|null,
 *           violations?: Array<{kind:string,detail?:string}>,
 *           fileExists?: (path: string) => boolean }} [options]
 */
/**
 * The `data-testid` values the parser positively read for a check — the only
 * locator kind that is a stable contract rather than rendered content.
 *
 * @returns {Map<string, string[]>} normalized check title -> test ids
 */
export function collectContractHints(spec) {
  const hints = new Map();
  for (const scenario of spec?.scenarios ?? []) {
    for (const test of scenario?.tests ?? []) {
      const ids = (test?.expectations ?? [])
        .map(expectation => expectation?.locator)
        .filter(locator => locator?.kind === "testId")
        .map(locator => String(locator.value ?? "").trim())
        .filter(Boolean);
      if (ids.length) hints.set(normalizeItem(test.title), [...new Set(ids)]);
    }
  }
  return hints;
}

/**
 * Did the judge confirm any of this check's contract points on the page?
 *
 * The declared field is the primary answer; quoting an id in `detail` or citing
 * it as an evidence ref counts too, so a judge that reports well in prose is not
 * punished for skipping a field.
 */
export function confirmsContract(check, ids = []) {
  if (ids.length === 0) return true;
  const declared = Array.isArray(check?.observedTestIds)
    ? check.observedTestIds.map(id => String(id).trim().toLowerCase())
    : [];
  const haystack = [
    String(check?.detail ?? ""),
    ...(check?.evidenceRefs ?? []).map(String),
  ]
    .join(" ")
    .toLowerCase();
  return ids.some(
    id => declared.includes(id.toLowerCase()) || haystack.includes(id.toLowerCase())
  );
}

export function normalizeBrowseDecision(raw = {}, options = {}) {
  const {
    plannedChecks = [],
    runnerEvidence = null,
    violations = [],
    contractHints = new Map(),
    fileExists,
  } = options;
  const evidenceOptions = fileExists ? { fileExists } : {};
  const floorNotes = [];
  const hintsFor = item => contractHints.get(normalizeItem(item)) ?? [];

  const checks = (Array.isArray(raw.checks) ? raw.checks : []).map(check => {
    const item = String(check?.item ?? "Untitled check");
    const detail = String(check?.detail ?? "");
    const evidenceRefs = Array.isArray(check?.evidenceRefs)
      ? check.evidenceRefs.map(String)
      : [];
    // A missing `confidence` is not a claim of low confidence — the evidence
    // predicate below already gates the pass. Only an explicit `low` demotes.
    const confidence = CONFIDENCES.has(check?.confidence)
      ? check.confidence
      : "medium";

    let result = CHECK_RESULTS.has(check?.result) ? check.result : "manual_review";
    let demotedFrom = null;
    if (result === "pass") {
      if (confidence === "low") {
        result = "manual_review";
        demotedFrom = "pass";
        floorNotes.push(`"${item}" passed with low confidence`);
      } else if (
        !hasConcreteEvidence({ detail, evidenceRefs }, runnerEvidence, evidenceOptions)
      ) {
        result = "manual_review";
        demotedFrom = "pass";
        floorNotes.push(`"${item}" passed without citing concrete evidence`);
      } else if (!confirmsContract({ ...check, detail, evidenceRefs }, hintsFor(item))) {
        // The plan is intent-level on purpose, so nothing static can prove it
        // describes the same check the source asserts on. The page can: the
        // parser read these test ids from the source, and the judge was looking
        // at the live DOM. None confirmed means the judge verified something
        // else, or the contract point is gone — either way not a pass.
        result = "manual_review";
        demotedFrom = "pass";
        floorNotes.push(
          `"${item}" passed without confirming ${hintsFor(item).join(", ")} on the page`
        );
      }
    }

    return {
      item,
      detail,
      result,
      confidence,
      cause: normalizeCause(check?.cause, { result }),
      evidenceRefs,
      ...(Array.isArray(check?.observedTestIds) && check.observedTestIds.length
        ? { observedTestIds: check.observedTestIds.map(String) }
        : {}),
      ...(demotedFrom ? { demotedFrom } : {}),
    };
  });

  const coverage = buildCoverage(plannedChecks, checks);
  const uniqueViolations = dedupeViolations(violations);

  // A run where nothing was actually executed (all skip, e.g. login failure)
  // must never report green — same principle as pytest exit code 5 / Playwright
  // "no tests found".
  const executed = checks.filter(check => check.result !== "skip");
  let derived = checks.some(check => check.result === "fail")
    ? "fail"
    : checks.some(check => check.result === "manual_review") ||
        executed.length === 0
      ? "manual_review"
      : "pass";

  if (coverage.missing.length > 0) {
    derived = worst(derived, "manual_review");
    floorNotes.push(
      `${coverage.missing.length} planned check(s) unaddressed: ${coverage.missing.join(", ")}`
    );
  }
  for (const violation of uniqueViolations) {
    const floor = violationFloor(violation.kind);
    if (floor !== "pass") {
      derived = worst(derived, floor);
      floorNotes.push(`${violation.kind}: ${violation.detail}`);
    }
  }

  // Normalization may only downgrade the agent's own verdict, never upgrade
  // it: if the agent said manual_review/fail, checks cannot turn that into pass.
  const agentStatus = STATUSES.has(raw.status) ? raw.status : null;
  const status = agentStatus ? worst(agentStatus, derived) : derived;

  const summary = String(raw.summary ?? "Hermes QA judgment completed.");
  return {
    status,
    cause: deriveCause({
      status,
      declared: raw.cause,
      checks,
      violations: uniqueViolations,
    }),
    summary: floorNotes.length
      ? `${summary}\n\nVerdict floor applied — ${floorNotes.join("; ")}.`
      : summary,
    checks,
    coverage,
    evidence: Array.isArray(raw.evidence) ? raw.evidence.map(String) : [],
    recommendedAction: raw.recommendedAction ?? "",
    source: raw.source ?? "hermes-agent",
    violations: uniqueViolations,
    ...(raw.agentMeta ? { agentMeta: raw.agentMeta } : {}),
  };
}

/**
 * Planned check -> verdict + evidence, plus an explicit marker for every planned
 * check the agent never mentioned. Checks the agent invented (not in the plan)
 * are listed too, with `planned: false`.
 */
export function buildEvidenceManifest({
  plannedChecks = [],
  checks = [],
  runnerEvidence = null,
} = {}) {
  const { pairs, unplanned } = pairPlannedChecks(plannedChecks, checks);

  const items = plannedChecks.map(item => {
    const check = pairs.get(item);
    if (!check) {
      return {
        item,
        planned: true,
        addressed: false,
        result: "unaddressed",
        cause: "HARNESS_DEFECT",
        detail: "The agent never reported this planned check.",
        evidenceRefs: [],
      };
    }
    return {
      item,
      planned: true,
      addressed: true,
      result: check.result,
      cause: check.cause,
      detail: check.detail,
      evidenceRefs: check.evidenceRefs,
    };
  });

  for (const check of unplanned) {
    items.push({
      item: check.item,
      planned: false,
      addressed: true,
      result: check.result,
      cause: check.cause,
      detail: check.detail,
      evidenceRefs: check.evidenceRefs,
    });
  }

  return { items, runnerEvidence: runnerEvidence ?? null };
}

/**
 * Turn budget scaled to the plan: a 3-test page never needed 150 turns, and a
 * 30-test page should not be cut off at a flat one. QA_JUDGE_MAX_TURNS wins.
 */
export function resolveJudgeTurnBudget(
  executableTests,
  override = process.env.QA_JUDGE_MAX_TURNS
) {
  const parsed = Number(override);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  const scaled = 12 + 8 * Math.max(0, Number(executableTests) || 0);
  return Math.min(JUDGE_TURNS_MAX, Math.max(JUDGE_TURNS_MIN, scaled));
}
