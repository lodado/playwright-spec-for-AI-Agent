import { EnvironmentError, UsageError } from "./errors.mjs";
import { isPlaceholderBaseUrl } from "./hermes-qa-project-config.mjs";

const DEFAULT_BASE_URL = "https://your-staging-url.example.com";
const DEFAULT_LOGIN_PATH = "/login";
const DEFAULT_DASHBOARD_PATH = "/dashboard";

const CLI_FLAGS = [
  ["--email=", "STAGING_QA_EMAIL", "Staging QA account email"],
  ["--password=", "STAGING_QA_PASSWORD", "Staging QA account password"],
  [
    "--auth-required=",
    "STAGING_QA_AUTH_REQUIRED",
    "Whether staging requires login before judging",
  ],
  ["--base-url=", "STAGING_QA_BASE_URL", "Staging origin"],
  ["--login-path=", "STAGING_QA_LOGIN_PATH", "Login path"],
  ["--dashboard-path=", "STAGING_QA_DASHBOARD_PATH", "Dashboard path"],
  [
    "--expected-plan=",
    "STAGING_QA_EXPECTED_PLAN",
    "Optional override: expected plan label for Hermes (default: infer from evidence)",
  ],
  [
    "--expected-account-state=",
    "STAGING_QA_EXPECTED_ACCOUNT_STATE",
    "Optional override: expected @qa-scenario account state (default: infer from evidence)",
  ],
  [
    "--expected-subscription-status=",
    "STAGING_QA_EXPECTED_SUBSCRIPTION_STATUS",
    "Legacy alias of --expected-account-state=",
  ],
  [
    "--account-notes=",
    "STAGING_QA_ACCOUNT_NOTES",
    "Free-form QA account notes for Hermes",
  ],
];

export function parseBooleanFlag(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
}

export function isAuthRequired(config) {
  return config.authRequired !== false;
}

export function redactEmail(value) {
  if (!value) return "";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export function parseStagingQaArgs(argv = process.argv.slice(2)) {
  const config = {
    email: process.env.STAGING_QA_EMAIL ?? "",
    password: process.env.STAGING_QA_PASSWORD ?? "",
    authRequired: parseBooleanFlag(process.env.STAGING_QA_AUTH_REQUIRED),
    baseUrl: process.env.STAGING_QA_BASE_URL ?? DEFAULT_BASE_URL,
    loginPath: process.env.STAGING_QA_LOGIN_PATH ?? DEFAULT_LOGIN_PATH,
    dashboardPath:
      process.env.STAGING_QA_DASHBOARD_PATH ?? DEFAULT_DASHBOARD_PATH,
    expectedPlan: process.env.STAGING_QA_EXPECTED_PLAN ?? "",
    // `expectedSubscriptionStatus` stays the internal key other stages read;
    // `expectedAccountState` is the de-branded name users see.
    expectedSubscriptionStatus:
      process.env.STAGING_QA_EXPECTED_ACCOUNT_STATE ??
      process.env.STAGING_QA_EXPECTED_SUBSCRIPTION_STATUS ??
      "",
    accountNotes: process.env.STAGING_QA_ACCOUNT_NOTES ?? "",
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printStagingQaHelp();
      process.exit(0);
    }

    const matchedFlag = CLI_FLAGS.find(([flag]) => arg.startsWith(flag));
    if (!matchedFlag) continue;

    const [, envKey] = matchedFlag;
    const value = arg.slice(matchedFlag[0].length);
    switch (envKey) {
      case "STAGING_QA_EMAIL":
        config.email = value;
        break;
      case "STAGING_QA_PASSWORD":
        config.password = value;
        break;
      case "STAGING_QA_AUTH_REQUIRED":
        config.authRequired = parseBooleanFlag(value);
        break;
      case "STAGING_QA_BASE_URL":
        config.baseUrl = value;
        break;
      case "STAGING_QA_LOGIN_PATH":
        config.loginPath = value;
        break;
      case "STAGING_QA_DASHBOARD_PATH":
        config.dashboardPath = value;
        break;
      case "STAGING_QA_EXPECTED_PLAN":
        config.expectedPlan = value;
        break;
      case "STAGING_QA_EXPECTED_ACCOUNT_STATE":
      case "STAGING_QA_EXPECTED_SUBSCRIPTION_STATUS":
        config.expectedSubscriptionStatus = value;
        break;
      case "STAGING_QA_ACCOUNT_NOTES":
        config.accountNotes = value;
        break;
      default:
        break;
    }
  }

  // Left unset when empty: `applyStagingAccountDefaults` uses `??`, so an empty
  // string here would out-rank the project config's account state.
  if (config.expectedSubscriptionStatus) {
    config.expectedAccountState = config.expectedSubscriptionStatus;
  }
  return config;
}

