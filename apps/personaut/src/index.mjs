import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  FUNCTIONAL_EVALUATION_VERSION,
  redactStudySecrets,
  validateFunctionalEvaluation,
  validateStudySpec,
} from "./contracts.mjs";
import {
  compareVariants,
  createBehavioralFingerprint,
  createFindings,
  evaluateFunctionalSession,
  evaluateSimulationValidity,
  extractFrictionPoints,
} from "./evaluator.mjs";
import {
  PRESETS,
  createPersonaState,
  createRandom,
  deriveSessionSeed,
  evaluateAbandonment,
  filterPerceivedElements,
  reducePersonaState,
  sampleBehaviorPolicy,
} from "./persona-policy.mjs";
import { writeBehavioralHtmlReport } from "./reporter-html.mjs";
import {
  atomicWrite,
  createFileSessionStore,
  runStudy,
  toSessionRecord,
} from "./runtime.mjs";
import { createPlaywrightDriver } from "./driver.mjs";
import {
  compilePlaywrightIRToStudyResult,
  parsePlaywrightSpecs,
} from "./spec-adapter.mjs";
import { assertHermesStudySupported, createHermesActionPolicy } from "./hermes-action-policy.mjs";

export { createHermesActionPolicy } from "./hermes-action-policy.mjs";

const HELP = `Personaut — persona-driven browser exploration

Usage:
  personaut init [study.yaml]
  personaut validate <study.yaml>
  personaut run <study.yaml> [--output=.qa/run]
  personaut compare <study.yaml> --baseline=<url> --candidate=<url> [--output=.qa/run]
  personaut import-playwright --spec-dir=<dir> --base-url=<url> --output=<study.yaml>
`;
const MAX_ORACLE_REGEX_PATTERN_LENGTH = 256;
const MAX_ORACLE_REGEX_INPUT_LENGTH = 10_000;
const STARTER_STUDY = {
  schemaVersion: "study-spec/0.1",
  study: { id: "example-page", name: "Example page exploration" },
  product: { description: "Public example page" },
  environment: {
    baseUrl: "https://example.com",
    allowedOrigins: ["https://example.com"],
    viewport: { width: 390, height: 844 },
  },
  tasks: [{
    id: "find-example-domain",
    name: "Find the page heading",
    goal: "Find the Example Domain heading",
    successOracles: [{ id: "heading-visible", type: "visible_text", operation: "contains", value: "Example Domain" }],
    safetyPolicy: {
      allowRead: true,
      allowNavigation: true,
      allowClick: false,
      allowTyping: false,
      allowFileUpload: false,
      allowStateMutation: false,
      allowExternalOrigin: false,
      forbiddenActions: [],
      stopBeforeConfirmation: true,
    },
    maxActions: 3,
    maxDurationMs: 15_000,
    maxConsecutiveNoProgressActions: 2,
    abandonmentAllowed: true,
  }],
  personas: [{ preset: "impatient_new_user" }],
  runtime: {
    seeds: [101],
    concurrency: 1,
    modelRoles: { action: "deterministic-policy", evaluator: "deterministic-oracle" },
  },
  evidence: { screenshot: "on_failure", trace: true, video: "off", semanticSnapshot: "every_action" },
  evaluation: { minimumRecurrenceForFinding: 2, validityReport: true },
};

export async function loadStudy(path) {
  const text = await readFile(path, "utf8");
  const value = extname(path).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text);
  return validateStudySpec(value);
}

