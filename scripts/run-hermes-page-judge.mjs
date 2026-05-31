#!/usr/bin/env node
/**
 * Hermes QA judge — logs into staging, opens the target page, and verifies live DOM.
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent judge --page=pricing --target-path=/pricing
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildHermesStagingLogin,
  assertStagingQaCredentials,
  redactEmail,
} from "./staging-qa-config.mjs";
import { resolveStagingQaConfig } from "./staging-qa-prompt.mjs";
import {
  buildBrowseChecklist,
  listAlwaysRunScenarios,
} from "./dashboard-spec-parser.mjs";
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

const REQUIRED_HERMES_AGENT_BIN = "hermes-agent";
const HERMES_QA_COMMAND =
  process.env.HERMES_QA_COMMAND?.trim() || REQUIRED_HERMES_AGENT_BIN;
const HERMES_MAX_TURNS_BROWSE = 150;

function readText(path, fallback = "") {
  if (!existsSync(path)) return fallback;
  return readFileSync(path, "utf8");
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadSpecSourceFiles(specDir) {
  const files = listAnnotatedSpecFiles(specDir);
  const result = {};
  for (const file of files) {
    result[file] = readFileSync(join(specDir, file), "utf8");
  }
  return result;
}

function resolveHermesAgentInvocation() {
  const installRoot = join(homedir(), ".hermes", "hermes-agent");
  const localPython = join(installRoot, "venv", "bin", "python");
  const localRunner = join(installRoot, "run_agent.py");
  if (existsSync(localPython) && existsSync(localRunner)) {
    return { command: localPython, baseArgs: [localRunner] };
  }

  const localInstallBin = join(
    homedir(),
    ".hermes",
    "hermes-agent",
    "venv",
    "bin",
    REQUIRED_HERMES_AGENT_BIN
  );
  if (existsSync(localInstallBin))
    return { command: localInstallBin, baseArgs: [] };

  return { command: REQUIRED_HERMES_AGENT_BIN, baseArgs: [] };
}

/** Read model settings from ~/.hermes/config.yaml (same source as `hermes -z`). */
function readHermesModelConfig() {
  const envModel = process.env.HERMES_INFERENCE_MODEL?.trim();
  if (envModel) {
    return {
      model: envModel,
      baseUrl: process.env.HERMES_INFERENCE_BASE_URL?.trim() || null,
    };
  }

  const configPath = join(homedir(), ".hermes", "config.yaml");
  if (!existsSync(configPath)) {
    return { model: null, baseUrl: null };
  }

  const text = readFileSync(configPath, "utf8");
  const readField = name => {
    const match = text.match(new RegExp(`^  ${name}:\\s*(.+)$`, "m"));
    if (!match) return null;
    return match[1].trim().replace(/^['"]|['"]$/g, "");
  };

  return {
    model: readField("default") || readField("model"),
    baseUrl: readField("base_url"),
  };
}

function buildHermesAgentArgs(query, maxTurns) {
  const { model, baseUrl } = readHermesModelConfig();
  if (!model) {
    throw new Error(
      "Hermes model is not configured. Set model.default in ~/.hermes/config.yaml or export HERMES_INFERENCE_MODEL."
    );
  }

  const args = [
    `--query=${query}`,
    `--max_turns=${maxTurns}`,
    `--model=${model}`,
  ];
  if (baseUrl) args.push(`--base_url=${baseUrl}`);
  return args;
}

function extractJsonDecision(output, { rawOutputPath = null } = {}) {
  const candidates = [];

  for (const match of output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1]);
  }

  for (let start = 0; start < output.length; start += 1) {
    if (output[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const char = output[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(output.slice(start, index + 1));
          break;
        }
      }
    }
  }

  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && "status" in parsed)
        return parsed;
    } catch {
      // Keep scanning.
    }
  }

  const artifactHint = rawOutputPath ? ` See raw output: ${rawOutputPath}` : "";
  throw new Error(
    `Hermes did not return a JSON decision.${artifactHint} Preview: ${output.slice(0, 2_000)}`
  );
}

function redactHermesOutput(output) {
  return output
    .replace(/Using API key: .*/g, "Using API key: [redacted]")
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token)=)[^\s&"']+/gi,
      "$1[redacted]"
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[redacted]")
    .replace(
      /API key was rejected by the provider\.[\s\S]*$/m,
      "API key was rejected. [redacted]"
    );
}

