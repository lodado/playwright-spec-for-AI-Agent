#!/usr/bin/env node
/**
 * Hermes QA judge — logs into staging, opens the target page, and verifies live DOM.
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent judge --page=pricing --target-path=/pricing
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareAdapter, runAgent } from "./ai-agent-adapter.mjs";
import { writeAgentQueryArtifact } from "./agent-output.mjs";
import { withSchema } from "./artifact-schema.mjs";
import {
  AgentOutputError,
  EnvironmentError,
  EXIT_ENVIRONMENT,
  EXIT_OK,
  EXIT_VERDICT_FAIL,
  UsageError,
  runMain,
} from "./errors.mjs";
import {
  getAllowedOrigins,
  getHooks,
  getStorageStatePath,
  isPlaceholderBaseUrl,
} from "./hermes-qa-project-config.mjs";
import {
  analyzeHarViolations,
  collectContractHints,
  buildEvidenceManifest,
  isReadOnlyPlan,
  normalizeBrowseDecision,
  resolveJudgeTurnBudget,
} from "./judge-verdict.mjs";
import { resolveSpecForJudge } from "./resolve-spec-for-judge.mjs";
import { seedAsideSession, seedProfileSession } from "./qa-session-seed.mjs";
import {
  buildStateDetectionQuery,
  DETECT_MAX_TURNS,
  normalizeStateDetection,
  parseStateOverride,
  reconcileState,
  scenarioHints,
  scopePlanMarkdown,
  selectableScenarioIds,
  UNKNOWN_STATE,
} from "./judge-state-detection.mjs";
import { appendRunEvent, newRunId } from "./qa-run-ledger.mjs";
import { writeCtrf } from "./qa-ctrf.mjs";
import { appendVerdict } from "./qa-verdict-history.mjs";
import { appendStepSummary, renderJudgmentSummary } from "./github-summary.mjs";
import { describeHashMismatch, hashSpecDefinition } from "./spec-hash.mjs";
import {
  buildHermesStagingLogin,
  assertStagingQaCredentials,
  buildJudgeTargetUrl,
  displayPathForJudgeTarget,
  isAuthRequired,
} from "./staging-qa-config.mjs";
import {
  connectExistingBrowser,
  hasSessionProfile,
  launchAuthenticatedBrowser,
} from "./qa-browser-session.mjs";
import { clearRunInvalid, markRunInvalid } from "./qa-run-invalid.mjs";
import { resolveStagingQaConfig } from "./staging-qa-prompt.mjs";
import {
  buildBrowseChecklist,
  listAlwaysRunScenarios,
  selectScenariosForLiveRun,
} from "./dashboard-spec-parser.mjs";
import { buildJudgeBrowseDocument } from "./qa-spec-judge-document.mjs";
import {
  buildUploadFixturesPayload,
  loadSpecSourceFiles,
} from "./qa-spec-artifacts.mjs";
import {
  artifactPaths,
  ensureProjectConfig,
  parsePageArg,
  resolveJudgeTarget,
  resolveSpecDir,
} from "./page-qa-paths.mjs";

const PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * A browser the operator already runs and signed into. This is the only path
 * that works with an identity provider that blocks automation-controlled
 * browsers, so it outranks the private QA profile when both are available.
 */
export function resolveAttachUrl(argv = []) {
  const flag = argv
    .find(arg => arg.startsWith("--cdp-url="))
    ?.slice("--cdp-url=".length)
    .trim();
  return flag || process.env.QA_BROWSER_CDP_URL?.trim() || "";
}

const FAIL_ON_VALUES = ["fail", "manual_review", "never"];

