/**
 * Verdict logic for the judge stage — the only place a "pass" is allowed to
 * survive.
 *
 * Rules can be tested against captured files without a browser, agent, or
 * network. The entry script handles orchestration.
 *
 * Every rule is a FLOOR: normalization may lower the agent's own verdict, never
 * raise it. An agent that says `fail` is believed; an agent that says `pass`
 * has to show its work.
 */
import { accessSync, constants, readFileSync, statSync } from "node:fs";
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

/** Paths recorded by the runner for this run, never agent-supplied paths. */
export function collectEvidenceArtifacts(runnerEvidence) {
  return new Set([
    runnerEvidence?.tracePath,
    runnerEvidence?.harPath,
    runnerEvidence?.videoPath,
    ...(Array.isArray(runnerEvidence?.screenshots) ? runnerEvidence.screenshots : []),
    ...(Array.isArray(runnerEvidence?.ariaSnapshots) ? runnerEvidence.ariaSnapshots : []),
  ].filter(file => typeof file === "string" && file.length > 0));
}

/** Resolve citations against this run's captures; prose alone is not evidence. */
function resolveEvidenceRefs(check, runnerEvidence, {
  ariaCache = new Map(),
  readText = file => readFileSync(file, "utf8"),
  fileExists = file => {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size === 0) return false;
    accessSync(file, constants.R_OK);
    return true;
  },
} = {}) {
  const foreignCheckpoints = new Set((runnerEvidence?.checkpoints ?? [])
    .filter(checkpoint => checkpoint.checkId !== check?.checkId)
    .flatMap(checkpoint => checkpoint.evidenceRefs ?? []));
  const artifacts = [...collectEvidenceArtifacts(runnerEvidence)].filter(file => !foreignCheckpoints.has(file));
  const cited = new Set();
  const refs = Array.isArray(check?.evidenceRefs) ? check.evidenceRefs : [];
  for (const ref of refs) {
    if (typeof ref !== "string" || !ref.trim()) continue;
    const value = ref.trim();
    const matches = artifacts.filter(file =>
      file === value || (value === basename(value) && basename(file) === value)
    );
    try {
      if (matches.length === 1 && fileExists(matches[0])) cited.add(matches[0]);
    } catch {
      // An unreadable capture cannot support a pass.
    }
  }
  if (cited.size) return [...cited];

  const quotes = [...String(check?.detail ?? "").matchAll(/"([^"\n]*)"|'([^'\n]*)'|“([^”\n]*)”/g)]
    .map(match => (match[1] ?? match[2] ?? match[3]).replace(/\s+/g, " ").trim());
  if (!quotes.length || quotes.some(quote => quote.length < 2)) return [];
  const patterns = quotes.map(quote => new RegExp(
    "(^|[^\\p{L}\\p{N}_])" + quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|[^\\p{L}\\p{N}_])",
    "u"
  ));
  for (const file of Array.isArray(runnerEvidence?.ariaSnapshots) ? runnerEvidence.ariaSnapshots : []) {
    if (!artifacts.includes(file)) continue;
    if (!ariaCache.has(file)) {
      ariaCache.set(file, null);
      try {
        if (fileExists(file)) ariaCache.set(file, readText(file).replace(/\s+/g, " "));
      } catch {
        // Cache unavailable evidence too, but never across normalization calls.
      }
    }
    const snapshot = ariaCache.get(file);
    if (snapshot !== null && patterns.every(pattern => pattern.test(snapshot))) return [file];
  }
  return [];
}