export async function runPersonaStudy({ study, outputDir, driverFactory, policyFactory, hermesTransport } = {}) {
  const validatedStudy = validateStudySpec(structuredClone(study));
  let selectedPolicyFactory = policyFactory;
  if (!selectedPolicyFactory && validatedStudy.runtime.modelRoles.action === "hermes") {
    assertHermesStudySupported(validatedStudy);
    selectedPolicyFactory = entry => createHermesActionPolicy(entry, { transport: hermesTransport });
  }
  const runRoot = resolve(outputDir ?? `.qa/runs/run-${Date.now()}`);
  await mkdir(runRoot, { recursive: true });
  await atomicJson(`${runRoot}/study.json`, redactStudySecrets(validatedStudy));

  const result = await runStudy({
    study: validatedStudy,
    driverFactory: driverFactory ?? (() => createPlaywrightDriver()),
    policyFactory: selectedPolicyFactory ?? (entry => createDefaultPolicy(entry)),
    oracle: { evaluate: evaluateLiveOracles },
    storeFactory: entry => createFileSessionStore({ rootDir: runRoot, sessionId: entry.sessionId }),
    concurrency: validatedStudy.runtime.concurrency,
  });

  const evaluatedSessions = [];
  for (const sessionResult of result.results) {
    const session = toSessionRecord(sessionResult.session);
    const task = validatedStudy.tasks.find(item => item.id === session.taskId);
    const sealedObservationIds = new Set(sessionResult.manifest.entries.filter(entry => entry.type === "semantic_snapshot").map(entry => entry.metadata?.observationId));
    const sealedObservations = sessionResult.observations.filter(observation => sealedObservationIds.has(observation.id));
    let functionalEvaluation;
    try {
      await verifyManifestFiles(runRoot, sessionResult.manifest);
      functionalEvaluation = await evaluateFunctionalSession({
        study: validatedStudy,
        task,
        session,
        observations: sealedObservations,
        events: sessionResult.events,
        manifest: sessionResult.manifest,
        customEvaluators: { "manual-review": async () => ({ state: "unknown", evidenceIds: [] }) },
      });
    } catch (error) {
      functionalEvaluation = validateFunctionalEvaluation({
        schemaVersion: FUNCTIONAL_EVALUATION_VERSION,
        status: "runtime_error",
        satisfiedOracleIds: [],
        violatedOracleIds: [],
        unknownOracleIds: task?.successOracles?.map(oracle => oracle.id) ?? [],
        evidenceIds: [],
        reasons: [`evaluation failed: ${error?.code ?? "unknown"}`],
      });
    }
    const fingerprint = createBehavioralFingerprint({
      session,
      events: sessionResult.events,
      observations: sealedObservations,
    });
    evaluatedSessions.push({ ...sessionResult, observations: sealedObservations, session, functionalEvaluation, fingerprint });
  }

  const fingerprints = evaluatedSessions.map(item => item.fingerprint);
  const validity = evaluateSimulationValidity({
    sessions: evaluatedSessions,
    fingerprints,
    taskMaxActions: Math.max(...validatedStudy.tasks.map(task => task.maxActions)),
  });
  const frictionPoints = evaluatedSessions.flatMap(item => extractFrictionPoints({
    session: item.session,
    functionalEvaluation: item.functionalEvaluation,
    observations: item.observations,
    events: item.events,
    manifest: item.manifest,
  }));
  const findings = createFindings({
    frictionPoints,
    sessions: evaluatedSessions,
    minimumRecurrence: validatedStudy.evaluation.minimumRecurrenceForFinding,
    validityReport: validity,
  });
  let variant;
  if (validatedStudy.comparison) {
    const baselineSessions = evaluatedSessions.filter(item => item.session.variant === validatedStudy.comparison.baseline.id);
    const candidateSessions = evaluatedSessions.filter(item => item.session.variant === validatedStudy.comparison.candidate.id);
    const findingsForVariant = sessions => {
      const sessionIds = new Set(sessions.map(item => item.session.sessionId));
      return createFindings({
        frictionPoints: frictionPoints.filter(point => sessionIds.has(point.sessionId)),
        sessions,
        minimumRecurrence: validatedStudy.evaluation.minimumRecurrenceForFinding,
        validityReport: validity,
      });
    };
    variant = compareVariants({
      baselineSessions,
      candidateSessions,
      baselineFindings: findingsForVariant(baselineSessions),
      candidateFindings: findingsForVariant(candidateSessions),
      canonicalFindings: findings,
      assignment: validatedStudy.comparison.assignment,
    });
  }
  const report = buildReport({ study: validatedStudy, evaluatedSessions, validity, findings, variant });

  await Promise.all([
    atomicJson(`${runRoot}/summary.json`, report.summary),
    atomicJson(`${runRoot}/validity.json`, validity),
    atomicJson(`${runRoot}/findings.json`, findings),
    ...(variant ? [atomicJson(`${runRoot}/variant-comparison.json`, variant)] : []),
  ]);
  await writeBehavioralHtmlReport({ input: report, outputPath: `${runRoot}/reports/report.html` });
  return { runRoot, sessions: evaluatedSessions, validity, findings, variant, report };
}