function redactSensitiveText(text, secrets = []) {
  let redacted = redactHermesOutput(text ?? "");
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[redacted]");
    redacted = redacted.split(encodeURIComponent(secret)).join("[redacted]");
  }
  return redacted
    .replace(/([?&](?:email|password)=)[^\s&"']*/gi, "$1[redacted]")
    .replace(/("--password=)(?:\\.|[^"\\\s])+/g, "$1[redacted]")
    .replace(
      /("(?:email|password)"\s*:\s*")(?:\\.|[^"\\])*(")/gi,
      "$1[redacted]$2"
    );
}

function throwIfHermesAuthRejected(output, rawOutputPath = null) {
  if (!/API key was rejected|PermissionDeniedError|HTTP 403/i.test(output)) {
    return;
  }
  const artifactHint = rawOutputPath ? ` See raw output: ${rawOutputPath}` : "";
  throw new Error(
    `Hermes API key was rejected or permission denied.${artifactHint}`
  );
}

function runHermes(query, maxTurns, { paths = null, secrets = [] } = {}) {
  if (HERMES_QA_COMMAND !== REQUIRED_HERMES_AGENT_BIN) {
    throw new Error(
      `QA judge must use exactly ${REQUIRED_HERMES_AGENT_BIN}. Got: ${JSON.stringify(HERMES_QA_COMMAND)}`
    );
  }

  const invocation = resolveHermesAgentInvocation();
  if (paths?.hermesQuery) {
    writeFileSync(paths.hermesQuery, redactSensitiveText(query, secrets));
  }

  const result = spawnSync(
    invocation.command,
    [...invocation.baseArgs, ...buildHermesAgentArgs(query, maxTurns)],
    {
      shell: false,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10,
    }
  );

  if (result.error) throw result.error;

  const combinedOutput = [
    result.stdout ? `--- stdout ---\n${result.stdout}` : "",
    result.stderr ? `--- stderr ---\n${result.stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const redactedCombinedOutput = redactSensitiveText(
    combinedOutput || "no output",
    secrets
  );

  if (paths?.hermesRawOutput) {
    writeFileSync(paths.hermesRawOutput, redactedCombinedOutput);
  }

  throwIfHermesAuthRejected(redactedCombinedOutput, paths?.hermesRawOutput);

  if (result.status !== 0) {
    throw new Error(
      `Hermes failed (exit ${result.status}): ${redactSensitiveText(result.stderr || result.stdout || "no output", secrets)}`
    );
  }

  const redactedStdout = redactSensitiveText(result.stdout, secrets);
  return extractJsonDecision(redactedStdout, {
    rawOutputPath: paths?.hermesRawOutput,
  });
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

function buildBrowseHermesQuery(payload) {
  return [
    "You are a QA judge for a live staging environment.",
    "",
    "## Your task",
    "Browse the staging site and verify the matching live-safe test cases against the live page DOM.",
    "Use specDefinition as the authoritative list of test titles, stagingMode, liveRunPolicy, and parsed read-only expectations.",
    "Use specSourceFiles to replay executable-interaction tests (read the matching test() body for click steps and post-click assertions).",
    "",
    "## Steps to follow",
    "1. Navigate to: " + payload.stagingLogin.loginUrl,
    "2. Log in with stagingLogin.email and stagingLogin.password",
    "3. Navigate to: " + payload.stagingLogin.targetUrl,
    "4. Inspect the live DOM to determine the account's plan and subscription status",
    "5. From specDefinition/specSourceFiles:",
    "   - Pick ONE plan/status scenario that matches the live account (ACTIVE, INACTIVE, CANCEL_PENDING, …)",
    "   - ALSO include every scenario in alwaysRunScenarioIds / browseChecklist entries with alwaysRun: true — these run regardless of plan/status",
    "6. For each test in (matching plan scenario ∪ always-run scenarios), follow its liveRunPolicy from specDefinition:",
    "   a. executable-readonly → verify parsed expectations against the live DOM (no clicks required)",
    "   b. executable-interaction → safe actions needing live test replay: read click steps from specSourceFiles, verify post-action assertions, dismiss with Esc — NEVER click a destructive confirm button on live",
    "   b2. judgment-interaction-no-confirm → verification would be dangerous on live (e.g. confirm mutates state): replay safe open steps, verify up to the dangerous point, Esc only — NEVER click confirm; skip if confirm click is required to judge",
    "   c. blocked-subscription-mutation → skip (would change subscription/billing); note why in detail",
    "   d. blocked-auth-mock → skip (requires mocked unauthenticated flow)",
    "   e. judgment-mock-api → Playwright cannot replay page.route mocks; YOU judge on live staging:",
    "      - Read the test() body in specSourceFiles for the intended assertion (element, copy, format)",
    "      - Verify the closest live-safe equivalent on the real DOM",
    "      - manual_review when the test requires a specific account state that live does not have and cannot be inferred",
    "      - skip only when verification is impossible; never inject mocks or call page.route on live",
    "   f. blocked-live-skip / blocked-unknown → skip",
    "   g. Record result as pass / fail / skip / manual_review",
    "7. Return the JSON verdict with one checks[] entry per test in (matching plan scenario ∪ always-run scenarios)",
    "",
    "## Rules",
    "- alwaysRunScenarioIds / browseChecklist.alwaysRun: true → MUST execute or judge every listed test",
    "- NEVER mutate subscription/billing state: no checkout, no payment, no plan purchase",
    "- NEVER click any live destructive confirm button (cancel/resume dialogs) — use Esc to dismiss",
    "- executable-interaction: safe actions that require live test replay — replay steps, verify assertions, dismiss with Esc only (no billing/subscription mutation)",
    "- Read-only checks: navigate, scroll, inspect DOM, read text, check element states",
    "- If an element is missing or state is ambiguous → manual_review",
    "- If DOM clearly contradicts an assertion → fail",
    "- judgment-mock-api: never replay page.route mocks; judge whether live DOM satisfies the test intent",
    "- Skip tests from files with @qa-live-skip: true (excluded from specSourceFiles already)",
    "",
    "## Upload fixtures",
    "- uploadFixtures.defaults — named upload files for all tests (absolute paths on disk)",
    "- uploadFixtures.byCheckId — per-test overrides keyed by specDefinition.tests[].checkId",
    "- For a test with setInputFiles in specSourceFiles: merge defaults + byCheckId[checkId], then upload those absolute paths to the matching file input",
    "- Prefer named fixtures from @qa-fixture comments; if the test body uses a repo-relative path, match it against uploadFixtures values under projectRoot",
    "- If a required fixture path is missing on disk, skip that upload step and note why in detail",
    "",
    "## Response format",
    "Return ONLY a raw JSON object — no prose, no markdown fences.",
    "Fields:",
    '  "status": "pass" | "fail" | "manual_review"  (worst result across all checks)',
    '  "summary": 2-4 sentences describing what you found on the live page',
    '  "checks": array — one object per matching test:',
    '    { "item": "<test title>", "result": "pass"|"fail"|"skip"|"manual_review", "detail": "<what you saw or why skipped>" }',
    '  "evidence": array of key DOM observations (plan label, visible elements, errors)',
    '  "recommendedAction": next step for the team or empty string',
    '  "source": "hermes-agent"',
    "",
    "Final answer must be exactly one JSON object and nothing else.",
    "",
    "## Payload",
    JSON.stringify(payload, null, 2),
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
  if (!existsSync(paths.specMd)) {
    throw new Error(
      `Missing ${paths.slug}-qa-spec.md. Run \`npx playwright-spec-for-ai-agent spec --page=${page}\` first.`
    );
  }

  const stagingLogin = buildHermesStagingLogin(config);
  stagingLogin.targetUrl = new URL(targetPath, config.baseUrl).toString();

  const specDir = resolveSpecDir(page);
  const specSourceFiles = loadSpecSourceFiles(specDir);

  const specDefinition = readJson(paths.specJson);
  const uploadFixtures = buildUploadFixturesPayload(specDefinition, page);

  const payload = {
    judgmentMode: "browse-and-verify",
    page,
    targetPath,
    accountContext: {
      email: redactEmail(config.email),
      expectedPlan: config.expectedPlan || null,
      expectedSubscriptionStatus: config.expectedSubscriptionStatus || null,
      accountNotes: config.accountNotes || null,
    },
    stagingLogin,
    specMarkdown: readText(paths.specMd),
    specDefinition,
    uploadFixtures,
    alwaysRunScenarioIds: listAlwaysRunScenarios(specDefinition).map(
      scenario => scenario.scenarioId
    ),
    browseChecklist: buildBrowseChecklist(specDefinition),
    specSourceFiles,
  };

  const raw = runHermes(
    buildBrowseHermesQuery(payload),
    HERMES_MAX_TURNS_BROWSE,
    {
      paths,
      secrets: [config.email, config.password],
    }
  );
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
