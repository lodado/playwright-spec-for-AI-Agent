/**
 * Decide which account state the live page is in, before judging anything.
 *
 * A page's spec covers every state the product can be in — ACTIVE,
 * CANCEL_PENDING, INACTIVE — but one live account is in exactly one of them.
 * Sending all of them and asking the agent to pick made the run pay for
 * scenarios it could never verify (20 of 39 checks on one real suite were
 * reported `skip` for "wrong account state"), and left `coverage` measured
 * against a denominator half of which was never applicable.
 *
 * So the state is settled first, from the page, with evidence. Everything after
 * it judges one state's plan plus the always-run scenarios.
 */
import { UsageError } from "./errors.mjs";

export const UNKNOWN_STATE = "UNKNOWN";

/** Short: this call exists to answer one question, not to judge anything. */
export const DETECT_MAX_TURNS = 12;

export function buildStateDetectionQuery({
  targetUrl,
  scenarioIds = [],
  scenarioHints = {},
  preauthenticated = false,
  authRequired = true,
}) {
  const access = !authRequired
    ? "Open the target URL directly. Do not look for a login form."
    : preauthenticated
      ? "Your browser is already logged in. Open the target URL directly; never visit the login page."
      : "Log in first, then open the target URL.";

  const options = scenarioIds.map(id => {
    const hint = scenarioHints[id];
    return hint ? `- \`${id}\` — ${hint}` : `- \`${id}\``;
  });

  return [
    "You are identifying which account state a live page is in. You are NOT judging the page.",
    "",
    "## Task",
    access,
    `Target URL: ${targetUrl}`,
    "Wait until the page settles, then decide which of the states below this account is in.",
    "",
    "## States",
    ...options,
    `- \`${UNKNOWN_STATE}\` — the page does not show enough to tell them apart.`,
    "",
    "## Rules",
    "- Decide from what the page shows, not from what the state names suggest.",
    "- `evidence` is the exact on-screen text you read, pasted verbatim. No quotation marks needed — the field is the quote. A state with no page text behind it is not usable.",
    `- When two states both fit, or nothing distinguishes them, answer \`${UNKNOWN_STATE}\`. Guessing sends the whole run to the wrong plan.`,
    "- Change nothing on the page. Do not click anything that submits, saves, cancels, or purchases.",
    "",
    "## Response format",
    "Reply with **only** one raw JSON object (no markdown fences):",
    `{ "evidence": "the exact text you read", "state": "<one id from the list or ${UNKNOWN_STATE}>", "confidence": "high"|"medium"|"low" }`,
  ].join("\n");
}

const CONFIDENCES = new Set(["high", "medium", "low"]);

/**
 * `evidence` holds the page text itself, so demanding quotation marks inside it
 * was a category error — the detector pasted `lee 님은 Free 플랜을 사용하고
 * 있습니다` verbatim and was refused for not wrapping it in quotes.
 *
 * What this can check is that the field is not empty, not a restatement of the
 * answer, and not phrased as an impression. What it cannot check is whether the
 * text was really on the page: nothing here has the DOM. That is why a detected
 * state only narrows the run — the judge re-reads the page against the scoped
 * plan, and a wrong scope surfaces there as checks that do not hold.
 */
const MIN_EVIDENCE_LENGTH = 12;

/** Phrasing that describes an impression rather than quoting a page. */
const HEDGED =
  /\b(?:look(?:s|ed)? like|seem(?:s|ed)?|appear(?:s|ed)?|probabl[yi]|likely|i think|maybe|guess)\b/i;

function looksObserved(evidence, state) {
  const text = evidence.trim();
  if (text.length < MIN_EVIDENCE_LENGTH) return false;
  if (HEDGED.test(text)) return false;
  const withoutState = text.replace(new RegExp(state, "gi"), "").trim();
  return withoutState.length >= MIN_EVIDENCE_LENGTH;
}

/**
 * An unrecognised state, or one asserted without a quote, becomes UNKNOWN. The
 * caller then judges every scenario rather than the wrong one: a detection this
 * weak must cost breadth, not correctness.
 */
