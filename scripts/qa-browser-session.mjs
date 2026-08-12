/**
 * Pre-authenticated QA browser session.
 *
 * The operator logs in once (`login` command, headed browser) into a private
 * persistent profile. `judge` relaunches that profile headless with a CDP
 * endpoint and hands `BROWSER_CDP_URL` to Hermes, so the agent browses an
 * already-authenticated browser and credentials never enter the prompt,
 * model context, or artifacts.
 */
import { existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

export const SESSION_PROFILE_DIR = join(".private", "qa-browser-profile");

export function sessionProfilePath(root = process.cwd()) {
  return resolve(root, SESSION_PROFILE_DIR);
}

export function hasSessionProfile(root = process.cwd()) {
  return existsSync(sessionProfilePath(root));
}

export function ensurePrivateProfileDir(root = process.cwd()) {
  const path = sessionProfilePath(root);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(resolve(root, ".private"), 0o700);
  chmodSync(path, 0o700);
  return path;
}

export function assertPrivateProfileDir(root = process.cwd()) {
  const path = sessionProfilePath(root);
  const stat = statSync(path);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `QA browser profile must be owner-only. Run: chmod -R go-rwx ${SESSION_PROFILE_DIR}`
    );
  }
  return path;
}

export async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function importChromium() {
  try {
    const mod = await import("@playwright/test");
    return mod.chromium;
  } catch {
    throw new Error(
      [
        "The pre-authenticated session flow needs the optional peer dependency @playwright/test.",
        "Install it (npm i -D @playwright/test && npx playwright install chromium)",
        "or pass --credentials-in-prompt to use the legacy prompt-credential flow.",
      ].join("\n")
    );
  }
}

/**
 * Relaunch the operator-authenticated profile headless with a CDP endpoint.
 * Returns `{ cdpUrl, close }`; keep it open for the whole Hermes run.
 */
export async function launchAuthenticatedBrowser({ root = process.cwd() } = {}) {
  const profileDir = assertPrivateProfileDir(root);
  const chromium = await importChromium();
  const port = await findFreePort();
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    args: [`--remote-debugging-port=${port}`],
  });
  return {
    cdpUrl: `http://127.0.0.1:${port}`,
    async close() {
      await context.close();
    },
  };
}

/**
 * Headed login for the operator: opens the login URL in the persistent
 * profile and resolves when the operator closes the browser window.
 * No selectors, no stored credentials — SSO/CAPTCHA flows work unchanged.
 */
export async function runOperatorLogin({ loginUrl, root = process.cwd() }) {
  const profileDir = ensurePrivateProfileDir(root);
  const chromium = await importChromium();
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(loginUrl);
  await new Promise(resolveClosed => context.once("close", resolveClosed));
}
