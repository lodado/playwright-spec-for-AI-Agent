const DEFAULT_BASE_URL = "https://your-staging-url.example.com";
const DEFAULT_LOGIN_PATH = "/login";
const DEFAULT_DASHBOARD_PATH = "/dashboard";

const CLI_FLAGS = [
  ["--email=", "STAGING_QA_EMAIL", "Staging QA account email"],
  ["--password=", "STAGING_QA_PASSWORD", "Staging QA account password"],
  ["--base-url=", "STAGING_QA_BASE_URL", "Staging origin"],
  ["--login-path=", "STAGING_QA_LOGIN_PATH", "Login path"],
  ["--dashboard-path=", "STAGING_QA_DASHBOARD_PATH", "Dashboard path"],
  [
    "--expected-plan=",
    "STAGING_QA_EXPECTED_PLAN",
    "Optional override: expected plan label for Hermes (default: infer from evidence)",
  ],
  [
    "--expected-subscription-status=",
    "STAGING_QA_EXPECTED_SUBSCRIPTION_STATUS",
    "Optional override: expected subscription status (default: infer from evidence)",
  ],
  [
    "--account-notes=",
    "STAGING_QA_ACCOUNT_NOTES",
    "Free-form QA account notes for Hermes",
  ],
];

function envKeyForFlag(flagPrefix) {
  return CLI_FLAGS.find(([flag]) => flag === flagPrefix)?.[1];
}

export function redactEmail(value) {
  if (!value) return "";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export function parseStagingQaArgs(argv = process.argv.slice(2)) {
  const config = {
    email: process.env.STAGING_QA_EMAIL ?? "",
    password: process.env.STAGING_QA_PASSWORD ?? "",
    baseUrl: process.env.STAGING_QA_BASE_URL ?? DEFAULT_BASE_URL,
    loginPath: process.env.STAGING_QA_LOGIN_PATH ?? DEFAULT_LOGIN_PATH,
    dashboardPath:
      process.env.STAGING_QA_DASHBOARD_PATH ?? DEFAULT_DASHBOARD_PATH,
    expectedPlan: process.env.STAGING_QA_EXPECTED_PLAN ?? "",
    expectedSubscriptionStatus:
      process.env.STAGING_QA_EXPECTED_SUBSCRIPTION_STATUS ?? "",
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

  return config;
}

export function assertStagingQaCredentials(config) {
  if (!config.email || !config.password) {
    throw new Error(
      [
        "Missing staging QA credentials.",
        "Set STAGING_QA_EMAIL and STAGING_QA_PASSWORD, or pass:",
        "  --email=you@example.com --password='your-password'",
      ].join(" ")
    );
  }
}

export function buildStagingUrls(config) {
  return {
    loginUrl: new URL(config.loginPath, config.baseUrl).toString(),
    dashboardUrl: new URL(config.dashboardPath, config.baseUrl).toString(),
  };
}

export function buildPersistedAccountContext(config) {
  const urls = buildStagingUrls(config);
  return {
    email: redactEmail(config.email),
    loginUrl: urls.loginUrl,
    dashboardUrl: urls.dashboardUrl,
    expectedPlan: config.expectedPlan || null,
    expectedSubscriptionStatus: config.expectedSubscriptionStatus || null,
    accountNotes: config.accountNotes || null,
    passwordIncludedInArtifacts: false,
  };
}

export function hasExplicitAccountExpectations(config) {
  return Boolean(config.expectedPlan || config.expectedSubscriptionStatus);
}

export function buildHermesJudgeInstructions(config) {
  const instructions = [
    "You are Hermes QA judge for a live staging dashboard.",
    "Return strict JSON with status: pass | fail | manual_review.",
    "Never downgrade deterministic Playwright failures to pass.",
    "Treat ambiguous visual concerns as manual_review.",
    "Do not suggest or perform state-changing actions.",
    "Use stagingLogin credentials only if your tools require staging authentication.",
  ];

  if (hasExplicitAccountExpectations(config)) {
    instructions.push(
      "accountContext.expectedPlan / expectedSubscriptionStatus were provided explicitly. Treat them as authoritative expectations."
    );
  } else {
    instructions.push(
      "No explicit plan/status expectation was provided.",
      "Infer the likely dashboard scenario from runResult.playwrightSteps, checks, observed subscription link testIds, visible text, and screenshotPath.",
      "Use specMarkdown only for the scenario that best matches the inferred live state.",
      "Hint mapping: subscription-cancel-link -> ACTIVE, subscription-resume-link -> CANCEL_PENDING, subscription-disabled-link -> INACTIVE/FREE.",
      "If live evidence conflicts with the inferred scenario, return fail or manual_review with concrete evidence."
    );
  }

  return instructions;
}

export function buildHermesStagingLogin(config) {
  const urls = buildStagingUrls(config);
  return {
    email: config.email,
    password: config.password,
    loginUrl: urls.loginUrl,
    dashboardUrl: urls.dashboardUrl,
    expectedPlan: config.expectedPlan || null,
    expectedSubscriptionStatus: config.expectedSubscriptionStatus || null,
    accountNotes: config.accountNotes || null,
    usage:
      "Use only for staging authentication context or diagnosing login failures. Do not mutate subscription or billing state.",
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
  target confirmation, and inferred dashboard scenario before assertions.

Examples:
  STAGING_QA_EMAIL='qa@example.com' STAGING_QA_PASSWORD='secret!' node scripts/run-staging-page-ai-qa.mjs --page=dashboard
  node scripts/run-staging-page-ai-qa.mjs --page=dashboard --email='qa@example.com' --password='secret!'
  node scripts/run-hermes-page-judge.mjs --page=dashboard --email='qa@example.com' --password='secret!'
`);
}

export {
  DEFAULT_BASE_URL,
  DEFAULT_DASHBOARD_PATH,
  DEFAULT_LOGIN_PATH,
  envKeyForFlag,
};