export function normalizeStateDetection(raw = {}, { scenarioIds = [] } = {}) {
  const evidence = String(raw?.evidence ?? "").trim();
  const declared = String(raw?.state ?? "").trim();
  const known = scenarioIds.includes(declared);
  const grounded = known && looksObserved(evidence, declared);
  const confidence = CONFIDENCES.has(raw?.confidence) ? raw.confidence : "low";

  const reasons = [];
  if (!declared) reasons.push("no state was reported");
  else if (!known && declared !== UNKNOWN_STATE) {
    reasons.push(`"${declared}" is not one of the page's scenarios`);
  }
  if (known && !grounded) {
    reasons.push("the state was claimed without page text behind it");
  }
  // A detector unsure of its own answer must not narrow the run to one state.
  if (known && grounded && confidence === "low") {
    reasons.push("the state was reported with low confidence");
  }

  return {
    state: known && grounded && confidence !== "low" ? declared : UNKNOWN_STATE,
    declared: declared || null,
    evidence,
    confidence,
    reasons,
  };
}

/**
 * Compare what the page shows against what the project said this account should
 * be. A mismatch is an environment problem — the run judged a state nobody asked
 * for — so it lowers the verdict rather than passing quietly. It is not a
 * quarantine: the page was still read, and what it says about the detected state
 * is worth keeping.
 *
 * @returns {{ state: string, expected: string|null, mismatch: boolean, note: string|null }}
 */
export function reconcileState(detection, expected) {
  const wanted = String(expected ?? "").trim() || null;
  if (!wanted || detection.state === UNKNOWN_STATE) {
    return { state: detection.state, expected: wanted, mismatch: false, note: null };
  }
  if (detection.state === wanted) {
    return { state: detection.state, expected: wanted, mismatch: false, note: null };
  }
  return {
    state: detection.state,
    expected: wanted,
    mismatch: true,
    note: `the account is ${detection.state}, but this page expects ${wanted}: ${detection.evidence}`,
  };
}

/** Scenario ids worth choosing between — always-run ones are never a choice. */
export function selectableScenarioIds(spec) {
  return (spec?.scenarios ?? [])
    .filter(scenario => !scenario.liveSkip && !scenario.alwaysRun)
    .map(scenario => scenario.scenarioId)
    .filter(Boolean);
}

/** One line per state so the detector knows what distinguishes them. */
export function scenarioHints(spec) {
  const hints = {};
  for (const scenario of spec?.scenarios ?? []) {
    if (!scenario.scenarioId || scenario.alwaysRun || scenario.liveSkip) continue;
    if (scenario.label) hints[scenario.scenarioId] = String(scenario.label);
  }
  return hints;
}

/**
 * Narrow a written live plan to the scenarios the run will actually judge.
 *
 * Scoping the spec object is not enough: when `spec-live.md` exists the judge
 * document uses that markdown verbatim, so a scoped run still handed the agent
 * every state's blocks — 39 where 19 were planned, and the agent dutifully
 * reported on all of them.
 *
 * Plan headings are `### <scenarioId> — <title>`. A plan whose headings carry no
 * recognisable scenario id is left whole: sending a shorter plan than the run
 * needs is worse than sending a longer one.
 */
export function scopePlanMarkdown(markdown, scenarioIds = []) {
  const text = typeof markdown === "string" ? markdown : "";
  if (!text.trim() || scenarioIds.length === 0) return markdown;

  const lines = text.split("\n");
  const firstHeading = lines.findIndex(line => /^###\s/.test(line));
  if (firstHeading === -1) return markdown;

  const preamble = lines.slice(0, firstHeading);
  const kept = [];
  let keeping = false;
  let matched = 0;

  for (const line of lines.slice(firstHeading)) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      keeping = scenarioIds.some(id => heading[1].startsWith(id));
      if (keeping) matched += 1;
    }
    if (keeping) kept.push(line);
  }

  if (matched === 0) return markdown;
  return [...preamble, ...kept].join("\n");
}

export function parseStateOverride(argv = []) {
  const arg = argv.find(item => item.startsWith("--state="));
  if (!arg) return null;
  const value = arg.slice("--state=".length).trim();
  if (!value) {
    throw new UsageError("--state= needs a scenario id.", {
      hint: "Pass a scenario id from the page's specs, e.g. --state=ACTIVE.",
    });
  }
  return value;
}
