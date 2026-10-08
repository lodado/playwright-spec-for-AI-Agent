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
import { prepareAdapter, runAgentAsync } from "./ai-agent-adapter.mjs";
import { inspectUploadFixtures, assertUploadAdapter, preflightUploads } from "./qa-upload-preflight.mjs";
import { writeAgentQueryArtifact } from "./agent-output.mjs";
import { browserbaseOptions, resolveBrowserProvider, readBrowserbaseContext, launchBrowserbaseSession } from "./browser-provider.mjs";
import { runBrowserbaseAgent } from "./browserbase-agent-runner.mjs";
import { servesQaBrowserTools, startQaBrowserTools } from "./qa-browser-tools.mjs";
import { withSchema } from "./artifact-schema.mjs";
import {
  EnvironmentError,
  EXIT_ENVIRONMENT,
  EXIT_OK,
  UsageError,
  runMain,
} from "./errors.mjs";
import {
  getAllowedOrigins,
  getHooks,
  getProjectConfig,
  getStorageStatePath,
  resolveFixturePaths,
  isPlaceholderBaseUrl,
} from "./hermes-qa-project-config.mjs";
import { analyzeHarViolations, buildEvidenceManifest } from "./judge-verdict.mjs";
import { decideAuthMode, prepareJudgePlan as decideJudgePlan } from "./judge-plan.mjs";
import {
  buildJudgment,
  executeWithRetries,
  renderMarkdown,
  verdictExitCode,
} from "./judgment.mjs";
import { envValue, evidenceIo, ledgerIo } from "./node-io.mjs";
import { resolveSpecForJudge } from "./resolve-spec-for-judge.mjs";
import { seedAsideSession, seedProfileSession, readStorageState, cookiesForOrigin, buildLocalStorageEntries } from "./qa-session-seed.mjs";
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
import { describeHashMismatch } from "./spec-hash.mjs";
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
    "The test plan uses **Given / When / Then**. Use each exact test title as `checks[].item`; unique titles do not need a `checkId` in the result.",
    "For repeated titles, include the exact `checkId` from Check identities. It is an opaque token; copy it rather than inventing or editing it.",
    "Report one check per test in the plan. A test you did not execute is still a check — report it with `skip` and say why.",
    "",
    "## Rules",
    "- After every navigation or interaction, wait until the page settles before judging: content stops changing and no skeleton, spinner, or placeholder is still loading (give it up to ~5 seconds).",
    "- Never treat a loading, skeleton, or mid-transition state as evidence that something is missing — re-observe once settled before marking `fail`.",
    "- When a test explicitly checks a transient progress/loading state, capture it immediately while visible, then separately observe completion.",
    "- A failed click or stale element ref is not a product defect. Refresh the snapshot, identify the exact row by a unique document/task ID or href, confirm the action succeeded, then compare the selected row, header, viewer and result. Same-named rows are not interchangeable; ambiguous selection is manual_review.",
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
    "  - **skip** when the mocked precondition cannot exist on this account at all — the test needs `remaining_credits: 0` and you can see the account has 7, or it needs pay-as-you-go and this account is on Free. Quote what the account actually shows. This is not `manual_review`: nothing was ambiguous, the check simply had no way to run here.",
    "- A check's `context` lists its enclosing describe titles; an `as is:` entry is its precondition. When the page is not in that state (the target record is in another status, the control the When needs is absent), the product was never tested: report `skip` with cause `ENVIRONMENT_DEFECT` and quote what the page shows instead. Never report `fail` for an action you did not perform or an outcome you could not observe.",
    "- For other semantic / abstracted expectations: same rule — reasonable for intent → pass; ambiguous → manual_review.",
    "- If blocked on live → **skip**.",
    "- An excerpt ending in `// … excerpt truncated` is not the whole check: never `fail` on behaviour the excerpt does not show — use `manual_review`.",
    "",
    "## Evidence rules (enforced after you answer)",
    "- When qa_checkpoint is available, call it with the exact checkId and current full URL immediately after each check, BEFORE closing a dialog, navigating away or changing state. Copy its evidenceRefs into the result. A pass may quote only text a checkpoint of that check captured: call qa_checkpoint again the moment each quoted state appears, including a transient one such as a processing indicator, before it changes.",
    "- Only executable-interaction checks with a declared upload fixture may call qa_upload_fixture with checkId, current full URL, the fixture name (usually upload), and an exact file-input selector if needed. A judgment-interaction-no-confirm does not authorize file attachment: selection can auto-submit, so judge that path without uploading. A judgment-interaction-no-confirm check whose plan needs an attached file cannot run live: report it `skip` with cause `SPEC_GAP` (the annotation withholds the file its plan needs), never `HARNESS_DEFECT`. The tool attaches approved bytes even to a hidden input. Do not skip an authorized upload merely because browser tools lack file upload. Never upload through terminal scripts or manufacture file content.",
    "- An upload receipt proves attachment only, not processing success. Verify completion/failure in the UI and capture that state separately. Return uploadRefs containing the receiptId; receipts are bound to one checkId and cannot satisfy another check, even for the same file. Each executable-interaction check that declares a fixture needs its own upload under its own checkId, even when an earlier check uploaded the same file; never reuse another check's upload or outcome. Within one check, do not repeat an upload after an unknown outcome.",
    "- Every `pass` needs a runner-captured artifact or exact on-screen text in quotes that can be verified in a captured ARIA snapshot. A URL or number alone is not evidence.",
    "- A `pass` whose `detail` cites nothing concrete, or whose `confidence` is `low`, is downgraded to `manual_review` automatically. Do not pad — report what you saw.",
    "- `evidenceRefs` may name artifacts captured by the runner in this run; never invent paths or cite earlier runs. Leave it `[]` when unknown; verified ARIA quotes will be linked automatically. Final snapshots may not retain earlier screens, so report unavailable evidence honestly.",
    "",
    "## Cause classification",
    "- For asynchronous actions, respect the source observation timeout and keep observing the same document until completion/error or that budget expires. Re-snapshot after processing changes before deciding a later step is blocked.",
    "- A displayed zero credit balance is not proof that a request was blocked. Require a rejected request or an explicit blocking error before blaming credits or assigning ENVIRONMENT_DEFECT; successful job/result responses contradict that explanation.",
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
    '{ "status": "pass"|"fail"|"manual_review", "cause": "PRODUCT_DEFECT"|"SPEC_GAP"|"ENVIRONMENT_DEFECT"|"HARNESS_DEFECT"|"NONE", "summary": "...", "checks": [{ "item": "<exact test title>", "detail": "what you observed, quoting exact values", "result": "pass"|"fail"|"skip"|"manual_review", "confidence": "high"|"medium"|"low", "cause": "PRODUCT_DEFECT"|"SPEC_GAP"|"ENVIRONMENT_DEFECT"|"HARNESS_DEFECT"|"NONE", "evidenceRefs": ["..."], "uploadRefs": ["<runner receiptId when uploading>"] }], "evidence": ["..."], "recommendedAction": "...", "source": "hermes-agent" }',
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
  remoteSession = null,
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
    const maxTurns = adapter.capabilities.supportsMaxTurns ? DETECT_MAX_TURNS : null;
    const options = {
      // Its own artifacts: the judge call that follows writes to the same page
      // and would otherwise overwrite the only record of what the detector saw.
      paths: {
        ...paths,
        hermesQuery: paths.hermesDetectQuery,
        hermesRawOutput: paths.hermesDetectRawOutput,
      },
      secrets: [config.email, config.password, ...(remoteSession?.secrets ?? [])].filter(Boolean),
      requiredKeys: ["state"],
      mode: "browse",
    };
    const raw = remoteSession
      ? await runBrowserbaseAgent(remoteSession, query, maxTurns, options)
      : await runAgentAsync(query, maxTurns, options);
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
  }, { io: ledgerIo });

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
 * The file- and config-backed lookups the core plan decision calls. They stay
 * here: judge-plan.mjs reads no file and no config.
 */