export function buildBrowseHermesQuery({
  judgeDocument,
  stagingLogin,
  preauthenticated = false,
}) {
  const authRequired = stagingLogin.authRequired !== false;
  const accessInstruction = !authRequired
    ? "Follow the **QA test plan** below. Open the target page directly without logging in, run the tests that apply, and report results."
    : preauthenticated
      ? "Follow the **QA test plan** below. Your browser is already logged in — open the target page directly, run the tests that apply to this account, and report results."
      : "Follow the **QA test plan** below. Log in, open the target page, run the tests that apply to this account, and report results.";
  const sessionLines = !authRequired
    ? [
        "## Session access",
        "",
        "Login required: false",
        "Open the target URL directly. Do not search for email or password fields.",
        `Target URL: ${stagingLogin.targetUrl}`,
      ]
    : preauthenticated
      ? [
          "## Session access",
          "",
          "The browser session is already authenticated.",
          "Never visit the login page and never enter credentials; if the session appears logged out, stop and report `manual_review`.",
          `Target URL: ${stagingLogin.targetUrl}`,
        ]
      : [
          "## Session credentials",
          "",
          `Login URL: ${stagingLogin.loginUrl}`,
          `Email: ${stagingLogin.email}`,
          `Password: ${stagingLogin.password}`,
          `Target URL: ${stagingLogin.targetUrl}`,
        ];

  return [
    "You are a QA judge for a live staging environment.",
    "",
    "## Your task",
    accessInstruction,
    "The test plan uses **Given / When / Then** — not JSON. Use the exact test **titles** from the plan in your verdict `checks[].item` field.",
    "Report one check per test in the plan. A test you did not execute is still a check — report it with `skip` and say why.",
    "",
    "## Rules",
    "- After every navigation or interaction, wait until the page settles before judging: content stops changing and no skeleton, spinner, or placeholder is still loading (give it up to ~5 seconds).",
    "- Never treat a loading, skeleton, or mid-transition state as evidence that something is missing — re-observe once settled before marking `fail`.",
    "- Pick **one** scenario that matches the live account, plus every **Always run** scenario.",
    "- Never mutate subscription or billing (no checkout, cancel, or confirm on destructive dialogs).",
    "- For **Safe interaction** tests: follow Playwright source in the plan; dismiss risky dialogs with Esc only.",
    "- `@qa-live-policy: safe-interaction` tests are mandatory to execute.",
    "- Do not mark `safe-interaction` checks as `skip` for quota/credit caution alone; execute once and judge outcome with evidence.",
    "- For **Mocked in CI** (`judgment-mock-api`) tests:",
    "  - CI used `page.route` / API mocks that **cannot be replayed** on live — expect **non-deterministic** values (counts, labels, dates, copy).",
    "  - Do **not** require exact mock literals from Playwright unless the plan explicitly demands them.",
    "  - Unless the plan explicitly requires positive/negative/exact numeric value, evaluate numeric displays flexibly.",
    "  - Value mismatch alone (e.g., `0` vs `8`) is not a failure when semantic intent is satisfied.",
    "  - **pass** when the live UI reasonably satisfies the test **intent** (you would accept it as a human QA reviewer).",
    "  - **manual_review** when intent match is **ambiguous** or evidence is thin — do **not** fail just because live differs from the mock.",
    "  - **fail** only when the UI **clearly** contradicts intent (missing control, broken state, wrong class of outcome).",
    "- For other semantic / abstracted expectations: same rule — reasonable for intent → pass; ambiguous → manual_review.",
    "- If blocked on live → **skip**.",
    "",
    "## Evidence rules (enforced after you answer)",
    "- Every `pass` must quote something you actually observed in its `detail`: exact on-screen text in quotes, a URL/path, or a number with its unit.",
    "- A `pass` whose `detail` cites nothing concrete, or whose `confidence` is `low`, is downgraded to `manual_review` automatically. Do not pad — report what you saw.",
    "- `evidenceRefs` may name captured artifact files (screenshots, aria snapshots) when you have them; leave it `[]` otherwise.",
    "- The quoted Playwright source names elements with `getByTestId(\"...\")`. Those ids are a stable contract; the page copy and numbers around them are not.",
    "- List in `observedTestIds` the ids you actually confirmed present on the page for that check. Report only what you saw — an unconfirmed id left out is correct, an invented one is not.",
    "- The plan, not the id list, is still the expectation: a present id whose behaviour contradicts the plan is a `fail`, not a `pass`.",
    "",
    "## Cause classification",
    "Every non-pass check, and the top-level verdict, needs a `cause` from exactly these:",
    "- `PRODUCT_DEFECT` — the application under test is wrong.",
    "- `SPEC_GAP` — the test plan does not cover what the page actually does.",
    "- `ENVIRONMENT_DEFECT` — login, staging deployment, or network is broken, so the product was never really tested.",
    "- `HARNESS_DEFECT` — you or your tooling failed (could not follow the plan, lost the session, ran out of turns).",
    "- `NONE` — only for a `pass`.",
    "",
    "## Annotation guide",
    "These fields come from Playwright comments parsed during `spec`.",
    "- File-level: `@qa-scenario`, `@qa-live-skip`, `@qa-always-run`, `@qa-fixture`.",
    "- Test-level: `@qa-live-policy` (+ optional `@qa-fixture` override).",
    "- Derived `liveRunPolicy` mapping:",
    "  - `readonly` -> `executable-readonly`",
    "  - `safe-interaction` -> `executable-interaction`",
    "  - `safe-interaction-no-confirm` -> `judgment-interaction-no-confirm`",
    "  - `mock-judgment` -> `judgment-mock-api`",
    "  - `subscription-mutation` -> `blocked-subscription-mutation`",
    "  - `auth-mock` -> `blocked-auth-mock`",
    "  - `skip` -> `blocked-live-skip`",
    "- Use `liveRunPolicy` as execution authority.",
    "- `safe-interaction` must be executed (no skip unless the UI is truly unreachable due to hard blocker such as auth/page crash).",
    "- If `blocked-*`, mark `skip`.",
    "",
    "## Response format (JSON only for your final message)",
    "After browsing, reply with **only** one raw JSON object (no markdown fences).",
    "`detail` comes before `result` on purpose: write down what you observed, then decide.",
    '{ "status": "pass"|"fail"|"manual_review", "cause": "PRODUCT_DEFECT"|"SPEC_GAP"|"ENVIRONMENT_DEFECT"|"HARNESS_DEFECT"|"NONE", "summary": "...", "checks": [{ "item": "<exact test title>", "detail": "what you observed, quoting exact values", "result": "pass"|"fail"|"skip"|"manual_review", "confidence": "high"|"medium"|"low", "cause": "PRODUCT_DEFECT"|"SPEC_GAP"|"ENVIRONMENT_DEFECT"|"HARNESS_DEFECT"|"NONE", "evidenceRefs": ["..."], "observedTestIds": ["..."] }], "evidence": ["..."], "recommendedAction": "...", "source": "hermes-agent" }',
    "",
    "---",
    "",
    judgeDocument.trimEnd(),
    "",
    "---",
    "",
    ...sessionLines,
  ].join("\n");
}