export async function runCli(argv, io = console) {
  const [command, input, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.log(HELP);
    return 0;
  }
  if (command === "init") {
    const output = resolve(input ?? "personaut.study.yaml");
    await mkdir(dirname(output), { recursive: true });
    try {
      await writeFile(output, stringifyYaml(validateStudySpec(structuredClone(STARTER_STUDY))), { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`Study already exists: ${output}`);
      throw error;
    }
    io.log(`Study: ${output}`);
    return 0;
  }
  if (command === "validate") {
    const study = await loadStudy(required(input, "study path"));
    io.log(`Valid ${study.schemaVersion}: ${study.study.id}`);
    return 0;
  }
  if (command === "run" || command === "compare") {
    const options = parseOptions(rest);
    let study = await loadStudy(required(input, "study path"));
    if (command === "compare") {
      study = validateStudySpec({
        ...structuredClone(study),
        comparison: {
          baseline: { id: "baseline", baseUrl: required(options.baseline, "--baseline") },
          candidate: { id: "candidate", baseUrl: required(options.candidate, "--candidate") },
          assignment: "paired",
          counterbalanceOrder: true,
          metrics: ["task_completion", "action_count", "backtrack", "failed_interaction", "abandonment", "finding_recurrence", "route_entropy"],
        },
      });
    }
    const completed = await runPersonaStudy({ study, outputDir: options.output });
    io.log(`Report: ${completed.runRoot}/reports/report.html`);
    return 0;
  }
  if (command === "import-playwright") {
    const options = parseOptions([input, ...rest].filter(Boolean));
    const ir = parsePlaywrightSpecs({ specDir: required(options["spec-dir"], "--spec-dir"), page: options.page });
    const compiled = compilePlaywrightIRToStudyResult(ir, { baseUrl: required(options["base-url"], "--base-url") });
    const output = required(options.output, "--output");
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(output, extname(output) === ".json" ? `${JSON.stringify(compiled.studySpec, null, 2)}\n` : stringifyYaml(compiled.studySpec), "utf8");
    io.log(`Study: ${output}${compiled.warnings.length ? ` (${compiled.warnings.length} warning(s))` : ""}`);
    return 0;
  }
  throw new Error(`Unknown command: ${command}`);
}

const SIGNUP_LEXICON = /\b(sign ?up|register|create account|join|subscribe|가입|회원|등록)\b/i;
const PRICE_LEXICON = /\b(price|pricing|upgrade|buy|pay|checkout|plan|billing|결제|요금|업그레이드|구매)\b/i;
const MAX_READING_SCROLLS = 3;

export function createDefaultPolicy(entry, { now = Date.now } = {}) {
  const presetId = entry.persona.preset ?? entry.persona.source?.presetId ?? "impatient_new_user";
  const definition = PRESETS[presetId] ?? PRESETS.impatient_new_user;
  const pairedVariant = entry.study.comparison?.assignment === "paired" ? "paired" : entry.variant;
  const sampledPolicy = sampleBehaviorPolicy(definition, deriveSessionSeed(entry.seed, entry.task.id, entry.persona.id ?? presetId, pairedVariant, 0));
  const random = createRandom(sampledPolicy.seed);
  const values = sampledPolicy.values;
  const requiredReads = Math.round(Number(values.readingDepth) * MAX_READING_SCROLLS);
  let state = createPersonaState();
  return {
    sampledPolicy,
    decide({ observation, task, events, session }) {
      const elapsedMs = session?.startedAt ? Math.max(0, now() - Date.parse(session.startedAt)) : 0;
      const lastEvent = events.at(-1);
      if (lastEvent) state = reducePersonaState(state, lastEvent.derivedSignals);

      const attention = defaultAttention(sampledPolicy);
      const annotated = annotateForAttention(observation.semantic.interactiveElements, task.goal);
      const perceived = filterPerceivedElements(annotated, attention, sampledPolicy.seed + events.length);
      const scrollCount = events.filter(event => event.action.type === "scroll").length;

      const abandonment = evaluateAbandonment({
        state,
        sampledPolicy,
        actionCount: events.length,
        maxActions: task.maxActions,
        elapsedMs,
        maxDurationMs: task.maxDurationMs,
        abandonmentAllowed: task.abandonmentAllowed,
        randomValue: random(),
      });
      if (abandonment.shouldAbandon) return { type: "abandon", reasonCode: abandonment.reasonCode };

      // retryPropensity + errorRecoveryAttempts: re-attempt a still-perceivable target that just failed.
      if (lastEvent?.result?.status === "failure" && lastEvent.action?.elementId && task.safetyPolicy.allowClick) {
        const failedId = lastEvent.action.elementId;
        const retriesSoFar = events.filter(event => event.action?.elementId === failedId && event.result?.status === "failure").length;
        const stillThere = perceived.find(element => element.id === failedId);
        if (stillThere && retriesSoFar < Number(values.errorRecoveryAttempts) && random() < Number(values.retryPropensity)) {
          return { type: "click", elementId: failedId, reasonCode: "retry_after_failed_interaction" };
        }
      }

      // backtrackPropensity: a stalled step may push the persona back a page.
      if (lastEvent?.derivedSignals?.noProgress && events.length > 0 && task.safetyPolicy.allowNavigation
          && random() < Number(values.backtrackPropensity)) {
        return { type: "back", reasonCode: "backtrack_after_no_progress" };
      }

      // readingDepth: careful personas read/scroll before committing to their first click.
      const hasClicked = events.some(event => event.action.type === "click");
      if (!hasClicked && scrollCount < requiredReads && task.safetyPolicy.allowNavigation) {
        return { type: "scroll", direction: "down", amount: "medium", reasonCode: "read_before_acting" };
      }

      // noActionPropensity: hesitate rather than act (bounded by the runtime no-progress budget).
      if (random() < Number(values.noActionPropensity)) {
        return { type: "observe_more", reasonCode: "persona_hesitation" };
      }

      const target = rankForGoal(perceived, task.goal, values)[0];
      if (target && task.safetyPolicy.allowClick && ["button", "link", "checkbox", "radio"].includes(target.role)) {
        return { type: "click", elementId: target.id, reasonCode: "visible_goal_candidate" };
      }
      const explorationScrolls = Math.max(2, Math.round(Number(values.explorationDepth) * 5));
      if (scrollCount < explorationScrolls && task.safetyPolicy.allowNavigation) {
        return { type: "scroll", direction: "down", amount: "medium", reasonCode: "inspect_below_fold" };
      }
      return task.abandonmentAllowed
        ? { type: "abandon", reasonCode: "no_visible_path" }
        : { type: "finish", reasonCode: "manual_review_required" };
    },
  };
}

// Derives the attention signals (goalMatch / primaryCta) that filterPerceivedElements scores on
// but the driver does not emit, from the perceivable role/name/text the observation does carry.
function annotateForAttention(elements, goal) {
  const words = String(goal).toLowerCase().split(/\W+/).filter(word => word.length > 2);
  return elements.map(element => {
    const haystack = `${element.name ?? ""} ${element.text ?? ""}`.toLowerCase();
    const matched = words.filter(word => haystack.includes(word)).length;
    const goalMatch = words.length ? matched / words.length : 0;
    return {
      ...element,
      goalMatch,
      primaryCta: element.role === "button" && goalMatch > 0,
      inViewport: element.inViewport ?? element.viewportPosition?.inViewport ?? true,
      occluded: element.occluded ?? element.viewportPosition?.occluded ?? false,
    };
  });
}

async function evaluateLiveOracles({ task, observation, observations, events }) {
  const satisfiedSuccess = task.successOracles.filter(oracle => observations.some(item => liveOracleSatisfied(oracle, item, events)));
  const satisfiedFailure = (task.failureOracles ?? []).filter(oracle => liveOracleSatisfied(oracle, observation, events));
  if (satisfiedFailure.length) return { definitiveFailure: true, reason: `failure oracle ${satisfiedFailure[0].id}` };
  if (task.successOracles.length && satisfiedSuccess.length === task.successOracles.length) {
    return { definitiveSuccess: true, reason: "all success oracles satisfied" };
  }
  if (task.successOracles.some(oracle => oracle.type === "custom" && oracle.evaluatorId === "manual-review")) {
    return { manualReview: true, reason: "imported task requires manual review" };
  }
  return {};
}

function liveOracleSatisfied(oracle, observation, events) {
  if (oracle.type === "url") return compareText(observation.page.url, oracle.operation, oracle.value);
  if (oracle.type === "visible_text") return compareText(observation.semantic.visibleText.join(" "), oracle.operation, oracle.value);
  if (oracle.type === "element") {
    const matches = observation.semantic.interactiveElements.filter(element =>
      (!oracle.role || element.role === oracle.role) && (!oracle.name || element.name === oracle.name || element.text === oracle.name));
    if (oracle.state === "hidden") return matches.length === 0;
    if (oracle.state === "disabled") return matches.some(element => element.enabled === false);
    if (oracle.state === "checked") return matches.some(element => element.checked === true);
    return matches.some(element => element.visible !== false && (oracle.state !== "enabled" || element.enabled !== false));
  }
  if (oracle.type === "event") return events.some(event => event.action?.type === oracle.name);
  return false;
}

function compareText(actual, operation, expected) {
  if (operation === "equals") return actual === expected;
  if (operation === "contains") return actual.includes(expected);
  if (operation === "not_contains") return !actual.includes(expected);
  if (operation === "matches") return matchesSafeRegex(actual, expected);
  return false;
}

function matchesSafeRegex(actual, pattern) {
  if (pattern.length > MAX_ORACLE_REGEX_PATTERN_LENGTH) throw new Error(`Regex oracle pattern exceeds ${MAX_ORACLE_REGEX_PATTERN_LENGTH} characters`);
  if (actual.length > MAX_ORACLE_REGEX_INPUT_LENGTH) throw new Error(`Regex oracle input exceeds ${MAX_ORACLE_REGEX_INPUT_LENGTH} characters`);
  if (hasNestedOrRepeatedQuantifier(pattern)) throw new Error("Regex oracle pattern contains nested or repeated quantifiers");
  return new RegExp(pattern).test(actual);
}

function hasNestedOrRepeatedQuantifier(pattern) {
  if (/\\[1-9]|\)[+*?{]/.test(pattern)) return true;
  const groups = [];
  let escaped = false;
  let inCharacterClass = false;
  let lastAtomContainsQuantifier = false;
  let lastWasQuantifier = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      lastAtomContainsQuantifier = false;
      lastWasQuantifier = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (inCharacterClass) {
      if (character === "]") inCharacterClass = false;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      lastAtomContainsQuantifier = false;
      lastWasQuantifier = false;
      continue;
    }
    if (character === "(") {
      groups.push(false);
      lastAtomContainsQuantifier = false;
      lastWasQuantifier = false;
      continue;
    }
    if (character === ")") {
      const containsQuantifier = groups.pop() ?? false;
      if (containsQuantifier && groups.length) groups[groups.length - 1] = true;
      lastAtomContainsQuantifier = containsQuantifier;
      lastWasQuantifier = false;
      continue;
    }

    let quantifierEnd = index;
    let isQuantifier = character === "*" || character === "+" || character === "?";
    if (character === "{" && /^\{\d+(?:,\d*)?\}/.test(pattern.slice(index))) {
      quantifierEnd = pattern.indexOf("}", index);
      isQuantifier = true;
    }
    if (isQuantifier && character === "?" && pattern[index - 1] === "(") continue;
    if (isQuantifier) {
      if (character === "?" && lastWasQuantifier) {
        lastWasQuantifier = false;
        continue;
      }
      if (lastWasQuantifier || lastAtomContainsQuantifier) return true;
      if (groups.length) groups[groups.length - 1] = true;
      lastAtomContainsQuantifier = true;
      lastWasQuantifier = true;
      index = quantifierEnd;
      continue;
    }

    lastAtomContainsQuantifier = false;
    lastWasQuantifier = false;
  }
  return false;
}