const JUDGE_PLAN_PORTS = {
  resolveSpecForJudge,
  buildStagingLogin: buildHermesStagingLogin,
  loadSpecSourceFiles: page => loadSpecSourceFiles(resolveSpecDir(page)),
  buildUploadFixturesPayload,
  inspectUploadFixtures,
  resolveFixturePaths,
  scopeSavedPlan: (paths, scenarioIds) =>
    existsSync(paths.specLiveMd)
      ? scopePlanMarkdown(readFileSync(paths.specLiveMd, "utf8"), scenarioIds)
      : null,
  buildJudgeDocument: buildJudgeBrowseDocument,
  buildQuery: buildBrowseHermesQuery,
};

/**
 * The plan without writing it. The preflight plan uses this: it only has to
 * prove the run is judgeable, and writing it would leave a plan on disk for a
 * run that never reached the final one. A live plan stamped with another
 * `spec` revision is refused with exit 2, naming the command to re-run.
 */
function buildJudgePlan({ accountState, ...inputs }) {
  const prepared = decideJudgePlan(
    {
      ...inputs,
      accountState: accountState === UNKNOWN_STATE ? null : accountState,
      turnBudgetOverride: envValue("QA_JUDGE_MAX_TURNS"),
    },
    JUDGE_PLAN_PORTS
  );
  if (prepared.mismatch) {
    throw new UsageError(
      describeHashMismatch({
        expected: prepared.mismatch.expected,
        actual: prepared.mismatch.actual,
        producer: "abstract-ai",
        consumer: "judge",
      }),
      {
        hint: `Re-run: npx playwright-spec-for-ai-agent abstract-ai --page=${inputs.page}`,
      }
    );
  }
  return prepared;
}

