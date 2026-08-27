import { spawnSync } from "node:child_process";
import { REQUIRED_ASIDE_BIN } from "./aside-runner.mjs";

const PRELOGIN_OK_MARKER = "ASIDE_PRELOGIN_OK";
const PRELOGIN_TIMEOUT_MS = 90 * 1000;

/**
 * Login script piped to `aside repl` over stdin, so credentials never touch
 * argv (visible in `ps`) or the agent prompt. The repl exposes a
 * Playwright-like page API (goto/fill/click/waitForURL) against Aside Browser;
 * the browser profile is persistent, so the authenticated session survives for
 * the following `aside exec` judge run.
 */
export function buildAsidePreloginScript({ loginUrl, email, password }) {
  // Single line: the repl evaluates piped stdin line by line, so a multi-line
  // script would only run its first statement.
  return [
    `const p = await openTab(${JSON.stringify(loginUrl)});`,
    `await p.waitForLoadState();`,
    `await p.fill('input[type="email"]', ${JSON.stringify(email)});`,
    `await p.fill('input[type="password"]', ${JSON.stringify(password)});`,
    `await p.click('button[type="submit"]');`,
    // Success = the login form is gone. Not URL-based: this app can swap to the
    // authenticated screen without changing the address bar. Wrong credentials
    // keep the form visible and fail here instead of burning a judge session.
    `let loggedIn = false;`,
    `for (let i = 0; i < 30; i += 1) { const gone = await p.evaluate(() => !document.querySelector('input[type="password"]')); if (gone) { loggedIn = true; break; } await new Promise(r => setTimeout(r, 1000)); }`,
    `if (!loggedIn) { throw new Error("login form still visible"); }`,
    `console.log(${JSON.stringify(PRELOGIN_OK_MARKER)} + ":" + p.url());`,
    `await p.close();`,
    // Trailing newline: the repl only evaluates newline-terminated lines.
  ].join(" ")
    .concat("\n");
}

export function preloginAside({ loginUrl, email, password }) {
  if (!loginUrl || !email || !password) {
    throw new Error(
      "Aside prelogin needs loginUrl, email, and password (STAGING_QA_EMAIL / STAGING_QA_PASSWORD)."
    );
  }

  const result = spawnSync(REQUIRED_ASIDE_BIN, ["repl"], {
    shell: false,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    input: buildAsidePreloginScript({ loginUrl, email, password }),
    timeout: PRELOGIN_TIMEOUT_MS,
  });

  if (result.error) throw result.error;

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!output.includes(PRELOGIN_OK_MARKER)) {
    // Never echo the repl transcript — it can contain the typed password.
    throw new Error(
      "Aside prelogin failed: the browser never left the login page. Check staging credentials and login form selectors."
    );
  }
}