function renderMarkdown(judgment) {
  const checkRows = judgment.checks?.length
    ? judgment.checks.map(check => {
        const demoted = check.demotedFrom ? ` (was ${check.demotedFrom})` : "";
        return `| ${check.result}${demoted} | ${check.cause ?? ""} | ${check.item} | ${(check.detail ?? "").replace(/\|/g, "\\|")} |`;
      })
    : [];

  return [
    `# Hermes QA Judgment — ${judgment.page}`,
    "",
    `- Status: **${judgment.status}**`,
    `- Cause: \`${judgment.cause}\``,
    `- Run: \`${judgment.runId}\` at ${judgment.judgedAt}`,
    `- Mode: \`browse\``,
    `- Page: \`${judgment.targetPath}\``,
    `- Plan source: ${judgment.planSource}`,
    `- Coverage: ${judgment.coverage.addressed}/${judgment.coverage.planned} planned checks addressed`,
    `- Source: ${judgment.source}`,
    ...(judgment.agentMeta
      ? [
          `- Adapter: ${judgment.agentMeta.adapter}${judgment.agentMeta.model ? ` (${judgment.agentMeta.model})` : ""}, ${Math.round(judgment.agentMeta.durationMs / 1000)}s`,
        ]
      : []),
    "",
    "## Summary",
    "",
    judgment.summary,
    "",
    ...(judgment.coverage.missing.length
      ? [
          "## Unaddressed planned checks",
          "",
          ...judgment.coverage.missing.map(item => `- ${item}`),
          "",
        ]
      : []),
    ...(checkRows.length
      ? [
          "## Checks",
          "",
          "| Result | Cause | Item | Detail |",
          "|--------|-------|------|--------|",
          ...checkRows,
          "",
        ]
      : []),
    "## Evidence",
    "",
    ...(judgment.evidence?.length
      ? judgment.evidence.map(item => `- ${item}`)
      : ["- none"]),
    ...(judgment.runnerEvidence
      ? [
          "",
          "## Runner-captured evidence",
          "",
          ...[
            judgment.runnerEvidence.tracePath &&
              `- trace: \`${judgment.runnerEvidence.tracePath}\``,
            judgment.runnerEvidence.harPath &&
              `- har: \`${judgment.runnerEvidence.harPath}\``,
            judgment.runnerEvidence.videoPath &&
              `- video: \`${judgment.runnerEvidence.videoPath}\``,
            `- screenshots: ${judgment.runnerEvidence.screenshots?.length ?? 0}`,
            `- aria snapshots: ${judgment.runnerEvidence.ariaSnapshots?.length ?? 0}`,
            ...(judgment.runnerEvidence.violations ?? []).map(
              violation => `- violation: ${violation.kind} — ${violation.detail}`
            ),
          ].filter(Boolean),
        ]
      : []),
    "",
    "## Recommended action",
    "",
    judgment.recommendedAction || "none",
    "",
  ].join("\n");
}

/**
 * Settle the account state before the plan is built. Returns null when there is
 * nothing to choose between, when the operator forced a state, or when the
 * detector could not tell — the caller then judges every scenario, which is the
 * old behaviour and the safe direction to fail in.
 */
