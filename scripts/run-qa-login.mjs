#!/usr/bin/env node
/**
 * Operator login — opens a headed browser on the staging login page using the
 * private QA profile. Log in manually (any flow: password, SSO, CAPTCHA),
 * then close the browser window. `judge` reuses the authenticated profile
 * and never needs credentials in its prompt.
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent login [--base-url=... --login-path=/login]
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  applyStagingUrlDefaults,
  loadProjectConfig,
} from "./hermes-qa-project-config.mjs";
import { parseStagingQaArgs } from "./staging-qa-config.mjs";
import { SESSION_PROFILE_DIR } from "./qa-browser-session.mjs";

async function main() {
  const argv = process.argv.slice(2);
  await loadProjectConfig(argv);
  const config = parseStagingQaArgs(argv);
  applyStagingUrlDefaults(config, argv);
  const loginUrl = new URL(config.loginPath, config.baseUrl).toString();

  console.log(`Opening ${loginUrl}`);
  console.log(
    `Log in manually, then close the browser window. The session persists in ${SESSION_PROFILE_DIR} (owner-only).`
  );

  const { runOperatorLogin } = await import("./qa-browser-session.mjs");
  await runOperatorLogin({ loginUrl });
  console.log("Session saved. `judge` will now run with the pre-authenticated browser.");
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