/**
 * A run against the packaged placeholder origin would judge nothing real, so it
 * is a setup mistake rather than a failed test.
 */
export function assertRealBaseUrl(config) {
  if (!isPlaceholderBaseUrl(config?.baseUrl)) return;
  throw new UsageError(
    `Staging base URL is still the placeholder (${config?.baseUrl || "empty"}).`,
    {
      hint: "Set staging.baseUrl in playwright-spec-for-ai-agent.config.mjs, or pass --base-url=https://staging.your-app.com (env: STAGING_QA_BASE_URL).",
    }
  );
}

export function assertStagingQaCredentials(config) {
  if (!isAuthRequired(config)) return;
  if (!config.email || !config.password) {
    throw new EnvironmentError("Missing staging QA credentials.", {
      hint: [
        "Set STAGING_QA_EMAIL and STAGING_QA_PASSWORD, or pass:",
        "  --email=you@example.com --password='your-password'",
      ].join("\n"),
    });
  }
}

export function buildStagingUrls(config) {
  return {
    loginUrl: new URL(config.loginPath, config.baseUrl).toString(),
    dashboardUrl: new URL(config.dashboardPath, config.baseUrl).toString(),
  };
}

/**
 * @param {{ targetPath?: string | null, pageUrl?: string | null }} target
 */
export function buildJudgeTargetUrl(target, baseUrl) {
  if (target?.pageUrl) {
    return String(target.pageUrl);
  }
  const path = target?.targetPath ?? "";
  return new URL(path, baseUrl).toString();
}

/**
 * @param {string} input
 * @returns {{ targetPath: string, pageUrl: string } | null}
 */
export function parseTargetInput(input, baseUrl) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    return {
      pageUrl: url.toString(),
      targetPath: `${url.pathname}${url.search}${url.hash}`,
    };
  }

  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return {
    targetPath: path,
    pageUrl: new URL(path, baseUrl).toString(),
  };
}

export function displayPathForJudgeTarget(target) {
  if (target?.pageUrl) {
    const url = new URL(target.pageUrl);
    return `${url.pathname}${url.search}${url.hash}` || "/";
  }
  return target?.targetPath ?? "/";
}

/**
 * Apply interactive target confirmation (Y keeps config/CLI target; n uses custom input).
 * @param {{ targetPath?: string | null, pageUrl?: string | null } | null} initialTarget
 * @param {{ confirmed?: boolean, customInput?: string }} [choice]
 * @returns {{ targetPath: string, pageUrl: string } | { targetPath: string | null, pageUrl: string | null } | null}
 */
export function resolveFinalJudgeTarget(
  initialTarget,
  baseUrl,
  { confirmed = true, customInput = "" } = {}
) {
  const base = initialTarget ?? { targetPath: null, pageUrl: null };
  if (confirmed) {
    return base;
  }
  return parseTargetInput(customInput, baseUrl);
}

export function buildHermesStagingLogin(config) {
  const urls = buildStagingUrls(config);
  const authRequired = isAuthRequired(config);
  return {
    authRequired,
    email: authRequired ? config.email : "",
    password: authRequired ? config.password : "",
    loginUrl: urls.loginUrl,
    dashboardUrl: urls.dashboardUrl,
    expectedPlan: config.expectedPlan || null,
    expectedAccountState: config.expectedSubscriptionStatus || null,
    accountNotes: config.accountNotes || null,
    usage: authRequired
      ? "Use only for staging authentication context or diagnosing login failures. Do not mutate subscription or billing state."
      : "No login is required for this target. Open the target URL directly.",
  };
}

export function printStagingQaHelp(scriptName = "dashboard QA script") {
  const flagLines = CLI_FLAGS.map(
    ([flag, envKey, description]) =>
      `  ${flag}<value>    ${description} (env: ${envKey})`
  );

  console.log(`Usage: node ${scriptName} [options]

Options:
${flagLines.join("\n")}
  --non-interactive    Skip prompts (default in CI or non-TTY)
  --yes, -y            Same as --non-interactive
  --help, -h           Show this help

Interactive mode:
  When stdin is a TTY and CI is not set, run/judge prompt for credentials,
  target confirmation, and the expected account state before assertions.

Examples:
  STAGING_QA_EMAIL='qa@example.com' STAGING_QA_PASSWORD='secret!' npx playwright-spec-for-ai-agent judge --page=dashboard
  npx playwright-spec-for-ai-agent judge --page=dashboard --email='qa@example.com' --password='secret!'
  npx playwright-spec-for-ai-agent judge --page=pricing --auth-required=false
`);
}

export { DEFAULT_BASE_URL, DEFAULT_DASHBOARD_PATH, DEFAULT_LOGIN_PATH };