async function detectAccountState({
  page,
  paths,
  targetUrl,
  config,
  adapter,
  preauthenticated,
  runId,
  override,
}) {
  const resolved = resolveSpecForJudge(paths);
  const scenarioIds = selectableScenarioIds(resolved?.definition);
  const expected = config.expectedAccountState || null;

  if (override) {
    return { state: override, expected, mismatch: false, source: "flag", evidence: "" };
  }
  // One state is not a choice, and choosing badly costs more than the scoping saves.
  if (scenarioIds.length < 2) return null;

  const query = buildStateDetectionQuery({
    targetUrl,
    scenarioIds,
    scenarioHints: scenarioHints(resolved.definition),
    preauthenticated,
    authRequired: isAuthRequired(config),
  });

  let detection;
  try {
    const raw = runAgent(query, adapter.capabilities.supportsMaxTurns ? DETECT_MAX_TURNS : null, {
      // Its own artifacts: the judge call that follows writes to the same page
      // and would otherwise overwrite the only record of what the detector saw.
      paths: {
        ...paths,
        hermesQuery: paths.hermesDetectQuery,
        hermesRawOutput: paths.hermesDetectRawOutput,
      },
      secrets: [config.email, config.password].filter(Boolean),
      requiredKeys: ["state"],
      mode: "browse",
    });
    detection = normalizeStateDetection(raw, { scenarioIds });
  } catch (error) {
    // Detection is an optimisation. Losing it costs prompt size, not correctness.
    console.warn(`State detection failed, judging every scenario: ${error.message}`);
    return null;
  }

  const reconciled = reconcileState(detection, expected);
  appendRunEvent(paths.runsLedger, {
    runId,
    kind: "judge-state",
    page,
    state: reconciled.state,
    expected: reconciled.expected,
    mismatch: reconciled.mismatch,
    confidence: detection.confidence,
  });

  if (detection.state === UNKNOWN_STATE) {
    console.warn(
      `Account state undetermined (${detection.reasons.join("; ") || "no reason given"}) — judging every scenario.`
    );
    return null;
  }
  console.log(
    `Account state: ${reconciled.state}${reconciled.expected ? ` (expected ${reconciled.expected})` : ""} — ${detection.evidence}`
  );
  return { ...reconciled, source: "detected", evidence: detection.evidence };
}

/**
 * Everything needed to run (or dry-run) the judge: resolved plan, prompt, turn
 * budget, and the planned-check list the verdict floor is measured against.
 */
export function prepareJudgePlan({
  page,
  target,
  targetUrl,
  paths,
  config,
  adapter,
  preauthenticated,
  accountState = null,
}) {
  const resolved = resolveSpecForJudge(paths);
  if (!resolved) {
    throw new UsageError(`Missing qa spec JSON for page "${page}".`, {
      hint: `Run: npx playwright-spec-for-ai-agent spec --page=${page}`,
    });
  }
  if (resolved.staleness && resolved.staleness.ok === false) {
    throw new UsageError(
      describeHashMismatch({
        expected: resolved.staleness.expected,
        actual: resolved.staleness.actual,
        producer: "abstract-ai",
        consumer: "judge",
      }),
      {
        hint: `Re-run: npx playwright-spec-for-ai-agent abstract-ai --page=${page}`,
      }
    );
  }

  const specDefinition = resolved.definition;
  // Provenance, not identity: record the hash of the raw `spec` artifact this
  // plan descends from (what `resolveSpecForJudge` compares against), so
  // `show`/`report`/`review` can re-derive it. Hashing the resolved plan
  // instead would make every later staleness check read as a mismatch.
  const specHash =
    resolved.staleness.actual ?? hashSpecDefinition(specDefinition);

  const stagingLogin = buildHermesStagingLogin(config);
  if (preauthenticated) {
    // The agent browses a pre-authenticated browser over CDP; credentials and
    // even the account email stay out of the prompt and the judge plan.
    stagingLogin.email = "";
    stagingLogin.password = "";
  }
  stagingLogin.targetUrl = targetUrl;

  // One live account is in one state. Judging the other states' scenarios costs
  // a prompt that grows with every state the product has, and reports them as
  // `skip` for "wrong account" — noise measured against a denominator that was
  // never applicable. With a state settled, the run carries that state plus the
  // always-run scenarios and nothing else.
  const scopedScenarios =
    accountState && accountState !== UNKNOWN_STATE
      ? selectScenariosForLiveRun(specDefinition, accountState)
      : null;
  const notApplicable = scopedScenarios
    ? (specDefinition.scenarios ?? [])
        .map(scenario => scenario.scenarioId)
        .filter(id => !scopedScenarios.some(scenario => scenario.scenarioId === id))
    : [];
  const scopedSpec = scopedScenarios
    ? { ...specDefinition, scenarios: scopedScenarios }
    : specDefinition;

  const specSourceFiles = loadSpecSourceFiles(resolveSpecDir(page));
  const uploadFixtures = buildUploadFixturesPayload(scopedSpec, page);
  const hasScenarios = Array.isArray(scopedSpec?.scenarios);
  const alwaysRunScenarioIds = hasScenarios
    ? listAlwaysRunScenarios(scopedSpec).map(scenario => scenario.scenarioId)
    : [];
  const checklist = hasScenarios ? buildBrowseChecklist(scopedSpec) : [];
  // One planned entry per plan block, duplicates included: the same title is
  // planned once per scenario and the agent reports one check per block, so
  // deduplicating here made `coverage.planned` disagree with the very document
  // the agent was handed — which the review stage then flags, correctly.
  const plannedChecks = checklist.map(test => test.title);
  // The parser reads these `data-testid` values from the same source the plan
  // was written from. They stay out of the plan — it is intent-level on purpose
  // — and reach the judge as contract points to confirm on the page.
  const contractHints = collectContractHints(scopedSpec);

  const savedPlanMarkdown = existsSync(paths.specLiveMd)
    ? scopePlanMarkdown(
        readFileSync(paths.specLiveMd, "utf8"),
        scopedScenarios?.map(scenario => scenario.scenarioId) ?? []
      )
    : null;

  const { document: judgeDocument, planSource } = buildJudgeBrowseDocument({
    page,
    spec: scopedSpec,
    specLiveMarkdown: savedPlanMarkdown,
    planSource: savedPlanMarkdown ? "spec-live.md" : null,
    stagingLogin: {
      loginUrl: stagingLogin.loginUrl,
      email: stagingLogin.email,
      targetUrl: stagingLogin.targetUrl,
    },
    alwaysRunScenarioIds,
    uploadFixtures,
    specSourceFiles,
  });

  // `review` re-checks this stamp against the judgment's `specHash` before it
  // critiques anything. Stamping the value the judgment will carry is what
  // makes that check real: the plan's own front matter records `sourceHash`
  // (a different key, absent entirely when abstract-ai never ran), so the
  // reviewer found nothing to compare and silently reviewed any revision.
  writeFileSync(
    paths.specJudgePlanMd,
    `<!-- specHash: ${specHash} -->\n${judgeDocument}`
  );

  return {
    query: buildBrowseHermesQuery({
      judgeDocument,
      stagingLogin,
      preauthenticated,
    }),
    secrets: [config.email, config.password].filter(Boolean),
    stagingLogin,
    specPath: resolved.path,
    specHash,
    planSource,
    plannedChecks,
    contractHints,
    notApplicable,
    readOnly: isReadOnlyPlan(checklist),
    // An adapter that cannot cap its turns ignores the budget entirely.
    maxTurns: adapter.capabilities.supportsMaxTurns
      ? resolveJudgeTurnBudget(plannedChecks.length)
      : null,
  };
}

