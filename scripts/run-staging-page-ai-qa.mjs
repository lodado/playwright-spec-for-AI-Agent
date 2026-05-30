#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  buildPersistedAccountContext,
  buildStagingUrls,
  redactEmail,
} from "./staging-qa-config.mjs";
import {
  artifactPaths,
  ensureProjectConfig,
  pageSupportsPlaywrightRun,
  parsePageArg,
  parseTargetPathArg,
} from "./page-qa-paths.mjs";
import {
  inspectScenarioFromPage,
  loadPageQaSpec,
  runDashboardSpecAssertions,
} from "./run-dashboard-spec-assertions.mjs";
import {
  promptScenarioConfirmation,
  resolveStagingQaConfig,
  shouldPromptInteractively,
} from "./staging-qa-prompt.mjs";

const READ_ONLY_POLICY = {
  summary:
    "Playwright only performs login navigation and read-only dashboard assertions. No subscription cancel/resume/payment clicks, no dialog confirmations, and no form mutations beyond login credentials.",
  blockedActions: [
    "click subscription-cancel-link",
    "click subscription-resume-link",
    "confirm destructive dialogs",
    "submit billing or subscription mutation forms",
  ],
};

function createCheck(name, status, details = "") {
  return {
    name,
    status,
    details,
  };
}

function createStep(steps, step) {
  steps.push({
    order: steps.length + 1,
    timestamp: new Date().toISOString(),
    ...step,
  });
}

function truncateText(value, maxLength = 160) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function isLoginPostResponse(response) {
  return (
    response.url().includes("/api/v1/auth/login") &&
    response.request().method() === "POST"
  );
}

function urlLeakedCredentials(url) {
  return /[?&](email|password)=/i.test(url);
}

async function login(browserPage, config, steps) {
  const { loginUrl } = buildStagingUrls(config);
  createStep(steps, {
    phase: "login",
    action: "goto",
    target: loginUrl,
    expected: "login page loads and client bundle hydrates",
    outcome: "info",
    details: 'waitUntil: "networkidle"',
  });
  await browserPage.goto(loginUrl, { waitUntil: "networkidle" });

  const emailInput = browserPage.locator('input[name="email"]').first();
  const passwordInput = browserPage.locator('input[name="password"]').first();
  const submitButton = browserPage
    .locator('form button[type="submit"]')
    .first();

  await emailInput.waitFor({ state: "visible", timeout: 20_000 });
  await submitButton.waitFor({ state: "visible", timeout: 20_000 });
  await browserPage
    .waitForFunction(
      () => {
        const form = document.querySelector("form");
        return Boolean(form && form.querySelector('button[type="submit"]'));
      },
      { timeout: 20_000 }
    )
    .catch(() => undefined);

  createStep(steps, {
    phase: "login",
    action: "fill",
    target: 'input[name="email"]',
    expected: "email field receives QA account email",
    outcome: "info",
    details: `email=${redactEmail(config.email)}`,
    url: browserPage.url(),
  });
  await emailInput.fill(config.email);

  createStep(steps, {
    phase: "login",
    action: "fill",
    target: 'input[name="password"]',
    expected: "password field receives QA account password",
    outcome: "info",
    details: "password=[redacted]",
    url: browserPage.url(),
  });
  await passwordInput.fill(config.password);

  createStep(steps, {
    phase: "login",
    action: "submit",
    target: 'form button[type="submit"]',
    expected: "POST /api/v1/auth/login succeeds via React onSubmit",
    outcome: "info",
    details: "form.requestSubmit() with POST response wait",
    url: browserPage.url(),
  });

  const loginResponsePromise = browserPage.waitForResponse(
    isLoginPostResponse,
    {
      timeout: 30_000,
    }
  );

  await browserPage
    .locator("form")
    .evaluate(form => {
      if (!(form instanceof HTMLFormElement)) {
        throw new Error("Login form element not found");
      }
      form.requestSubmit();
    })
    .catch(async () => {
      await submitButton.click();
    });

  const loginResponse = await loginResponsePromise.catch(async error => {
    const currentUrl = browserPage.url();
    if (urlLeakedCredentials(currentUrl)) {
      throw new Error(
        "Login form submitted as native GET (React onSubmit did not run). Credentials appeared in the URL query string."
      );
    }
    throw error;
  });

  const loginStatus = loginResponse.status();
  if (loginStatus >= 400) {
    throw new Error(`POST /api/v1/auth/login failed with HTTP ${loginStatus}`);
  }

  createStep(steps, {
    phase: "login",
    action: "waitForResponse",
    target: "/api/v1/auth/login",
    expected: "auth login API returns success",
    outcome: "pass",
    details: `HTTP ${loginStatus}`,
    url: browserPage.url(),
  });

  await browserPage
    .waitForURL(url => !url.pathname.includes("/login"), { timeout: 20_000 })
    .catch(() => undefined);
  await browserPage.waitForLoadState("networkidle").catch(() => undefined);
  createStep(steps, {
    phase: "login",
    action: "waitForLoadState",
    target: "networkidle",
    expected: "post-login network settles",
    outcome: "info",
    details: "ignored if networkidle times out",
    url: browserPage.url(),
  });
}

