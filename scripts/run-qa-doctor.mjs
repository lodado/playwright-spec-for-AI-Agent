#!/usr/bin/env node
/**
 * doctor — one preflight that answers "is my setup complete?".
 *
 * Every environment problem this checks for used to surface mid-run, as a raw
 * stack trace from whatever layer happened to touch it first: a missing spec
 * dir from the parser, a placeholder base URL from the browser, an absent agent
 * CLI from spawnSync. Here they are all one table with a fix hint each.
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent doctor [--page=<slug>] [--json] [--check-network]
 */
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_ENVIRONMENT, runMain } from "./errors.mjs";
import { describeAdapter, resolveAdapterName, prepareAdapter } from "./ai-agent-adapter.mjs";
import { buildUploadFixturesPayload } from "./qa-spec-artifacts.mjs";
import { inspectUploadFixtures, assertUploadAdapter, preflightUploads } from "./qa-upload-preflight.mjs";
import { resolveStagehandDependency, resolveStagehandModel, resolveStagehandRequest } from "./stagehand-runner.mjs";
import {
  readHermesModelConfig,
  resolveHermesAgentInvocation,
} from "./hermes-runner.mjs";
import {
  getPageConfig,
  getProjectConfig,
  getStorageStatePath,
  isPlaceholderBaseUrl,
  listConfiguredPages,
  resolveBaseUrlForPage,
} from "./hermes-qa-project-config.mjs";
import {
  artifactPaths,
  ensureProjectConfig,
  resolveJudgeTarget,
  resolveSpecDir,
} from "./page-qa-paths.mjs";
import { parseSpecDirectory } from "./spec-annotation-reader.mjs";
import { buildJudgeTargetUrl, redactEmail } from "./staging-qa-config.mjs";
import { hasSessionProfile } from "./qa-browser-session.mjs";
import { verifyLedger } from "./qa-run-ledger.mjs";
import { browserbaseOptions, readBrowserbaseContext, resolveBrowserProvider, launchBrowserbaseSession } from "./browser-provider.mjs";
import { createBrowserbaseClient } from "./browserbase-client.mjs";

const NETWORK_TIMEOUT_MS = 10_000;

const HELP = `Usage: npx playwright-spec-for-ai-agent doctor [options]

  Check config, specs, agent backend, credentials, and stored artifacts.
  Exits 0 when every required check passes, ${EXIT_ENVIRONMENT} otherwise.

Options:
  --page=<slug>      Only check this page (default: every configured page)
  --json             Machine-readable report on stdout
  --check-network    Also fetch each target URL (HEAD/GET, 10s timeout)
                     Browserbase: also validate saved Context existence, never allocate a session
  --check-upload     Verify fixture uploads (external adapters use model calls;
                     Browserbase also allocates a temporary billable session)
  --browser-provider=local|browserbase  Browser backend (or QA_BROWSER_PROVIDER)
  --browserbase-profile=<name>          Saved Context profile (default: default)
  --browserbase-timeout=<seconds>       Validate remote session timeout (60-21600)
  --config=<path>    Project config file
  --project-root=<path>
  --help, -h         Show this help
`;

function check(name, status, detail, hint = "") {
  return { name, status, detail, hint };
}

/** Relative only while it stays inside cwd — `../../../tmp/x` reads worse than absolute. */
function displayPath(path) {
  const rel = relative(process.cwd(), path);
  return !rel || rel.startsWith("..") ? path : rel;
}

/**
 * The config layer reports unknown keys through console.warn, and a warning
 * printed before the table would scroll away above it. Doctor exists to
 * collect exactly this kind of thing, so it captures them instead.
 */
async function loadConfigCapturingWarnings(argv) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await ensureProjectConfig(argv);
  } finally {
    console.warn = original;
  }
  return warnings;
}

function configCheck(warnings) {
  const config = getProjectConfig();
  const detail = config.configPath
    ? displayPath(config.configPath)
    : "none — using built-in defaults";
  const qaWarnings = warnings.filter(line => line.includes("[qa-config]"));
  if (qaWarnings.length === 0) return check("config", "pass", detail);
  return check(
    "config",
    "warn",
    `${detail} — ${qaWarnings.length} warning(s):\n${qaWarnings.join("\n")}`,
    "Run with --strict-config to turn these into errors."
  );
}

/** `command` as resolved by hermes-runner: an absolute path, or a bare name on PATH. */
function locateBinary(command) {
  if (command.includes("/")) return existsSync(command) ? command : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, command))) return join(dir, command);
  }
  return null;
}