function inspectRecordedHar(harPath, { allowedOrigins, readOnly }) {
  try {
    return analyzeHarViolations(JSON.parse(readFileSync(harPath, "utf8")), {
      allowedOrigins,
      readOnly,
    });
  } catch (error) {
    return [
      { kind: "capture-failed", detail: `har inspect: ${error.message}` },
    ];
  }
}

/**
 * The runner's own profile, seeded first when a storage state is configured.
 *
 * Without the seed a `storageState` on a cdp-attach adapter only suppressed the
 * credential requirement: the run then launched an empty profile and browsed
 * signed out while reporting itself pre-authenticated. Cookies go in over CDP
 * here, so httpOnly session cookies work on this path.
 */
async function launchRunnerBrowser({
  page,
  paths,
  plan,
  runId,
  allowedOrigins,
  blockMutations,
}) {
  const storageStatePath = getStorageStatePath(page);
  if (storageStatePath) {
    const seeded = await seedProfileSession({
      storageStatePath,
      origin: new URL(plan.stagingLogin.targetUrl).origin,
    });
    console.log(
      `Session seeded from ${storageStatePath} (${seeded.cookies} cookie(s)).`
    );
  }
  return launchAuthenticatedBrowser({
    recordVideoDir: process.env.QA_RECORD_VIDEO ? paths.videosDir : null,
    evidenceDir: paths.evidenceDir,
    label: `${paths.slug}-${runId}`,
    allowedOrigins,
    blockMutations,
  });
}