function defaultAttention(sampledPolicy) {
  return {
    viewportOnly: true,
    maxCandidateElements: Math.max(1, Math.round(Number(sampledPolicy.values.explorationDepth) * 10)),
    primaryCtaWeight: 1,
    headingWeight: 0.5,
    textGoalMatchWeight: 1,
    visualSaliencyWeight: 0.5,
    priorExpectationWeight: 0.5,
    inspectBelowFoldProbability: { type: "fixed", value: Number(sampledPolicy.values.explorationDepth) },
    inspectSecondaryNavigationProbability: { type: "fixed", value: Number(sampledPolicy.values.explorationDepth) },
  };
}

function rankForGoal(elements, goal, values = {}) {
  const words = String(goal).toLowerCase().split(/\W+/).filter(word => word.length > 2);
  const signupResistance = Number(values.signupResistance ?? 0);
  const priceSensitivity = Number(values.priceSensitivity ?? 0);
  return [...elements].sort((left, right) => score(right) - score(left) || left.id.localeCompare(right.id));
  function score(element) {
    const text = `${element.name ?? ""} ${element.text ?? ""}`.toLowerCase();
    const goalOverlap = words.filter(word => text.includes(word)).length + Number(element.role === "button");
    // Persona-specific aversions lower the appeal of signup / paid affordances.
    const aversion = (SIGNUP_LEXICON.test(text) ? signupResistance : 0) + (PRICE_LEXICON.test(text) ? priceSensitivity : 0);
    return goalOverlap - aversion;
  }
}