/**
 * describeAdapter() does not have to expose resolveModel — read it when it
 * does, and fall back to the one backend whose model lives in a config file.
 */
function resolveAdapterModel(adapter) {
  if (adapter.name === "stagehand") return resolveStagehandModel();
  if (typeof adapter.resolveModel === "function") {
    try {
      return adapter.resolveModel();
    } catch {
      return null;
    }
  }
  if (adapter.name === "hermes") {
    try {
      return readHermesModelConfig().model;
    } catch {
      return null;
    }
  }
  return null;
}

function describeCapabilities(capabilities) {
  return [
    `auth=${capabilities.auth}`,
    `maxTurns=${capabilities.supportsMaxTurns}`,
    `video=${capabilities.supportsVideo}`,
    `blocksEventLoop=${capabilities.blocksEventLoop}`,
  ].join(" ");
}

function adapterChecks() {
  let adapter;
  try {
    adapter = describeAdapter();
  } catch (error) {
    return [
      check(
        "adapter",
        "fail",
        `${resolveAdapterName()} — ${error.message}`,
        error.hint || "Set QA_AI_ADAPTER to a built-in adapter or a module specifier."
      ),
    ];
  }

  const checks = [
    check(
      "adapter",
      "pass",
      `${adapter.name} (${describeCapabilities(adapter.capabilities)})`
    ),
  ];

  if (adapter.name === "hermes") {
    const { command } = resolveHermesAgentInvocation();
    const located = locateBinary(command);
    checks.push(
      located
        ? check("adapter binary", "pass", located)
        : check(
            "adapter binary",
            "fail",
            `${command} not found on PATH or in ~/.hermes/hermes-agent`,
            "Install hermes-agent, or run with QA_AI_ADAPTER=fixture for an offline dry run."
          )
    );
  }

  if (adapter.name === "exec") {
    const command = process.env.QA_AGENT_CMD?.trim();
    checks.push(
      command
        ? check("adapter binary", "pass", `QA_AGENT_CMD=${command}`)
        : check(
            "adapter binary",
            "fail",
            "QA_AGENT_CMD is not set",
            "Export QA_AGENT_CMD=<command reading the prompt on stdin and printing JSON>."
          )
    );
  }

  const model = resolveAdapterModel(adapter);
  checks.push(
    model
      ? check("adapter model", "pass", model)
      : check(
          "adapter model",
          adapter.name === "fixture" ? "skip" : "warn",
          adapter.name === "fixture"
            ? "fixture adapter runs without a model"
            : "no model configured",
          "Set the backend's model (hermes: HERMES_INFERENCE_MODEL or ~/.hermes/config.yaml)."
        )
  );

  if (adapter.name === "hermes") checks.push(hermesProviderCheck());
  if (adapter.name === "stagehand") {
    try {
      resolveStagehandDependency();
      checks.push(check("stagehand SDK", "pass", "@browserbasehq/stagehand@3.7.3 (local execution)"));
    } catch (error) {
      checks.push(check("stagehand SDK", "fail", error.message, error.hint || "Install @browserbasehq/stagehand@3.7.3."));
    }
    try {
      const request = resolveStagehandRequest("", null, { mode: "text-only" });
      checks.push(check("stagehand limits", "pass", `${request.maxSteps} steps, ${request.timeoutMs}ms deadline`));
      const provider = request.model.split("/")[0];
      const keys = { openai: ["OPENAI_API_KEY"], anthropic: ["ANTHROPIC_API_KEY"], google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"] }[provider];
      const hasKey = process.env.QA_STAGEHAND_API_KEY?.trim() || keys?.some(key => process.env[key]?.trim());
      checks.push(check("stagehand model credentials", hasKey ? "pass" : keys ? "fail" : "warn",
        hasKey ? "Model API credential configured (API charges are separate from local browser execution)" : "No recognized model API credential configured",
        "Set QA_STAGEHAND_API_KEY or the model provider's API key. CLI subscription credentials are not reused."));
    } catch (error) {
      checks.push(check("stagehand configuration", "fail", error.message));
    }
  }

  return checks;
}

/** Hermes owns authentication; provider names do not determine env key names. */
function hermesProviderCheck() {
  const configPath = join(homedir(), ".hermes", "config.yaml");
  if (!existsSync(configPath)) {
    return check("adapter provider", "skip", "no ~/.hermes/config.yaml");
  }
  const provider = readFileSync(configPath, "utf8")
    .match(/^\s{2}provider:\s*(\S+)/m)?.[1]
    ?.replace(/^['"]|['"]$/g, "");
  if (!provider || provider === "auto") {
    return check("adapter provider", "skip", provider ?? "not set");
  }

  return check(
    "adapter provider",
    "warn",
    `${provider} — ${provider === "openai-codex" ? "OAuth via Hermes; no provider API key required" : "authentication managed by Hermes"}; credentials not verified offline`,
    "Use `hermes model` to configure or sign in to the provider. doctor --check-upload verifies the upload bridge and browser bytes, not Hermes model authentication."
  );
}

/** Auth requirement for a page, with the same precedence the judge uses. */
function pageAuthRequired(page) {
  const project = getProjectConfig();
  const pageConfig = getPageConfig(page);
  return (
    pageConfig.authRequired ?? project.staging?.authRequired ?? true
  ) !== false;
}

function targetUrlForPage(page) {
  const baseUrl = resolveBaseUrlForPage(page);
  const target = resolveJudgeTarget([], page);
  if (target.pageUrl) return { baseUrl, url: target.pageUrl };
  if (!target.targetPath) return { baseUrl, url: "" };
  if (!baseUrl) return { baseUrl, url: "" };
  try {
    return { baseUrl, url: buildJudgeTargetUrl(target, baseUrl) };
  } catch {
    return { baseUrl, url: "" };
  }
}

function specChecks(page) {
  const specDir = resolveSpecDir(page);
  const label = displayPath(specDir);

  if (!existsSync(specDir)) {
    return [
      check(
        `${page} · spec dir`,
        "fail",
        `missing: ${label}`,
        `Create it, or set pages.${page}.specDir (or paths.specDir) in your config.`
      ),
    ];
  }

  let parsed;
  try {
    parsed = parseSpecDirectory(specDir);
  } catch (error) {
    return [
      check(
        `${page} · spec dir`,
        "fail",
        `${label} — ${error.message}`,
        error.hint || "Fix the annotation the parser named, then re-run doctor."
      ),
    ];
  }

  const liveSkipped = parsed.scenarios.filter(scenario => scenario.liveSkip).length;
  const runnable = parsed.scenarios.length - liveSkipped;
  if (parsed.scenarios.length === 0) {
    return [
      check(
        `${page} · spec dir`,
        "fail",
        `${label} — no *.spec.ts carries // @qa-scenario`,
        "Add a file-level `// @qa-scenario: <ID>` comment to the specs you want judged."
      ),
    ];
  }

  return [
    check(
      `${page} · spec dir`,
      runnable === 0 ? "warn" : "pass",
      `${label} — ${parsed.scenarios.length} annotated, ${liveSkipped} @qa-live-skip, ${runnable} runnable`,
      runnable === 0
        ? "Every annotated spec is @qa-live-skip: true, so a live run would judge nothing."
        : ""
    ),
  ];
}

function targetChecks(page) {
  const { baseUrl, url } = targetUrlForPage(page);

  if (isPlaceholderBaseUrl(baseUrl)) {
    return [
      check(
        `${page} · target`,
        "fail",
        baseUrl
          ? `placeholder base URL: ${baseUrl}`
          : "no base URL resolved",
        `Set staging.baseUrl (or pages.${page}.baseUrl) to your real staging origin, or export STAGING_QA_BASE_URL.`
      ),
    ];
  }
  if (!url) {
    return [
      check(
        `${page} · target`,
        "fail",
        `no target path for ${baseUrl}`,
        `Set pages.${page}.targetPath or pages.${page}.pageUrl, or pass --target-path=/${page}.`
      ),
    ];
  }
  return [check(`${page} · target`, "pass", url)];
}

function artifactChecks(page) {
  const paths = artifactPaths(page);
  const checks = [];

  if (!existsSync(paths.hermesJudgmentJson)) {
    checks.push(
      check(`${page} · last verdict`, "skip", "not judged yet", "")
    );
  } else {
    let judgment = null;
    try {
      judgment = JSON.parse(readFileSync(paths.hermesJudgmentJson, "utf8"));
    } catch {
      judgment = null;
    }
    checks.push(
      judgment
        ? check(
            `${page} · last verdict`,
            "pass",
            `${judgment.status ?? "unknown"}${judgment.judgedAt ? ` at ${judgment.judgedAt}` : ""}`
          )
        : check(
            `${page} · last verdict`,
            "warn",
            `unreadable ${displayPath(paths.hermesJudgmentJson)}`,
            "Delete it and re-run `judge` for this page."
          )
    );
  }

  if (existsSync(paths.runInvalidMarker)) {
    checks.push(
      check(
        `${page} · quarantine`,
        "warn",
        `run quarantined: ${displayPath(paths.runInvalidMarker)}`,
        "The last judge run failed before writing a verdict. Re-run `judge` for this page."
      )
    );
  }

  if (existsSync(paths.runsLedger)) {
    const ledger = verifyLedger(paths.runsLedger);
    checks.push(
      ledger.ok
        ? check(`${page} · run ledger`, "pass", `${ledger.entries} entries, chain verified`)
        : check(
            `${page} · run ledger`,
            "fail",
            `chain broken at entry ${ledger.brokenAt}: ${ledger.reason}`,
            "The ledger is append-only; a broken chain means it was edited or truncated. Archive it and start a new one."
          )
    );
  }

  return checks;
}

function credentialChecks(pages) {
  const authPages = pages.filter(pageAuthRequired);
  return credentialVerdicts({
    authPages,
    seededPages: authPages.filter(page => getStorageStatePath(page)),
    email: process.env.STAGING_QA_EMAIL?.trim() ?? "",
    password: process.env.STAGING_QA_PASSWORD?.trim() ?? "",
    session: hasSessionProfile(),
    attachUrl: process.env.QA_BROWSER_CDP_URL?.trim() ?? "",
  });
}

/**
 * A storage state or an attached browser IS the session, so a project using
 * either needs no credentials at all — failing it here would send the
 * operator hunting for a password the run never asks for.
 */
function credentialVerdicts({ authPages, seededPages, email, password, session, attachUrl }) {
  const sessionCheck = check(
    "session profile",
    session ? "pass" : "skip",
    session
      ? "pre-authenticated browser session present"
      : "none — judge would need credentials in the prompt",
    session ? "" : "Run `npx playwright-spec-for-ai-agent login` to create one."
  );

  if (authPages.length === 0) {
    return [
      sessionCheck,
      check("credentials", "skip", "no configured page requires login"),
    ];
  }

  if (attachUrl) {
    return [
      sessionCheck,
      check(
        "credentials",
        "skip",
        `QA_BROWSER_CDP_URL=${attachUrl} — judge attaches to your browser, no credentials needed`
      ),
    ];
  }

  if (seededPages.length === authPages.length) {
    return [
      sessionCheck,
      check(
        "credentials",
        "pass",
        `storage state configured for: ${seededPages.join(", ")} — no credentials needed`
      ),
    ];
  }

  const have = email && password;
  const needing = authPages.filter(page => !seededPages.includes(page));
  const detail = `${email ? redactEmail(email) : "STAGING_QA_EMAIL unset"} / ${
    password ? "password set" : "STAGING_QA_PASSWORD unset"
  } — required by: ${needing.join(", ")}`;

  return [
    sessionCheck,
    have || session
      ? check("credentials", have ? "pass" : "warn", detail,
          have ? "" : "The session profile covers judge runs; `login` still needs these.")
      : check(
          "credentials",
          "fail",
          detail,
          "Export STAGING_QA_EMAIL and STAGING_QA_PASSWORD, or run `login` once to store a session."
        ),
  ];
}

function browserbaseAuthCheck(page, { required, context, seeded, hint }) {
  return check(`${page} · Browserbase auth`, !required ? "skip" : context || seeded ? "pass" : "fail",
    !required ? "page does not require login" : context || seeded
      ? `${context ? "saved Context present" : "storageState present"}; site login not verified live`
      : "No saved Context or existing storageState for required login; site login not verified live",
    required && !context && !seeded ? hint : "");
}

/** Presence and Context existence are not proof of an authenticated site session. */
async function browserbaseChecks(pages, argv, checkNetwork) {
  const { profile } = browserbaseOptions(argv);
  const root = getProjectConfig().root;
  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim() || "";
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim() || "";
  const checks = [
    ...["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"].map(name =>
      check(name, process.env[name]?.trim() ? "pass" : "fail",
        process.env[name]?.trim() ? "present (not verified remotely)" : "not set",
        `Export ${name}.`)),
  ];
  const conflict = argv.some(arg => arg === "--cdp-url" || arg.startsWith("--cdp-url=") ||
    arg === "--credentials-in-prompt") ||
    Boolean(process.env.QA_BROWSER_CDP_URL?.trim());
  checks.push(check("Browserbase options", conflict ? "fail" : "pass",
    conflict ? "Browserbase does not support --cdp-url, QA_BROWSER_CDP_URL or --credentials-in-prompt" : "no conflicting local browser options",
    conflict ? "Remove the conflicting option or select --browser-provider=local." : ""));
  let attach = false;
  try { attach = describeAdapter().capabilities.auth === "cdp-attach"; } catch { /* adapterChecks reports the error */ }
  checks.push(check("Browserbase adapter auth", attach ? "pass" : "fail",
    attach ? "cdp-attach supported" : "Browserbase requires adapter auth=cdp-attach",
    attach ? "" : "Choose a cdp-attach adapter (exec: QA_AGENT_AUTH=cdp-attach)."));

  let client;
  for (const page of pages) {
    const hint = `Run \`npx playwright-spec-for-ai-agent login --browser-provider=browserbase --page=${page} --browserbase-profile=${profile} --success-url=<authenticated-url>\`, or configure storageState.`;
    let context = null;
    if (projectId) {
      try {
        const { url } = targetUrlForPage(page);
        context = readBrowserbaseContext({ root, projectId, origin: new URL(url).origin, profile });
      } catch {
        checks.push(check(`${page} · Browserbase context`, "fail",
          "Cannot read saved Context for the resolved target origin and profile",
          "Check the target URL and .private/qa-browserbase-contexts.json in the project root."));
      }
    }
    const storageState = getStorageStatePath(page);
    checks.push(browserbaseAuthCheck(page, {
      required: pageAuthRequired(page),
      context,
      seeded: storageState && existsSync(storageState),
      hint,
    }));

    if (!checkNetwork) continue;
    const name = `${page} · Browserbase context remote`;
    if (!context || !apiKey || !projectId) {
      checks.push(check(name, "skip", !context
        ? "No saved Context: remote validation skipped; credential presence only, not verified"
        : "Missing credentials: remote validation skipped, not verified"));
      continue;
    }
    try {
      client ??= createBrowserbaseClient();
      const remote = await client.getContext(context.contextId);
      const valid = remote?.id === context.contextId &&
        (remote.projectId === undefined || remote.projectId === projectId);
      checks.push(check(name, valid ? "pass" : "fail", valid
        ? "Context exists in Browserbase; site login not verified live"
        : "Saved Context is missing or belongs to a different project", valid ? "" : hint));
    } catch {
      // Never include provider errors: they can contain credentials or response bodies.
      checks.push(check(name, "fail", "Unable to validate saved Context remotely; site login not verified live",
        "Check Browserbase credentials, project and saved Context availability."));
    }
  }
  return checks;
}

async function peerChecks(browserbase = false) {
  try {
    await import("@playwright/test");
    return check("@playwright/test", "pass", "importable");
  } catch {
    return check(
      "@playwright/test",
      browserbase ? "fail" : "warn",
      browserbase ? "not installed (required for Browserbase CDP attach)" : "not installed (optional peer)",
      browserbase ? "Install the local CDP client: npm i -D @playwright/test (no local browser needed)." : "Needed for `login`, the pre-authenticated session, and trace/HAR evidence: npm i -D @playwright/test && npx playwright install chromium"
    );
  }
}

function slackCheck() {
  return process.env.SLACK_WEBHOOK_URL
    ? check("SLACK_WEBHOOK_URL", "pass", "set")
    : check("SLACK_WEBHOOK_URL", "skip", "unset — `slack` would refuse to post");
}

/** HEAD first; some staging stacks answer 405 to it, so fall back to GET. */
async function probeUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    let response = await fetch(url, { method: "HEAD", signal: controller.signal });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, { method: "GET", signal: controller.signal });
    }
    return {
      ok: response.ok,
      detail: `${response.status} ${response.statusText}`.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      detail:
        error?.name === "AbortError"
          ? `no response within ${NETWORK_TIMEOUT_MS / 1000}s`
          : (error?.message ?? String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function networkChecks(pages) {
  const checks = [];
  for (const page of pages) {
    const { url } = targetUrlForPage(page);
    if (!url) continue;
    const { ok, detail } = await probeUrl(url);
    checks.push(
      ok
        ? check(`${page} · reachable`, "pass", `${url} → ${detail}`)
        : check(
            `${page} · reachable`,
            "fail",
            `${url} → ${detail}`,
            "Check the staging origin is up and reachable from this machine (VPN, allowlist, DNS)."
          )
    );
  }
  return checks;
}

async function uploadCheck(page, argv, browserbase) {
  const name = `${page} · upload fixtures`;
  try {
    const parsed = parseSpecDirectory(resolveSpecDir(page));
    const payload = buildUploadFixturesPayload({ scenarios: parsed.scenarios.filter(scenario => !scenario.liveSkip) }, page);
    const fixtures = inspectUploadFixtures(payload);
    if (!fixtures.length) return check(name, "skip", "No upload fixtures declared.");
    const adapter = await prepareAdapter();
    assertUploadAdapter(adapter);
    if (!argv.includes("--check-upload")) return check(name, "warn",
      `${fixtures.length} readable file(s); actual agent upload tools are NOT verified.`,
      "Run doctor --check-upload (external adapters use model calls). Judge always runs this probe before judging.");
    const { profile, timeoutSeconds } = browserbaseOptions(argv);
    await preflightUploads(payload, {
      adapter,
      ...(browserbase ? { createSession: () => launchBrowserbaseSession({
        root: getProjectConfig().root,
        projectId: process.env.BROWSERBASE_PROJECT_ID?.trim(),
        origin: new URL(targetUrlForPage(page).url).origin,
        profile, timeoutSeconds, persist: false,
      }) } : {}),
    });
    return check(name, "pass", `${fixtures.length} fixture(s) attached through the upload probe; bytes verified independently.`);
  } catch (error) {
    return check(name, "fail", error.message, error.hint || "Fix the fixture annotations and upload environment.");
  }
}

export function parseDoctorArgs(argv = []) {
  const pageArg = argv.find(arg => arg.startsWith("--page="));
  return {
    page: pageArg ? pageArg.slice("--page=".length).trim() : "",
    json: argv.includes("--json"),
    checkNetwork: argv.includes("--check-network"),
  };
}

/**
 * @param {string[]} argv
 * @returns {Promise<{ ok: boolean, checks: Array<{name: string, status: string, detail: string, hint: string}> }>}
 */
export async function collectDoctorReport(argv = []) {
  const options = parseDoctorArgs(argv);
  const warnings = await loadConfigCapturingWarnings(argv);
  const browserbase = resolveBrowserProvider(argv) === "browserbase";

  const configured = listConfiguredPages();
  const pages = options.page ? [options.page] : configured;

  const checks = [configCheck(warnings)];

  if (pages.length === 0) {
    checks.push(
      check(
        "pages",
        "fail",
        "no pages configured",
        "Add a `pages` block to playwright-spec-for-ai-agent.config.mjs (see the example config)."
      )
    );
  } else if (options.page && !configured.includes(options.page)) {
    checks.push(
      check(
        "pages",
        "warn",
        `--page=${options.page} is not in the config's \`pages\` block`,
        `Known pages: ${configured.join(", ") || "(none)"}.`
      )
    );
  }

  for (const page of pages) {
    checks.push(...specChecks(page), ...targetChecks(page), ...artifactChecks(page));
    checks.push(await uploadCheck(page, argv, browserbase));
  }

  checks.push(...adapterChecks(),
    ...(browserbase ? await browserbaseChecks(pages, argv, options.checkNetwork) : credentialChecks(pages)),
    await peerChecks(browserbase), slackCheck());

  if (options.checkNetwork) {
    checks.push(...(await networkChecks(pages)));
  }

  return { ok: checks.every(entry => entry.status !== "fail"), checks };
}

export function formatDoctorReport(report) {
  const width = Math.max(...report.checks.map(entry => entry.name.length)) + 2;
  const lines = ["", "playwright-spec-for-ai-agent doctor", ""];

  for (const entry of report.checks) {
    const [first, ...rest] = entry.detail.split("\n");
    lines.push(
      `  ${entry.status.toUpperCase().padEnd(5)} ${entry.name.padEnd(width)}${first}`
    );
    for (const line of rest) lines.push(`${" ".repeat(width + 9)}${line}`);
    if (entry.status !== "pass" && entry.hint) {
      lines.push(`${" ".repeat(width + 9)}→ ${entry.hint}`);
    }
  }

  const count = status =>
    report.checks.filter(entry => entry.status === status).length;
  lines.push(
    "",
    `${count("fail")} failed, ${count("warn")} warning, ${count("pass")} passed, ${count("skip")} skipped.`,
    ""
  );
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const report = await collectDoctorReport(argv);
  console.log(
    parseDoctorArgs(argv).json
      ? JSON.stringify(report, null, 2)
      : formatDoctorReport(report)
  );
  return report.ok ? undefined : EXIT_ENVIRONMENT;
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) runMain(main);