async function executeJudge({
  page,
  paths,
  plan,
  adapter,
  config,
  preauthenticated,
  allowedOrigins,
  attachUrl,
  runId,
}) {
  if (preauthenticated && adapter.capabilities.auth === "self-prelogin") {
    const storageStatePath = getStorageStatePath(page);
    if (storageStatePath) {
      // No login form to drive: the project already mints its session (an e2e
      // auth setup, a signed cookie). Replay that state into the adapter's own
      // browser instead of typing credentials it would have no field for.
      const origin = new URL(plan.stagingLogin.targetUrl).origin;
      const seeded = seedAsideSession({ storageStatePath, origin });
      console.log(
        `Session seeded from ${storageStatePath} (${seeded.cookies} cookie(s)).`
      );
    } else {
      // The adapter drives its own persistent browser profile: log it in over
      // its own channel so credentials stay out of argv and out of the prompt.
      adapter.prelogin?.({
        loginUrl: plan.stagingLogin.loginUrl,
        email: config.email,
        password: config.password,
      });
    }
  }

  // Live `context.route` interception needs this process's event loop, and a
  // blocking adapter (spawnSync) freezes it for the whole run — enabling the
  // guards there deadlocks the browser. Blocking adapters get the same coverage
  // from the recorded HAR, inspected after the run.
  const liveInterception = adapter.capabilities.blocksEventLoop === false;
  const usesRunnerBrowser = adapter.capabilities.auth === "cdp-attach";
  const session = !usesRunnerBrowser
    ? null
    : attachUrl
      ? // The operator's own browser, already signed in — the only path an
        // identity provider that blocks automated browsers leaves open.
        await connectExistingBrowser({
          cdpUrl: attachUrl,
          evidenceDir: paths.evidenceDir,
          label: `${paths.slug}-${runId}`,
        })
      : preauthenticated
        ? await launchRunnerBrowser({
            page,
            paths,
            plan,
            runId,
            allowedOrigins: liveInterception ? allowedOrigins : [],
            blockMutations: liveInterception && plan.readOnly,
          })
        : null;
  if (session) process.env.BROWSER_CDP_URL = session.cdpUrl;

  let raw;
  let runnerEvidence = null;
  try {
    raw = runAgent(plan.query, plan.maxTurns, {
      paths,
      secrets: plan.secrets,
      requiredKeys: ["status"],
      mode: "browse",
    });
  } finally {
    if (session) {
      delete process.env.BROWSER_CDP_URL;
      runnerEvidence = await session.close();
    }
  }

  const violations = [...(runnerEvidence?.violations ?? [])];
  if (!liveInterception && runnerEvidence?.harPath) {
    violations.push(
      ...inspectRecordedHar(runnerEvidence.harPath, {
        allowedOrigins,
        readOnly: plan.readOnly,
      })
    );
  }

  return { raw, runnerEvidence, violations };
}

/**
 * Bounded retries with cause routing. A flapping login or an unparseable answer
 * is worth one more attempt; scenario checks are never silently re-judged, so a
 * completed judgment is returned as-is however bad it is.
 */
async function executeWithRetries(options) {
  const budget = { environment: 2, agentOutput: 1 };
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await executeJudge(options);
    } catch (error) {
      const kind =
        error instanceof EnvironmentError
          ? "environment"
          : error instanceof AgentOutputError
            ? "agentOutput"
            : null;
      // On exhaustion the last real failure is what propagates — never a
      // synthesised "final attempt" verdict.
      if (!kind || budget[kind] <= 0) throw error;
      budget[kind] -= 1;
      appendRunEvent(options.paths.runsLedger, {
        runId: options.runId,
        kind: "judge-retry",
        attempt,
        reason: kind,
        error: error.message,
      });
      console.warn(
        `Judge attempt ${attempt} failed (${kind}): ${error.message}\nRetrying.`
      );
    }
  }
}

