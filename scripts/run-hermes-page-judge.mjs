#!/usr/bin/env node
/**
 * Hermes QA judge — logs into staging, opens the target page, and verifies live DOM.
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent judge --page=pricing --target-path=/pricing
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runHermes } from "./hermes-runner.mjs";
import { resolveSpecForJudge } from "./resolve-spec-for-judge.mjs";
import {
  buildHermesStagingLogin,
  assertStagingQaCredentials,
  redactEmail,
} from "./staging-qa-config.mjs";
import { resolveStagingQaConfig } from "./staging-qa-prompt.mjs";
import { listAlwaysRunScenarios } from "./dashboard-spec-parser.mjs";
import { renderJudgeHermesDocument } from "./qa-spec-judge-document.mjs";
import {
  artifactPaths,
  ensureProjectConfig,
  listAnnotatedSpecFiles,
  parsePageArg,
  parseTargetPathArg,
  resolveSpecDir,
} from "./page-qa-paths.mjs";
import {
  getProjectConfig,
  mergeUploadFixtures,
  resolveDefaultUploadFixtures,
  resolveFixturePaths,
} from "./hermes-qa-project-config.mjs";

const HERMES_MAX_TURNS_BROWSE = 150;

function loadSpecSourceFiles(specDir) {
  const files = listAnnotatedSpecFiles(specDir);
  const result = {};
  for (const file of files) {
    result[file] = readFileSync(join(specDir, file), "utf8");
  }
  return result;
}

function buildUploadFixturesPayload(specDefinition, page) {
  const projectRoot = getProjectConfig().root;
  const configDefaults = resolveDefaultUploadFixtures(page);
  const resolvedDefaults = resolveFixturePaths(configDefaults, projectRoot);
  const byCheckId = {};

  for (const scenario of specDefinition?.scenarios ?? []) {
    const scenarioDefaults = mergeUploadFixtures(
      configDefaults,
      scenario.fixtures ?? {}
    );
    for (const test of scenario.tests ?? []) {
      const merged = mergeUploadFixtures(scenarioDefaults, test.fixtures ?? {});
      if (Object.keys(merged).length === 0) continue;
      byCheckId[test.checkId] = resolveFixturePaths(merged, projectRoot);
    }
  }

  const allPaths = new Set([
    ...Object.values(resolvedDefaults),
    ...Object.values(byCheckId).flatMap(entry => Object.values(entry)),
  ]);
  for (const absPath of allPaths) {
    if (!existsSync(absPath)) {
      console.warn(`QA fixture missing on disk: ${absPath}`);
    }
  }

  return {
    projectRoot,
    defaults: resolvedDefaults,
    byCheckId,
  };
}

export function buildBrowseHermesQuery({
  judgeDocument,
  stagingLogin,
}) {
  return [
    "You are a QA judge for a live staging environment.",
    "",
    "## Your task",
    "Follow the **QA test plan** below. Log in, open the target page, run the tests that apply to this account, and report results.",
    "The test plan uses **Given / When / Then** — not JSON. Use the exact test **titles** from the plan in your verdict `checks[].item` field.",
    "",
    "## Rules",
    "- Pick **one** scenario that matches the live account, plus every **Always run** scenario.",
    "- Never mutate subscription or billing (no checkout, cancel, or confirm on destructive dialogs).",
    "- For **Safe interaction** tests: follow Playwright source in the plan; dismiss risky dialogs with Esc only.",
    "- For **Mocked in CI** tests: judge whether live UI matches the **intent**, not mocked API numbers.",
    "- If live data differs from CI mocks but still meets the intent → **pass**.",
    "- If unclear → **manual_review**; if clearly broken → **fail**; if blocked on live → **skip**.",
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
    "## Session credentials",
    "",
    `Login URL: ${stagingLogin.loginUrl}`,
    `Email: ${stagingLogin.email}`,
    `Password: ${stagingLogin.password}`,
    `Target URL: ${stagingLogin.targetUrl}`,
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

  const derivedStatus = checks.some(check => check.result === "fail")
    ? "fail"
    : checks.some(check => check.result === "manual_review") ||
        checks.length === 0
      ? "manual_review"
      : "pass";

  return {
    status: allowedStatuses.has(derivedStatus)
      ? derivedStatus
      : "manual_review",
    summary: raw.summary ?? "Hermes QA judgment completed.",
    checks,
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    recommendedAction: raw.recommendedAction ?? "",
    source: raw.source ?? "hermes-agent",
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

async function runBrowseJudge(page, targetPath, paths, config) {
  const resolved = resolveSpecForJudge(paths);
  if (!resolved) {
    throw new Error(
      `Missing qa spec JSON. Run \`npx playwright-spec-for-ai-agent spec --page=${page}\` first.`
    );
  }

  const stagingLogin = buildHermesStagingLogin(config);
  stagingLogin.targetUrl = new URL(targetPath, config.baseUrl).toString();

  const specDir = resolveSpecDir(page);
  const specSourceFiles = loadSpecSourceFiles(specDir);

  const specDefinition = resolved.definition;
  const uploadFixtures = buildUploadFixturesPayload(specDefinition, page);
  const alwaysRunScenarioIds = listAlwaysRunScenarios(specDefinition).map(
    scenario => scenario.scenarioId
  );

  const judgeDocument = renderJudgeHermesDocument({
    page,
    spec: specDefinition,
    stagingLogin: {
      loginUrl: stagingLogin.loginUrl,
      email: stagingLogin.email,
      targetUrl: stagingLogin.targetUrl,
    },
    accountContext: {
      expectedPlan: config.expectedPlan || null,
      expectedSubscriptionStatus: config.expectedSubscriptionStatus || null,
      accountNotes: config.accountNotes || null,
    },
    alwaysRunScenarioIds,
    uploadFixtures,
    specSourceFiles,
  });

  const specMarkdownPath = paths.specLiveMd ?? paths.specMd;
  writeFileSync(specMarkdownPath, judgeDocument);

  const raw = runHermes(
    buildBrowseHermesQuery({
      judgeDocument,
      stagingLogin,
    }),
    HERMES_MAX_TURNS_BROWSE,
    {
    paths,
    secrets: [config.email, config.password],
    requiredKeys: ["status"],
  });
  return normalizeBrowseDecision(raw);
}

async function main() {
  const argv = process.argv.slice(2);
  await ensureProjectConfig(argv);
  const page = parsePageArg(argv);
  const targetPath = parseTargetPathArg(argv, page);
  const paths = artifactPaths(page);

  mkdirSync(paths.outputDir, { recursive: true });

  const config = await resolveStagingQaConfig(argv, {
    stepLabel: `${page} Hermes judge`,
    targetPath,
    page,
  });
  assertStagingQaCredentials(config);

  const decision = await runBrowseJudge(page, targetPath, paths, config);

  writeFileSync(
    paths.hermesJudgmentJson,
    `${JSON.stringify(decision, null, 2)}\n`
  );
  writeFileSync(
    paths.hermesJudgmentMd,
    renderMarkdown(decision, page, targetPath)
  );

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
