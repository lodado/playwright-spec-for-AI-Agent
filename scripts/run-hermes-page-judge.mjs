#!/usr/bin/env node
/**
 * Hermes QA judge — logs into staging, opens the target page, and verifies live DOM.
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent judge --page=pricing --target-path=/pricing
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAdapterName, runAgent } from "./ai-agent-adapter.mjs";
import { preloginAside } from "./aside-prelogin.mjs";
import { resolveSpecForJudge } from "./resolve-spec-for-judge.mjs";
import {
  buildHermesStagingLogin,
  assertStagingQaCredentials,
  buildJudgeTargetUrl,
  displayPathForJudgeTarget,
  isAuthRequired,
  redactEmail,
} from "./staging-qa-config.mjs";
import {
  hasSessionProfile,
  launchAuthenticatedBrowser,
} from "./qa-browser-session.mjs";
import { clearRunInvalid, markRunInvalid } from "./qa-run-invalid.mjs";
import { resolveStagingQaConfig } from "./staging-qa-prompt.mjs";
import { listAlwaysRunScenarios } from "./dashboard-spec-parser.mjs";
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

const HERMES_MAX_TURNS_BROWSE = 150;

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
    "After browsing, reply with **only** one raw JSON object (no markdown fences):",
    '{ "status": "pass"|"fail"|"manual_review", "summary": "...", "checks": [{ "item": "<exact test title>", "result": "pass"|"fail"|"skip"|"manual_review", "detail": "..." }], "evidence": ["..."], "recommendedAction": "...", "source": "hermes-agent" }',
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

export function normalizeBrowseDecision(raw) {
  const allowedStatuses = new Set(["pass", "fail", "manual_review"]);
  const allowedCheckResults = new Set([
    "pass",
    "fail",
    "skip",
    "manual_review",
  ]);
  const checks = Array.isArray(raw.checks)
    ? raw.checks.map(check => ({
        item: String(check?.item ?? "Untitled check"),
        result: allowedCheckResults.has(check?.result)
          ? check.result
          : "manual_review",
        detail: String(check?.detail ?? ""),
      }))
    : [];

  // A run where nothing was actually executed (all skip, e.g. login failure)
  // must never report green — same principle as pytest exit code 5 / Playwright
  // "no tests found".
  const executed = checks.filter(check => check.result !== "skip");
  const derivedStatus = checks.some(check => check.result === "fail")
    ? "fail"
    : checks.some(check => check.result === "manual_review") ||
        executed.length === 0
      ? "manual_review"
      : "pass";

  // Normalization may only downgrade the agent's own verdict, never upgrade
  // it: if the agent said manual_review/fail, checks cannot turn that into pass.
  const severity = { pass: 0, manual_review: 1, fail: 2 };
  const agentStatus = allowedStatuses.has(raw.status) ? raw.status : null;
  const status =
    agentStatus && severity[agentStatus] > severity[derivedStatus]
      ? agentStatus
      : derivedStatus;

  return {
    status,
    summary: raw.summary ?? "Hermes QA judgment completed.",
    checks,
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    recommendedAction: raw.recommendedAction ?? "",
    source: raw.source ?? "hermes-agent",
    ...(raw.agentMeta ? { agentMeta: raw.agentMeta } : {}),
  };
}

function renderMarkdown(decision, page, targetPath) {
  const checkRows = decision.checks?.length
    ? decision.checks.map(c => {
        const icon =
          c.result === "pass"
            ? "pass"
            : c.result === "fail"
              ? "fail"
              : c.result === "skip"
                ? "skip"
                : "manual_review";
        return `| ${icon} | ${c.item} | ${c.detail ?? ""} |`;
      })
    : [];

  return [
    `# Hermes QA Judgment — ${page}`,
    "",
    `- Status: **${decision.status}**`,
    `- Mode: \`browse\``,
    `- Page: \`${targetPath}\``,
    `- Source: ${decision.source}`,
    ...(decision.agentMeta
      ? [
          `- Adapter: ${decision.agentMeta.adapter}${decision.agentMeta.model ? ` (${decision.agentMeta.model})` : ""}, ${Math.round(decision.agentMeta.durationMs / 1000)}s`,
        ]
      : []),
    "",
    "## Summary",
    "",
    decision.summary,
    "",
    ...(checkRows.length
      ? [
          "## Checks",
          "",
          "| Result | Item | Detail |",
          "|--------|------|--------|",
          ...checkRows,
          "",
        ]
      : []),
    "## Evidence",
    "",
    ...(decision.evidence?.length
      ? decision.evidence.map(item => `- ${item}`)
      : ["- none"]),
    "",
    "## Recommended action",
    "",
    decision.recommendedAction || "none",
    "",
  ].join("\n");
}

async function runBrowseJudge(page, target, paths, config, { preauthenticated = false } = {}) {
  const resolved = resolveSpecForJudge(paths);
  if (!resolved) {
    throw new Error(
      `Missing qa spec JSON. Run \`npx playwright-spec-for-ai-agent spec --page=${page}\` first.`
    );
  }

  const stagingLogin = buildHermesStagingLogin(config);
  if (preauthenticated) {
    // The agent browses a pre-authenticated browser over CDP; credentials and
    // even the account email stay out of the prompt and the judge plan.
    stagingLogin.email = "";
    stagingLogin.password = "";
  }
  stagingLogin.targetUrl = buildJudgeTargetUrl(target, config.baseUrl);
  const targetPath = displayPathForJudgeTarget(target);

  const specDir = resolveSpecDir(page);
  const specSourceFiles = loadSpecSourceFiles(specDir);

  const specDefinition = resolved.definition;
  const uploadFixtures = buildUploadFixturesPayload(specDefinition, page);
  const alwaysRunScenarioIds = listAlwaysRunScenarios(specDefinition).map(
    scenario => scenario.scenarioId
  );

  const savedPlanMarkdown = existsSync(paths.specLiveMd)
    ? readFileSync(paths.specLiveMd, "utf8")
    : null;
  const savedPlanSource = savedPlanMarkdown ? "spec-live.md" : null;

  const { document: judgeDocument, planSource } = buildJudgeBrowseDocument({
    page,
    spec: specDefinition,
    specLiveMarkdown: savedPlanMarkdown,
    planSource: savedPlanSource,
    stagingLogin: {
      loginUrl: stagingLogin.loginUrl,
      email: stagingLogin.email,
      targetUrl: stagingLogin.targetUrl,
    },
    alwaysRunScenarioIds,
    uploadFixtures,
    specSourceFiles,
  });

  writeFileSync(paths.specJudgePlanMd, judgeDocument);

  if (planSource === "generated-from-json") {
    console.warn(
      `No ${paths.slug}-qa-spec-live.md — generated judge plan from JSON. Run abstract-ai --page=${page} for a stable live spec markdown.`
    );
  } else {
    console.log(`Judge test plan source: ${planSource} (+ session header)`);
  }

  const query = buildBrowseHermesQuery({
    judgeDocument,
    stagingLogin,
    preauthenticated,
  });
  const secrets = [config.email, config.password].filter(Boolean);

  const adapterName = resolveAdapterName();

  // Preauthenticated mode, per adapter:
  // - hermes: relaunch the operator-authenticated profile with a CDP endpoint;
  //   hermes-runner forwards process.env, so BROWSER_CDP_URL makes the agent's
  //   browser tools attach to that session instead of a fresh one.
  // - aside: drive Aside Browser's own persistent profile — log in via a repl
  //   script over stdin (credentials never in argv or prompt), then the exec
  //   agent reuses that session.
  if (preauthenticated && adapterName === "aside") {
    preloginAside({
      loginUrl: stagingLogin.loginUrl,
      email: config.email,
      password: config.password,
    });
  }
  const recordVideoDir = process.env.QA_RECORD_VIDEO
    ? resolve(paths.outputDir, "videos")
    : null;
  const session =
    preauthenticated && adapterName !== "aside"
      ? await launchAuthenticatedBrowser({ recordVideoDir })
      : null;
  if (session) process.env.BROWSER_CDP_URL = session.cdpUrl;
  try {
    const raw = runAgent(query, HERMES_MAX_TURNS_BROWSE, {
      paths,
      secrets,
      requiredKeys: ["status"],
      mode: "browse",
    });
    return normalizeBrowseDecision(raw);
  } finally {
    if (session) {
      delete process.env.BROWSER_CDP_URL;
      await session.close();
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  await ensureProjectConfig(argv);
  const page = parsePageArg(argv);
  const paths = artifactPaths(page);

  mkdirSync(paths.outputDir, { recursive: true });

  const judgeTarget = resolveJudgeTarget(argv, page);
  if (!judgeTarget.pageUrl && !judgeTarget.targetPath) {
    console.error(
      [
        `Missing target for page "${page}".`,
        `Set pages.${page}.pageUrl, pages.${page}.targetPath, or targetPaths.${page} in playwright-spec-for-ai-agent.config.*,`,
        `or pass --target-path=/${page}`,
      ].join(" ")
    );
    process.exit(1);
  }

  // Session-first: with an operator-authenticated browser profile the run
  // needs no credentials anywhere. --credentials-in-prompt forces the legacy
  // flow (plaintext credentials inside the Hermes prompt).
  // Aside preauths differently: it always needs credentials (for the repl
  // prelogin script), but they stay out of the prompt and argv.
  const credentialsInPrompt = argv.includes("--credentials-in-prompt");
  const sessionAvailable = hasSessionProfile();
  const asideAdapter = resolveAdapterName() === "aside";
  const requireCredentials =
    credentialsInPrompt || asideAdapter || !sessionAvailable;

  const { config, target } = await resolveStagingQaConfig(argv, {
    stepLabel: `${page} Hermes judge`,
    target: judgeTarget,
    page,
    requireCredentials,
  });
  const preauthenticated =
    isAuthRequired(config) &&
    !credentialsInPrompt &&
    (asideAdapter || sessionAvailable);
  if (isAuthRequired(config) && !preauthenticated) {
    assertStagingQaCredentials(config);
    console.warn(
      "[security] Credentials will be embedded in the Hermes prompt and its session logs. " +
        "Prefer `npx playwright-spec-for-ai-agent login` to create a pre-authenticated session."
    );
  }

  const targetPath = displayPathForJudgeTarget(target);
  let decision;
  try {
    decision = await runBrowseJudge(page, target, paths, config, {
      preauthenticated,
    });
  } catch (error) {
    // Quarantine the run: partial artifacts (judge plan, raw output) may have
    // been written already; downstream commands must not report on them.
    markRunInvalid(paths, error?.message ?? error);
    throw error;
  }

  writeFileSync(
    paths.hermesJudgmentJson,
    `${JSON.stringify(decision, null, 2)}\n`
  );
  writeFileSync(
    paths.hermesJudgmentMd,
    renderMarkdown(decision, page, targetPath)
  );
  clearRunInvalid(paths);

  console.log(`Hermes ${page} QA judgment (browse): ${decision.status}`);
  if (decision.status === "fail") process.exitCode = 1;
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