export function hasConcreteEvidence(check, runnerEvidence = null, options = {}) {
  return resolveEvidenceRefs(check, runnerEvidence, options).length > 0;
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
 * @returns {{ pairs: Map<number, object>, missing: string[], unplanned: object[] }}
 */
export function pairPlannedChecks(plannedChecks = [], checks = []) {
  const reported = checks.map(check => ({
    check,
    raw: String(check?.item ?? ""),
    norm: normalizeItem(check?.item),
    used: false,
  }));
  const byId = new Map();
  for (const entry of reported) {
    const id = entry.check?.checkId;
    if (typeof id === "string" && id) byId.set(id, byId.has(id) ? null : entry);
  }
  const planCounts = new Map();
  for (const planned of plannedChecks) {
    if (typeof planned?.checkId === "string" && planned.checkId) {
      planCounts.set(planned.checkId, (planCounts.get(planned.checkId) ?? 0) + 1);
    }
  }
  const pairs = new Map();
  const missing = [];
  const missingCheckIds = [];
  plannedChecks.forEach((planned, index) => {
    const identified = typeof planned !== "string";
    const item = identified ? String(planned?.item ?? "") : planned;
    const id = identified ? planned?.checkId : null;
    let hit;
    if (identified) {
      if (typeof id === "string" && id && planCounts.get(id) === 1) hit = byId.get(id);
    } else {
      const norm = normalizeItem(item);
      hit = reported.find(entry => !entry.used && entry.raw === item)
        ?? reported.find(entry => !entry.used && entry.norm === norm);
      if (!hit) {
        hit = reported
          .filter(entry => !entry.used && containsEitherWay(entry.norm, norm))
          .sort((a, b) => Math.abs(a.norm.length - norm.length) - Math.abs(b.norm.length - norm.length))[0];
      }
    }
    if (hit && !hit.used) {
      hit.used = true;
      pairs.set(index, hit.check);
    } else {
      missing.push(item);
      if (identified) missingCheckIds.push(typeof id === "string" ? id : null);
    }
  });
  return {
    pairs,
    missing,
    missingCheckIds,
    unplanned: reported.filter(entry => !entry.used).map(entry => entry.check),
  };
}

/** @returns {{ planned: number, addressed: number, missing: string[] }} */
export function buildCoverage(plannedChecks = [], checks = []) {
  const { missing, missingCheckIds, unplanned } = pairPlannedChecks(plannedChecks, checks);
  return {
    planned: plannedChecks.length,
    addressed: plannedChecks.length - missing.length,
    missing,
    ...(plannedChecks.some(check => typeof check !== "string") ? {
      missingCheckIds,
      unplannedCheckIds: unplanned.map(check => check.checkId ?? null),
    } : {}),
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
 * @param {{ plannedChecks?: Array<string|{checkId: string, item: string}>, runnerEvidence?: object|null,
 *           violations?: Array<{kind:string,detail?:string}>,
 *           fileExists?: (path: string) => boolean }} [options]
 */
export function normalizeBrowseDecision(raw = {}, options = {}) {
  const {
    plannedChecks = [],
    runnerEvidence = null,
    violations = [],
    fileExists,
    readText,
  } = options;
  const evidenceOptions = { fileExists, readText, ariaCache: new Map() };
  const plannedById = new Map(plannedChecks.filter(check => check?.checkId).map(check => [check.checkId, check]));
  const plannedByItem = new Map();
  for (const planned of plannedChecks) {
    if (typeof planned?.item === "string" && planned.item && planned.checkId) {
      plannedByItem.set(planned.item, plannedByItem.has(planned.item) ? null : planned);
    }
  }
  const floorNotes = [];

  const checks = (Array.isArray(raw.checks) ? raw.checks : []).map(check => {
    const checkId = check?.checkId == null
      ? plannedByItem.get(check?.item)?.checkId ?? ""
      : typeof check.checkId === "string" ? check.checkId.trim() : "";
    const item = String(plannedById.get(checkId)?.item ?? check?.item ?? "Untitled check");
    const detail = String(check?.detail ?? "");
    const plannedCheck = plannedById.get(checkId);
    const requiredUploads = Object.values(plannedCheck?.requiredUploadFixtures ?? plannedCheck?.uploadFixtures ?? {});
    const uploadRefs = (Array.isArray(runnerEvidence?.uploads) ? runnerEvidence.uploads : [])
      .filter(receipt => requiredUploads.includes(receipt.path) && receipt.sha256 &&
        receipt.checkId === checkId)
      .map(receipt => receipt.receiptId);
    const evidenceRefs = resolveEvidenceRefs({ ...check, checkId }, runnerEvidence, evidenceOptions);
    // Attach owned captures for review; only the verified refs above can support a pass.
    const checkpointRefs = plannedCheck && !evidenceRefs.length
      ? resolveEvidenceRefs({
        checkId,
        evidenceRefs: (runnerEvidence?.checkpoints ?? [])
          .filter(checkpoint => checkpoint.checkId === checkId)
          .flatMap(checkpoint => checkpoint.evidenceRefs ?? []),
      }, runnerEvidence, evidenceOptions)
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
      } else if (requiredUploads.some(path => !(runnerEvidence?.uploads ?? []).some(receipt => receipt.path === path && uploadRefs.includes(receipt.receiptId)))) {
        result = "manual_review";
        demotedFrom = "pass";
        floorNotes.push(`"${item}" passed without a runner upload receipt`);
      } else if (evidenceRefs.length === 0) {
        result = "manual_review";
        demotedFrom = "pass";
        floorNotes.push(checkpointRefs.length
          ? `"${item}" has runner checkpoints but no verified observation`
          : `"${item}" passed without citing concrete evidence`);
      }
    }

    return {
      ...(checkId ? { checkId } : {}),
      item,
      detail,
      result,
      confidence,
      cause: normalizeCause(check?.cause, { result }),
      evidenceRefs: evidenceRefs.length ? evidenceRefs : checkpointRefs,
      ...(requiredUploads.length ? { uploadRefs } : {}),
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
  if (coverage.unplannedCheckIds?.length) {
    derived = worst(derived, "manual_review");
    floorNotes.push("Unplanned, missing, or duplicate check IDs were reported");
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
  runId = null,
  plannedChecks = [],
  checks = [],
  runnerEvidence = null,
} = {}) {
  const { pairs, unplanned } = pairPlannedChecks(plannedChecks, checks);

  const items = plannedChecks.map((planned, index) => {
    const item = typeof planned === "string" ? planned : String(planned?.item ?? "");
    const identity = typeof planned?.checkId === "string" ? { checkId: planned.checkId } : {};
    const check = pairs.get(index);
    if (!check) {
      return {
        ...identity,
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
      ...identity,
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
      ...(check.checkId ? { checkId: check.checkId } : {}),
      item: check.item,
      planned: false,
      addressed: true,
      result: check.result,
      cause: check.cause,
      detail: check.detail,
      evidenceRefs: check.evidenceRefs,
    });
  }

  return { ...(runId ? { runId } : {}), items, runnerEvidence: runnerEvidence ?? null };
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