function buildReport({ study, evaluatedSessions, validity, findings, variant }) {
  const statuses = evaluatedSessions.reduce((grouped, item) => {
    const status = item.session.status === "success" && item.functionalEvaluation.status !== "success"
      ? item.functionalEvaluation.status
      : item.session.status;
    (grouped[status] ??= []).push(item);
    return grouped;
  }, {});
  return {
    summary: {
      title: study.study.name,
      status: evaluatedSessions.some(item => item.session.status === "runtime_error" || item.functionalEvaluation.status === "runtime_error") ? "runtime_error" : "complete",
      humanValidation: validity.recommendedUse,
    },
    validity,
    outcomes: Object.entries(statuses).map(([status, sessions]) => ({ status, count: sessions.length, rate: sessions.length / evaluatedSessions.length })),
    findings,
    personas: study.personas.map(persona => {
      const personaId = persona.id ?? persona.preset;
      const sessions = evaluatedSessions.filter(item => item.session.personaId === personaId);
      return { personaId, sessions: sessions.length, successRate: sessions.filter(item => item.session.status === "success" && item.functionalEvaluation.status === "success").length / Math.max(sessions.length, 1), findingIds: findings.filter(finding => finding.affectedPersonaIds.includes(personaId)).map(finding => finding.id) };
    }),
    ...(variant ? { variant } : {}),
    timeline: evaluatedSessions.map(item => ({ ...item.session, steps: item.events })),
    evidence: evaluatedSessions.flatMap(item => item.manifest.entries.map(entry =>
      entry.relativePath && ["screenshot", "video"].includes(entry.type)
        ? { ...entry, src: `../sessions/${item.session.sessionId}/${entry.relativePath}` }
        : entry)),
    runtime: evaluatedSessions.filter(item => item.session.status === "runtime_error").map(item => item.session.terminalReason),
    cost: [],
    modelCard: {
      actionPolicy: study.runtime.modelRoles.action === "hermes" ? "bounded Hermes action policy (uncalibrated)" : "deterministic behavioral baseline",
      calibration: validity.calibration.level,
    },
  };
}