/**
 * Everything needed to run (or dry-run) the judge: resolved plan, prompt, turn
 * budget, and the planned-check list the verdict floor is measured against.
 * Writes the plan document `review` later reads.
 */
export function prepareJudgePlan(inputs) {
  const { plan, planMarkdown } = buildJudgePlan(inputs);
  writeFileSync(inputs.paths.specJudgePlanMd, planMarkdown);
  return plan;
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
  let sessionCookies = [];
  if (storageStatePath) {
    const state = readStorageState(storageStatePath);
    sessionCookies = cookiesForOrigin(state.cookies, new URL(plan.stagingLogin.targetUrl).origin);
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
    sessionCookies,
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
  remoteSession = null,
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
  const liveInterception = adapter.capabilities.blocksEventLoop === false || adapter.name === "hermes";
  const usesRunnerBrowser = adapter.capabilities.auth === "cdp-attach";
  const session = remoteSession ?? (!usesRunnerBrowser
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
        : null);
  const previousCdp = process.env.BROWSER_CDP_URL;
  if (session && !remoteSession) process.env.BROWSER_CDP_URL = session.cdpUrl;

  let raw;
  let runnerEvidence = null;
  let checkpoint = 0;
  let browserTools;
  try {
    if (session && servesQaBrowserTools(adapter)) {
      browserTools = await startQaBrowserTools({ session, plannedChecks: plan.plannedChecks,
        allowedOrigins, evidenceDir: paths.evidenceDir, label: `${paths.slug}-${runId}`, secrets: plan.secrets });
    }
    const options = {
      paths,
      secrets: [...plan.secrets, ...(remoteSession?.secrets ?? [])],
      requiredKeys: ["status"],
      mode: "browse",
      ...(browserTools ? { browserTools: { url: browserTools.url, token: browserTools.token } } : session && !remoteSession ? {
        captureEvidence: () => session.capture(`${paths.slug}-${runId}-checkpoint-${++checkpoint}`),
      } : {}),
    };
    raw = remoteSession || browserTools
      ? await runBrowserbaseAgent(session, plan.query, plan.maxTurns, options)
      : await runAgentAsync(plan.query, plan.maxTurns, options);
  } finally {
    try { await browserTools?.close(); }
    finally {
      if (session && !remoteSession) {
        if (previousCdp === undefined) delete process.env.BROWSER_CDP_URL;
        else process.env.BROWSER_CDP_URL = previousCdp;
        runnerEvidence = await session.close();
      }
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

function assertBrowserbaseCompatible({ adapter, argv, attachUrl }) {
  if (adapter.capabilities.auth !== "cdp-attach") {
    throw new UsageError("Browserbase requires an AI adapter with auth=cdp-attach.", { hint: "Use hermes, or exec with QA_AGENT_AUTH=cdp-attach and a CDP-capable browser tool." });
  }
  if (attachUrl || argv.includes("--cdp-url")) throw new UsageError("--cdp-url / QA_BROWSER_CDP_URL cannot be combined with Browserbase.");
  if (argv.includes("--credentials-in-prompt")) throw new UsageError("--credentials-in-prompt cannot be combined with Browserbase. Use Browserbase login or storageState.");
}

/**
 * Everything a run is decided from — flags, config, adapter, target and auth
 * mode — resolved before any browser or agent is touched.
 */
async function resolveJudgeRun(argv) {
  await ensureProjectConfig(argv);
  const adapter = await prepareAdapter();
  const browserProvider = resolveBrowserProvider(argv);
  const cloud = browserProvider === "browserbase";
  const cloudOptions = cloud ? browserbaseOptions(argv) : null;
  if (cloud) assertBrowserbaseCompatible({ adapter, argv, attachUrl: resolveAttachUrl(argv) });
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

  const cdpAttach = adapter.capabilities.auth === "cdp-attach";
  const attachUrl = cdpAttach ? resolveAttachUrl(argv) : "";
  const seedable = Boolean(getStorageStatePath(page));
  const authMode = decideAuthMode({
    auth: adapter.capabilities.auth,
    credentialsInPrompt: argv.includes("--credentials-in-prompt"),
    cloud,
    attachUrl,
    sessionProfile: cdpAttach && hasSessionProfile(),
    seedable,
  });

  const { config, target } = await resolveStagingQaConfig(argv, {
    stepLabel: `${page} Hermes judge`,
    target: judgeTarget,
    page,
    requireCredentials: authMode.requireCredentials,
  });
  const preauthenticated = isAuthRequired(config) && authMode.sessionCoversLogin;
  if (isAuthRequired(config) && !preauthenticated) {
    assertStagingQaCredentials(config);
    console.warn(
      "[security] Credentials will be embedded in the Hermes prompt and its session logs. " +
        "Prefer `npx playwright-spec-for-ai-agent login` to create a pre-authenticated session."
    );
  }

  const targetUrl = buildJudgeTargetUrl(target, config.baseUrl);
  if (isPlaceholderBaseUrl(targetUrl)) {
    throw new UsageError(
      `Refusing to judge a placeholder target URL: ${targetUrl}`,
      {
        hint: "Set staging.baseUrl in playwright-spec-for-ai-agent.config.*, or STAGING_QA_BASE_URL.",
      }
    );
  }
  const cloudIdentity = cloud ? { root: getProjectConfig().root, projectId: process.env.BROWSERBASE_PROJECT_ID?.trim(), origin: new URL(targetUrl).origin, profile: cloudOptions.profile } : null;
  const cloudContext = cloud && cloudIdentity.projectId ? readBrowserbaseContext(cloudIdentity) : null;
  if (cloud && isAuthRequired(config) && !cloudContext && !seedable) {
    throw new EnvironmentError("No saved Browserbase Context for this site and profile.", { hint: "Run login --browser-provider=browserbase --success-url=<signed-in-url>, or configure staging.storageState." });
  }

  return {
    argv,
    adapter,
    browserProvider,
    cloud,
    cloudOptions,
    cloudIdentity,
    cloudContext,
    failOn,
    dryRun,
    page,
    paths,
    config,
    target,
    targetPath: displayPathForJudgeTarget(target),
    targetUrl,
    allowedOrigins: getAllowedOrigins(page),
    runId: newRunId(),
    attachUrl,
    seedable,
    preauthenticated,
  };
}

function judgePlanInputs(run, accountState) {
  const { page, target, targetUrl, paths, config, adapter, preauthenticated } = run;
  return { page, target, targetUrl, paths, config, adapter, preauthenticated, accountState };
}

function formatDryRunSummary(run, plan) {
  const { targetUrl, adapter, browserProvider, preauthenticated, paths } = run;
  return [
    `Dry run — no agent was called.`,
    `  target:        ${targetUrl}`,
    `  adapter:       ${adapter.name}`,
    `  browser:       ${browserProvider}`,
    `  auth mode:     ${preauthenticated ? `preauthenticated (${adapter.capabilities.auth})` : "credentials-in-prompt"}`,
    `  plan source:   ${plan.planSource}`,
    `  planned checks:${String(plan.plannedChecks.length).padStart(4)}`,
    `  turn budget:   ${plan.maxTurns ?? "n/a (adapter ignores max turns)"}`,
    `  judge plan:    ${paths.specJudgePlanMd}`,
  ].join("\n");
}

function dryRunJudge(run) {
  const plan = prepareJudgePlan(judgePlanInputs(run, parseStateOverride(run.argv)));
  writeAgentQueryArtifact(run.paths, plan.query, plan.secrets);
  // oracle:side-effect O3
  console.log(formatDryRunSummary(run, plan));
  return EXIT_OK;
}

async function launchRemoteSession({ cloudIdentity, cloudContext, cloudOptions, paths, runId }, state) {
  const session = await launchBrowserbaseSession({
    ...cloudIdentity, contextId: state ? null : cloudContext?.contextId ?? null,
    persist: false, timeoutSeconds: cloudOptions.timeoutSeconds,
    evidenceDir: paths.evidenceDir, label: `${paths.slug}-${runId}`,
  });
  // oracle:side-effect existing operator output moved unchanged out of main (P1 keeps stdout)
  console.log(`Browserbase session: ${session.metadata.sessionId}`);
  // oracle:side-effect existing operator output moved unchanged out of main (P1 keeps stdout)
  console.log(`Session dashboard: https://www.browserbase.com/sessions/${encodeURIComponent(session.metadata.sessionId)}`);
  return session;
}

/**
 * DOMContentLoaded can precede client-side redirects and hydration. Recheck
 * all markers together, rather than accepting stale URL success.
 */
async function waitForAuthMarkers(browserPage, cloudContext, origin) {
  const deadline = Date.now() + 10_000;
  const marker = cloudContext.successSelector
    ? browserPage.locator(cloudContext.successSelector).first()
    : null;
  while (true) {
    const visible = !marker || await marker.isVisible();
    const observed = new URL(browserPage.url());
    observed.search = "";
    if (
      visible && observed.origin === origin &&
      (!cloudContext.successUrl || observed.href === cloudContext.successUrl)
    ) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("session auth markers timed out");
    await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
  }
}

/** Seed a storage state, or prove the saved Context is still signed in. */
async function authenticateRemoteSession({ config, targetUrl, cloudIdentity, cloudContext }, remoteSession, state) {
  const loginRequired = isAuthRequired(config);
  try {
    if (state) {
      await remoteSession.context.addCookies(cookiesForOrigin(state.cookies, cloudIdentity.origin));
      const items = buildLocalStorageEntries(state.origins, cloudIdentity.origin);
      if (items.length) await remoteSession.context.addInitScript(({ origin, items }) => {
        if (location.origin === origin) for (const item of items) localStorage.setItem(item.name, item.value);
      }, { origin: cloudIdentity.origin, items });
    }
    const browserPage = remoteSession.context.pages()[0] || await remoteSession.context.newPage();
    const authUrl = !state && loginRequired && cloudContext?.successUrl ? cloudContext.successUrl : targetUrl;
    const response = await browserPage.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (response && response.status() >= 400) throw new Error("remote target unavailable");
    if (!state && loginRequired && cloudContext) {
      await waitForAuthMarkers(browserPage, cloudContext, cloudIdentity.origin);
    }
  } catch {
    throw new EnvironmentError("Browserbase target could not be reached or its saved login is no longer valid.", { hint: "Check cloud network access and run login --browser-provider=browserbase again if the session expired." });
  }
}

/**
 * Preflight, account-state detection and the agent run. A remote session
 * opened here is always released, and its evidence joins the result.
 */
async function judgeInSession(run) {
  const { adapter, cloud, page, paths, targetUrl, config, preauthenticated, runId } = run;
  let remoteSession = null;
  let result;
  try {
    const { plan: preflightPlan } = buildJudgePlan(judgePlanInputs(run, parseStateOverride(run.argv)));
    if (inspectUploadFixtures(preflightPlan.uploadFixtures).length) assertUploadAdapter(adapter);
    if (!cloud) await preflightUploads(preflightPlan.uploadFixtures, { adapter });
    if (cloud) {
      // Validate the plan before allocating a billable remote browser.
      const state = run.seedable ? readStorageState(getStorageStatePath(page)) : null;
      remoteSession = await launchRemoteSession(run, state);
      await preflightUploads(preflightPlan.uploadFixtures, { adapter, session: remoteSession });
      await authenticateRemoteSession(run, remoteSession, state);
    }
    const accountState = await detectAccountState({
      page,
      paths,
      targetUrl,
      config,
      adapter,
      preauthenticated,
      runId,
      override: parseStateOverride(run.argv),
      remoteSession,
    });
    const plan = prepareJudgePlan(judgePlanInputs(run, accountState?.state ?? null));
    appendRunEvent(paths.runsLedger, {
      runId,
      kind: "judge-start",
      page,
      target: targetUrl,
      adapter: adapter.name,
      specHash: plan.specHash,
      spec: plan.specPath,
    }, { io: ledgerIo });
    if (!cloud) console.log(
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
    result = await executeWithRetries(
      () => executeJudge({
        page,
        paths,
        plan,
        adapter,
        config,
        preauthenticated,
        allowedOrigins: run.allowedOrigins,
        attachUrl: run.attachUrl,
        runId,
        remoteSession,
      }),
      {
        onRetry: entry => {
          appendRunEvent(paths.runsLedger, {
            runId,
            kind: "judge-retry",
            ...entry,
          }, { io: ledgerIo });
          // oracle:side-effect the retry log the loop printed at 9b2031c, moved out of the core retry loop
          console.warn(
            `Judge attempt ${entry.attempt} failed (${entry.reason}): ${entry.error}\nRetrying.`
          );
        },
      }
    );
    return { plan, result, accountState };
  } finally {
    if (remoteSession) {
      const evidence = await remoteSession.close();
      if (result) {
        result.runnerEvidence = evidence;
        result.violations.push(...(evidence.violations ?? []));
      }
    }
  }
}

async function judgeQuarantined(run) {
  try {
    return await judgeInSession(run);
  } catch (error) {
    // Quarantine the run: partial artifacts (raw output, captures) may have
    // been written already; downstream commands must not report on them.
    appendRunEvent(run.paths.runsLedger, {
      runId: run.runId,
      kind: "judge",
      status: "error",
      cause:
        error instanceof EnvironmentError
          ? "ENVIRONMENT_DEFECT"
          : "HARNESS_DEFECT",
      coverage: null,
      artifact: null,
      error: error.message,
    }, { io: ledgerIo });
    markRunInvalid(run.paths, error?.message ?? error);
    throw error;
  }
}

/** Every artifact, ledger entry and notification a finished judgment produces. */
async function publishJudgment({ run, plan, result, judgment }) {
  const { runId, page, paths, target } = run;
  writeFileSync(
    paths.hermesJudgmentJson,
    `${JSON.stringify(judgment, null, 2)}\n`
  );
  writeFileSync(paths.hermesJudgmentMd, renderMarkdown(judgment));
  writeFileSync(
    paths.evidenceManifestJson,
    `${JSON.stringify(
      withSchema(
        {
          runId,
          page,
          generatedAt: judgment.judgedAt,
          ...buildEvidenceManifest({
          runId,
            plannedChecks: plan.plannedChecks,
            checks: judgment.checks,
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
  }, { io: ledgerIo });

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
}

function settleJudgment({ runId, paths, failOn }, judgment) {
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

export async function main(argv = process.argv.slice(2)) {
  const run = await resolveJudgeRun(argv);
  if (run.dryRun) return dryRunJudge(run);

  const { plan, result, accountState } = await judgeQuarantined(run);
  const judgment = withSchema(
    buildJudgment(
      {
        run,
        plan,
        result,
        accountState,
        judgedAt: new Date().toISOString(),
      },
      { io: evidenceIo }
    ),
    "judgment"
  );
  await publishJudgment({ run, plan, result, judgment });
  return settleJudgment(run, judgment);
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
  runMain(main);
}
