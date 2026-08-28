#!/usr/bin/env node
/**
 * Operator login — opens a headed browser on the staging login page using the
 * private QA profile. Log in manually (any flow: password, SSO, CAPTCHA),
 * then close the browser window. `judge` reuses the authenticated profile
 * and never needs credentials in its prompt.
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent login [--base-url=... --login-path=/login]
 *   npx playwright-spec-for-ai-agent login --channel=chrome
 *   npx playwright-spec-for-ai-agent login --attach   (print the attach recipe)
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  applyStagingUrlDefaults,
  loadProjectConfig,
} from "./hermes-qa-project-config.mjs";
import { parseStagingQaArgs } from "./staging-qa-config.mjs";
import { SESSION_PROFILE_DIR } from "./qa-browser-session.mjs";
import { EnvironmentError, EXIT_OK, runMain } from "./errors.mjs";

const HELP = `Usage: npx playwright-spec-for-ai-agent login [options]

  Open a headed browser on the login page, sign in by hand, and keep the
  session in a private profile that \`judge\` reuses.

Options:
  --channel=<name>     Launch real Chrome ("chrome", "msedge", ...) instead of
                       bundled Chromium. Providers that block automated
                       browsers are far likelier to accept it.
  --attach             Print how to attach to a browser you already run, and
                       exit. Use this when the provider refuses every
                       automation-launched browser (Google, most SSO portals).
  --base-url=<url>     Staging origin (or set it in config)
  --login-path=<path>  Login page path
  --config=<path>      Project config file
  --help, -h           Show this help
`;

/** Attaching beats logging in when the provider refuses automated browsers. */
export function attachRecipe(targetUrl = "") {
  const chrome =
    process.platform === "darwin"
      ? '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"'
      : "google-chrome";
  return [
    "Attach to a browser you control instead of one this tool launches:",
    "",
    `  1. ${chrome} \\`,
    "       --remote-debugging-port=9222 \\",
    "       --user-data-dir=/tmp/qa-chrome",
    "",
    `  2. Sign in normally in that window${targetUrl ? ` and open ${targetUrl}` : ""}.`,
    "",
    "  3. npx playwright-spec-for-ai-agent judge --page=<page> --cdp-url=http://127.0.0.1:9222",
    "",
    "A dedicated --user-data-dir keeps your everyday Chrome profile — and every",
    "session in it — out of reach of the agent. Do not point this at your main",
    "profile: the agent would inherit every site you are signed into.",
  ].join("\n");
}

export async function run(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return EXIT_OK;
  }

  await loadProjectConfig(argv);
  const config = parseStagingQaArgs(argv);
  applyStagingUrlDefaults(config, argv);
  const loginUrl = new URL(config.loginPath, config.baseUrl).toString();

  if (argv.includes("--attach")) {
    console.log(attachRecipe(loginUrl));
    return EXIT_OK;
  }

  const channel =
    argv
      .find(arg => arg.startsWith("--channel="))
      ?.slice("--channel=".length)
      .trim() || null;

  console.log(`Opening ${loginUrl}${channel ? ` in ${channel}` : ""}`);
  console.log(
    `Log in manually, then close the browser window. The session persists in ${SESSION_PROFILE_DIR} (owner-only).`
  );

  const { runOperatorLogin } = await import("./qa-browser-session.mjs");
  const { authenticated, cookieCount } = await runOperatorLogin({
    loginUrl,
    channel,
  });
  if (!authenticated) {
    // Announcing a saved session that does not exist is worse than failing:
    // every later judge run would browse staging logged out believing it is
    // signed in.
    throw new EnvironmentError(
      "No session was stored: the browser window closed without any new session cookie.",
      {
        hint: [
          `Run login again and complete the sign-in at ${loginUrl} before closing the window.`,
          "If the provider refused to sign in from this browser, run `login --attach`.",
        ].join("\n"),
      }
    );
  }
  console.log(
    `Session saved (${cookieCount} cookies). \`judge\` will now run with the pre-authenticated browser.`
  );
  return EXIT_OK;
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
  runMain(run);
}