async function main() {
  const argv = process.argv.slice(2);
  await ensureProjectConfig(argv);
  const qaPage = parsePageArg(argv);
  if (!pageSupportsPlaywrightRun(qaPage)) {
    throw new Error(
      `Playwright run is not supported for page "${qaPage}". Use qa:judge instead.`
    );
  }

  const targetPath = parseTargetPathArg(argv, qaPage);
  const config = await resolveStagingQaConfig(argv, {
    stepLabel: `${qaPage} Playwright run`,
    targetPath,
  });
  config.dashboardPath = targetPath;

  const paths = artifactPaths(qaPage);
  const OUTPUT_DIR = paths.outputDir;

  const { dashboardUrl } = buildStagingUrls(config);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const spec = loadPageQaSpec(OUTPUT_DIR, paths.slug, qaPage);

  const consoleErrors = [];
  const failedResponses = [];
  const checks = [];
  const steps = [];
  const browser = await chromium.launch({ headless: true });
  const browserPage = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  browserPage.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  browserPage.on("response", response => {
    const status = response.status();
    if (status >= 400) {
      failedResponses.push({
        status,
        url: response.url(),
      });
    }
  });

  let finalStatus = "pass";
  let currentUrl = "";
  let specRunMeta = null;

  try {
    await login(browserPage, config, steps);

    createStep(steps, {
      phase: "dashboard",
      action: "goto",
      target: dashboardUrl,
      expected: "authenticated dashboard page loads",
      outcome: "info",
      details: 'waitUntil: "networkidle"',
      url: browserPage.url(),
    });
    await browserPage.goto(dashboardUrl, { waitUntil: "networkidle" });
    currentUrl = browserPage.url();

    const authenticated =
      currentUrl.includes("/dashboard") && !currentUrl.includes("/login");
    checks.push(
      createCheck(
        "authenticated-dashboard-url",
        authenticated ? "pass" : "fail",
        currentUrl
      )
    );
    createStep(steps, {
      phase: "dashboard",
      action: "assertUrl",
      target: currentUrl,
      expected: "URL contains /dashboard and does not stay on /login",
      outcome: authenticated ? "pass" : "fail",
      details: currentUrl,
      url: currentUrl,
    });

    const inspection = await inspectScenarioFromPage(browserPage, config);
    let scenarioId = inspection.scenarioId;

    if (shouldPromptInteractively(argv) && !config.expectedSubscriptionStatus) {
      scenarioId = await promptScenarioConfirmation(inspection);
    }

    if (!scenarioId) {
      checks.push(
        createCheck(
          "scenario-inference",
          "manual_review",
          "Could not infer ACTIVE/INACTIVE/CANCEL_PENDING from dashboard UI. Pass --expected-subscription-status= to override."
        )
      );
      createStep(steps, {
        phase: "spec",
        action: "inferScenario",
        target: "subscription links + dashboard-subtitle",
        expected: "map live UI to one dashboard spec scenario",
        outcome: "manual_review",
        details: "no matching subscription action link or subtitle hint",
        url: browserPage.url(),
      });
    } else {
      createStep(steps, {
        phase: "spec",
        action: "inferScenario",
        target: "subscription links + dashboard-subtitle",
        expected: "map live UI to one dashboard spec scenario",
        outcome: "pass",
        details: `${scenarioId}${inspection.inferredFrom ? ` (${inspection.inferredFrom})` : ""}`,
        url: browserPage.url(),
      });

      specRunMeta = await runDashboardSpecAssertions({
        page: browserPage,
        spec,
        scenarioId,
        checks,
        steps,
        createCheck,
        createStep,
      });
    }

    const unexpectedConsoleErrors = consoleErrors.filter(
      message =>
        !/favicon|resizeobserver loop|hydration/i.test(message.toLowerCase())
    );
    const consoleCheckDetails = unexpectedConsoleErrors.length
      ? unexpectedConsoleErrors.slice(0, 5).join(" | ")
      : "none";
    checks.push(
      createCheck(
        "unexpected-console-errors",
        unexpectedConsoleErrors.length === 0 ? "pass" : "manual_review",
        consoleCheckDetails
      )
    );
    createStep(steps, {
      phase: "observe",
      action: "collectConsoleErrors",
      target: "page.on('console', type=error)",
      expected: "no unexpected console errors after login/dashboard load",
      outcome: unexpectedConsoleErrors.length === 0 ? "pass" : "manual_review",
      details: consoleCheckDetails,
      url: browserPage.url(),
    });

    const unexpectedFailedResponses = failedResponses.filter(
      response =>
        !/favicon|analytics|sentry|clarity|googletagmanager/i.test(response.url)
    );
    const httpCheckDetails = unexpectedFailedResponses.length
      ? unexpectedFailedResponses
          .slice(0, 5)
          .map(response => `${response.status} ${response.url}`)
          .join(" | ")
      : "none";
    checks.push(
      createCheck(
        "unexpected-http-failures",
        unexpectedFailedResponses.length === 0 ? "pass" : "manual_review",
        httpCheckDetails
      )
    );
    createStep(steps, {
      phase: "observe",
      action: "collectHttpFailures",
      target: "page.on('response', status>=400)",
      expected: "no unexpected HTTP failures during login/dashboard load",
      outcome:
        unexpectedFailedResponses.length === 0 ? "pass" : "manual_review",
      details: httpCheckDetails,
      url: browserPage.url(),
    });
  } catch (error) {
    finalStatus = "fail";
    const details = error.stack ?? error.message;
    checks.push(createCheck("runner-error", "fail", details));
    createStep(steps, {
      phase: "runner",
      action: "error",
      target: "run-staging-page-ai-qa",
      expected: "complete login and dashboard read-only checks",
      outcome: "fail",
      details,
      url: browserPage.url(),
    });
  } finally {
    const screenshotPath = paths.screenshot;
    createStep(steps, {
      phase: "artifact",
      action: "screenshot",
      target: screenshotPath,
      expected: "full-page dashboard evidence for Hermes judge",
      outcome: "info",
      details: "fullPage: true; captured even when earlier steps fail",
      url: browserPage.url(),
    });
    await browserPage
      .screenshot({ path: screenshotPath, fullPage: true })
      .catch(() => {});
    currentUrl = currentUrl || browserPage.url();
    await browser.close();

    if (checks.some(check => check.status === "fail")) finalStatus = "fail";
    else if (checks.some(check => check.status === "manual_review")) {
      finalStatus = "manual_review";
    }

    const result = {
      generatedAt: new Date().toISOString(),
      page: qaPage,
      targetPath,
      targetOrigin: config.baseUrl,
      dashboardPath: config.dashboardPath,
      loginPath: config.loginPath,
      viewport: { width: 1440, height: 1200 },
      accountContext: buildPersistedAccountContext(config),
      loginEmail: redactEmail(config.email),
      currentUrl,
      status: finalStatus,
      readOnlyPolicy: READ_ONLY_POLICY,
      specRun: specRunMeta,
      specGeneratedAt: spec.generatedAt,
      playwrightSteps: steps,
      checks,
      consoleErrors,
      failedResponses,
      artifacts: {
        screenshot: screenshotPath,
      },
    };

    writeFileSync(paths.runResult, `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(paths.runReport, renderMarkdownReport(result, qaPage));

    console.log(`${qaPage} QA status: ${finalStatus}`);
    if (finalStatus === "fail") process.exitCode = 1;
  }
}

function renderMarkdownReport(result, qaPage) {
  const lines = [
    `# ${qaPage} Staging QA Run`,
    "",
    `- Status: **${result.status}**`,
    `- Target: ${result.targetOrigin}${result.dashboardPath}`,
    `- Current URL: ${result.currentUrl}`,
    `- Login email: ${result.loginEmail}`,
    `- Expected plan: ${result.accountContext.expectedPlan ?? "unspecified"}`,
    `- Expected subscription status: ${result.accountContext.expectedSubscriptionStatus ?? "unspecified"}`,
    `- Spec generated at: ${result.specGeneratedAt ?? "unknown"}`,
    `- Inferred scenario: ${result.specRun?.scenarioId ?? "none"}`,
    `- Spec assertions executed: ${result.specRun?.executedCount ?? 0}`,
    `- Generated at: ${result.generatedAt}`,
    "",
    "## Read-only policy",
    "",
    result.readOnlyPolicy.summary,
    "",
    "Blocked actions:",
    ...result.readOnlyPolicy.blockedActions.map(item => `- ${item}`),
    "",
    "## Playwright steps",
    "",
    ...result.playwrightSteps.map(
      step =>
        `${step.order}. [${step.phase}] ${step.action} — ${step.outcome}\n   - target: ${step.target}\n   - expected: ${step.expected}\n   - details: ${step.details}${step.url ? `\n   - url: ${step.url}` : ""}`
    ),
    "",
    "## Checks",
    "",
    ...result.checks.map(
      check =>
        `- ${check.status.toUpperCase()} — ${check.name}: ${check.details}`
    ),
    "",
    "## Console errors",
    "",
    ...(result.consoleErrors.length
      ? result.consoleErrors.map(error => `- ${error}`)
      : ["- none"]),
    "",
    "## Failed network responses",
    "",
    ...(result.failedResponses.length
      ? result.failedResponses.map(item => `- ${item.status} ${item.url}`)
      : ["- none"]),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