/** Zero-LLM reachability check: an outage must not be judged as a product bug. */
async function preflightTarget(targetUrl) {
  let response;
  try {
    response = await fetch(targetUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new EnvironmentError(
      `Target ${targetUrl} is unreachable: ${cause.message}`,
      {
        hint: "Check the staging deployment and STAGING_QA_BASE_URL before spending an agent run.",
        cause,
      }
    );
  }
  if (response.status >= 500) {
    throw new EnvironmentError(
      `Target ${targetUrl} returned HTTP ${response.status} before the run started.`,
      {
        hint: "Staging is failing; judging it now would report an outage as a product defect.",
      }
    );
  }
  return response.status;
}

function parseFailOn(argv) {
  const flag = argv.find(arg => arg.startsWith("--fail-on="));
  if (!flag) return "fail";
  const value = flag.slice("--fail-on=".length).trim();
  if (!FAIL_ON_VALUES.includes(value)) {
    throw new UsageError(`Unknown --fail-on value: ${JSON.stringify(value)}.`, {
      hint: `Use one of: ${FAIL_ON_VALUES.join(", ")}.`,
    });
  }
  return value;
}

function verdictExitCode(status, failOn) {
  if (failOn === "never") return EXIT_OK;
  if (status === "fail") return EXIT_VERDICT_FAIL;
  if (status === "manual_review" && failOn === "manual_review") {
    return EXIT_VERDICT_FAIL;
  }
  return EXIT_OK;
}

export async function main(argv = process.argv.slice(2)) {
  await ensureProjectConfig(argv);
  const adapter = await prepareAdapter();
  const failOn = parseFailOn(argv);
  const dryRun = argv.includes("--dry-run");
  const page = parsePageArg(argv);
  const paths = artifactPaths(page);

  mkdirSync(paths.outputDir, { recursive: true });

  const judgeTarget = resolveJudgeTarget(argv, page);
  if (!judgeTarget.pageUrl && !judgeTarget.targetPath) {
    throw new UsageError(`Missing target for page "${page}".`, {
      hint: [
        `Set pages.${page}.pageUrl, pages.${page}.targetPath, or targetPaths.${page}`,
        `in playwright-spec-for-ai-agent.config.*, or pass --target-path=/${page}`,
      ].join(" "),
    });
  }

  // Session-first: with an operator-authenticated browser profile the run needs
  // no credentials anywhere. --credentials-in-prompt forces the legacy flow
  // (plaintext credentials inside the prompt). The matrix reads from the
  // adapter's declared capabilities, never from its name.
  const credentialsInPrompt = argv.includes("--credentials-in-prompt");
  const selfPrelogin = adapter.capabilities.auth === "self-prelogin";
  const cdpAttach = adapter.capabilities.auth === "cdp-attach";
  const attachUrl = cdpAttach ? resolveAttachUrl(argv) : "";
  const attachable = cdpAttach && (Boolean(attachUrl) || hasSessionProfile());
  // A configured storage state IS the session, so nothing needs to type
  // credentials — demanding them anyway blocks exactly the apps this path
  // exists for (no login form to drive in the first place).
  const seedable = Boolean(getStorageStatePath(page));
  const requireCredentials =
    credentialsInPrompt || (!seedable && selfPrelogin) || (!seedable && !attachable);

  const { config, target } = await resolveStagingQaConfig(argv, {
    stepLabel: `${page} Hermes judge`,
    target: judgeTarget,
    page,
    requireCredentials,
  });
  const preauthenticated =
    isAuthRequired(config) &&
    !credentialsInPrompt &&
    (selfPrelogin || attachable || (seedable && cdpAttach));
  if (isAuthRequired(config) && !preauthenticated) {
    assertStagingQaCredentials(config);
    console.warn(
      "[security] Credentials will be embedded in the Hermes prompt and its session logs. " +
        "Prefer `npx playwright-spec-for-ai-agent login` to create a pre-authenticated session."
    );
  }

  const targetPath = displayPathForJudgeTarget(target);
  const targetUrl = buildJudgeTargetUrl(target, config.baseUrl);
  if (isPlaceholderBaseUrl(targetUrl)) {
    throw new UsageError(
      `Refusing to judge a placeholder target URL: ${targetUrl}`,
      {
        hint: "Set staging.baseUrl in playwright-spec-for-ai-agent.config.*, or STAGING_QA_BASE_URL.",
      }
    );
  }
  const allowedOrigins = getAllowedOrigins(page);
  const runId = newRunId();

  if (dryRun) {
    const plan = prepareJudgePlan({
      page,
      target,
      targetUrl,
      paths,
      config,
      adapter,
      preauthenticated,
      accountState: parseStateOverride(argv),
    });
    writeAgentQueryArtifact(paths, plan.query, plan.secrets);
    console.log(
      [
        `Dry run — no agent was called.`,
        `  target:        ${targetUrl}`,
        `  adapter:       ${adapter.name}`,
        `  auth mode:     ${preauthenticated ? `preauthenticated (${adapter.capabilities.auth})` : "credentials-in-prompt"}`,
        `  plan source:   ${plan.planSource}`,
        `  planned checks:${String(plan.plannedChecks.length).padStart(4)}`,
        `  turn budget:   ${plan.maxTurns ?? "n/a (adapter ignores max turns)"}`,
        `  judge plan:    ${paths.specJudgePlanMd}`,
      ].join("\n")
    );
    return EXIT_OK;
  }

  let plan;
  let result;
  let accountState = null;
  try {
    accountState = await detectAccountState({
      page,
      paths,
      targetUrl,
      config,
      adapter,
      preauthenticated,
      runId,
      override: parseStateOverride(argv),
    });
    plan = prepareJudgePlan({
      page,
      target,
      targetUrl,
      paths,
      config,
      adapter,
      preauthenticated,
      accountState: accountState?.state ?? null,
    });
    appendRunEvent(paths.runsLedger, {
      runId,
      kind: "judge-start",
      page,
      target: targetUrl,
      adapter: adapter.name,
      specHash: plan.specHash,
      spec: plan.specPath,
    });
    console.log(
      `Preflight ${targetUrl} -> HTTP ${await preflightTarget(targetUrl)}`
    );
    if (preauthenticated) {
      // Honest about the gap: the preflight fetch is unauthenticated, so it
      // cannot tell a live session from an expired one. The prompt instructs
      // the agent to stop with manual_review if the page looks logged out.
      console.log(
        "Using the pre-authenticated browser session (session validity is not verified before the run)."
      );
    }
    result = await executeWithRetries({
      page,
      paths,
      plan,
      adapter,
      config,
      preauthenticated,
      allowedOrigins,
      attachUrl,
      runId,
    });
  } catch (error) {
    // Quarantine the run: partial artifacts (judge plan, raw output) may have
    // been written already; downstream commands must not report on them.
    appendRunEvent(paths.runsLedger, {
      runId,
      kind: "judge",
      status: "error",
      cause:
        error instanceof EnvironmentError
          ? "ENVIRONMENT_DEFECT"
          : "HARNESS_DEFECT",
      coverage: null,
      artifact: null,
      error: error.message,
    });
    markRunInvalid(paths, error?.message ?? error);
    throw error;
  }

  const decision = normalizeBrowseDecision(result.raw, {
    plannedChecks: plan.plannedChecks,
    contractHints: plan.contractHints,
    runnerEvidence: result.runnerEvidence,
    // A page judged in a state nobody asked for was not the test anyone
    // planned, so the run does not get to be green — but the reading still
    // stands, so this lowers the verdict instead of quarantining the run.
    violations: accountState?.mismatch
      ? [...result.violations, { kind: "account-state-mismatch", detail: accountState.note }]
      : result.violations,
  });

  const judgment = withSchema(
    {
      runId,
      page,
      judgedAt: new Date().toISOString(),
      targetUrl,
      targetPath,
      planSource: plan.planSource,
      specHash: plan.specHash,
      accountState: accountState
        ? {
            state: accountState.state,
            expected: accountState.expected ?? null,
            mismatch: Boolean(accountState.mismatch),
            source: accountState.source,
            evidence: accountState.evidence || null,
          }
        : null,
      notApplicable: plan.notApplicable,
      status: decision.status,
      cause: decision.cause,
      summary: decision.summary,
      recommendedAction: decision.recommendedAction,
      source: decision.source,
      ...(decision.agentMeta ? { agentMeta: decision.agentMeta } : {}),
      checks: decision.checks,
      coverage: decision.coverage,
      evidence: decision.evidence,
      runnerEvidence: result.runnerEvidence ?? null,
    },
    "judgment"
  );

  const markdown = renderMarkdown(judgment);
  writeFileSync(
    paths.hermesJudgmentJson,
    `${JSON.stringify(judgment, null, 2)}\n`
  );
  writeFileSync(paths.hermesJudgmentMd, markdown);
  writeFileSync(
    paths.evidenceManifestJson,
    `${JSON.stringify(
      withSchema(
        {
          runId,
          page,
          generatedAt: judgment.judgedAt,
          ...buildEvidenceManifest({
            plannedChecks: plan.plannedChecks,
            checks: decision.checks,
            runnerEvidence: result.runnerEvidence,
          }),
        },
        "evidence-manifest"
      ),
      null,
      2
    )}\n`
  );
  writeCtrf(paths.judgmentCtrfJson, judgment, { page });
  appendVerdict(paths.verdictHistoryJson, {
    runId,
    judgedAt: judgment.judgedAt,
    status: judgment.status,
    specHash: judgment.specHash,
    checks: judgment.checks,
  });
  appendRunEvent(paths.runsLedger, {
    runId,
    kind: "judge",
    status: judgment.status,
    cause: judgment.cause,
    coverage: judgment.coverage,
    artifact: paths.hermesJudgmentJson,
  });

  appendStepSummary(renderJudgmentSummary(judgment, { page }));

  // A hook is the consumer's code: it may log, notify, or throw, but it must
  // never change what this run decided.
  try {
    await getHooks().onJudgment?.({ page, judgment, paths, target });
  } catch (error) {
    console.warn(`[hooks] onJudgment failed: ${error.message}`);
  }

  console.log(
    `Hermes ${page} QA judgment (browse): ${judgment.status} [${judgment.cause}] ` +
      `— ${judgment.coverage.addressed}/${judgment.coverage.planned} planned checks addressed (run ${runId})`
  );

  if (judgment.cause === "ENVIRONMENT_DEFECT") {
    // The environment, not the product, is what failed: quarantine so `review`
    // and `slack` cannot report this as a verdict on the app.
    markRunInvalid(
      paths,
      `judge run ${runId}: ENVIRONMENT_DEFECT — ${judgment.summary.split("\n")[0]}`
    );
    console.error(
      "Environment defect: the product was never really tested. Not reporting this as a product failure."
    );
    return EXIT_ENVIRONMENT;
  }

  clearRunInvalid(paths);
  return verdictExitCode(judgment.status, failOn);
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
  runMain(main);
}
