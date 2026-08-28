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
import { describeAdapter, resolveAdapterName } from "./ai-agent-adapter.mjs";
import {
  readHermesModelConfig,
  resolveHermesAgentInvocation,
} from "./hermes-runner.mjs";
import {
  getPageConfig,
  getProjectConfig,
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
import { parseSpecDirectory } from "./dashboard-spec-parser.mjs";
import { buildJudgeTargetUrl, redactEmail } from "./staging-qa-config.mjs";
import { hasSessionProfile } from "./qa-browser-session.mjs";
import { verifyLedger } from "./qa-run-ledger.mjs";

const NETWORK_TIMEOUT_MS = 10_000;

const HELP = `Usage: npx playwright-spec-for-ai-agent doctor [options]

  Check config, specs, agent backend, credentials, and stored artifacts.
  Exits 0 when every required check passes, ${EXIT_ENVIRONMENT} otherwise.

Options:
  --page=<slug>      Only check this page (default: every configured page)
  --json             Machine-readable report on stdout
  --check-network    Also fetch each target URL (HEAD/GET, 10s timeout)
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

  return checks;
}

/**
 * A configured model is not a usable one: Hermes reads its provider from the
 * same config and refuses to start when that provider's key is missing. Without
 * this check `doctor` passes and the failure only appears mid-run, one agent
 * invocation later.
 */
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

  // Hermes derives the variable name from the provider verbatim.
  const key = `${provider.toUpperCase()}_API_KEY`;
  const hermesEnv = join(homedir(), ".hermes", ".env");
  const inHermesEnv =
    existsSync(hermesEnv) && new RegExp(`^${key}=`, "m").test(readFileSync(hermesEnv, "utf8"));
  if (process.env[key] || inHermesEnv) {
    return check("adapter provider", "pass", `${provider} (${key} set)`);
  }
  return check(
    "adapter provider",
    "fail",
    `${provider} configured but ${key} is unset — hermes-agent will refuse to start`,
    `Export ${key}, put it in ~/.hermes/.env, or switch provider with \`hermes model\`.`
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
  const email = process.env.STAGING_QA_EMAIL?.trim() ?? "";
  const password = process.env.STAGING_QA_PASSWORD?.trim() ?? "";
  const session = hasSessionProfile();

  const checks = [
    check(
      "session profile",
      session ? "pass" : "skip",
      session
        ? "pre-authenticated browser session present"
        : "none — judge would need credentials in the prompt",
      session ? "" : "Run `npx playwright-spec-for-ai-agent login` to create one."
    ),
  ];

  if (authPages.length === 0) {
    checks.push(
      check("credentials", "skip", "no configured page requires login")
    );
    return checks;
  }

  const have = email && password;
  const detail = `${email ? redactEmail(email) : "STAGING_QA_EMAIL unset"} / ${
    password ? "password set" : "STAGING_QA_PASSWORD unset"
  } — required by: ${authPages.join(", ")}`;

  checks.push(
    have || session
      ? check("credentials", have ? "pass" : "warn", detail,
          have ? "" : "The session profile covers judge runs; `login` still needs these.")
      : check(
          "credentials",
          "fail",
          detail,
          "Export STAGING_QA_EMAIL and STAGING_QA_PASSWORD, or run `login` once to store a session."
        )
  );
  return checks;
}

async function peerChecks() {
  try {
    await import("@playwright/test");
    return check("@playwright/test", "pass", "importable");
  } catch {
    return check(
      "@playwright/test",
      "warn",
      "not installed (optional peer)",
      "Needed for `login`, the pre-authenticated session, and trace/HAR evidence: npm i -D @playwright/test && npx playwright install chromium"
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
  }

  checks.push(...adapterChecks(), ...credentialChecks(pages), await peerChecks(), slackCheck());

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