async function atomicJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function verifyManifestFiles(runRoot, manifest) {
  const sessionRoot = await realpath(resolve(runRoot, "sessions", manifest.sessionId));
  for (const entry of manifest.entries) {
    if (!entry.relativePath) continue;
    const artifactPath = resolve(sessionRoot, entry.relativePath);
    const contained = relative(sessionRoot, artifactPath);
    if (contained.startsWith("..") || contained === "" || contained.startsWith("/")) throw new Error("evidence path escapes session directory");
    if ((await lstat(artifactPath)).isSymbolicLink()) throw new Error("evidence symlinks are not allowed");
    const resolvedPath = await realpath(artifactPath);
    if (relative(sessionRoot, resolvedPath).startsWith("..")) throw new Error("evidence path escapes session directory");
    const content = await readFile(resolvedPath);
    if (entry.byteSize !== undefined && entry.byteSize !== content.byteLength) throw new Error(`evidence byte size mismatch: ${entry.id}`);
    const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (entry.contentHash !== contentHash) throw new Error(`evidence content hash mismatch: ${entry.id}`);
  }
}

function parseOptions(args) {
  return Object.fromEntries(args.filter(arg => arg?.startsWith("--")).map(arg => {
    const [key, ...value] = arg.slice(2).split("=");
    return [key, value.length ? value.join("=") : true];
  }));
}

function required(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
}
