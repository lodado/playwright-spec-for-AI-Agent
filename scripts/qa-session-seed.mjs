/**
 * Seed a QA browser session from a Playwright `storageState` file.
 *
 * The `login` command assumes a human can log in through a form. Plenty of
 * projects never expose one: their e2e suite mints a session directly (a signed
 * cookie, a magic token, a service account) and stores it as a storageState
 * JSON. Those apps could not be judged live at all — every route redirected to
 * a login the agent had no way to complete.
 *
 * Reusing the file the repo already has keeps credentials out of this tool
 * entirely: nothing is typed, nothing is prompted, nothing is stored here.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { EnvironmentError, UsageError } from "./errors.mjs";
import { REQUIRED_ASIDE_BIN } from "./aside-runner.mjs";

const SEED_OK_MARKER = "QA_SESSION_SEED_OK";
const SEED_TIMEOUT_MS = 90 * 1000;

/**
 * @returns {{ cookies: Array<object>, origins: Array<{origin: string,
 *   localStorage: Array<{name: string, value: string}>}> }}
 */
export function readStorageState(path) {
  if (!existsSync(path)) {
    throw new UsageError(`Session storage state not found: ${path}`, {
      hint: "Point staging.storageState at a Playwright storageState file (the one your e2e setup writes), or remove the setting.",
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`Session storage state is not valid JSON: ${path}`, {
      cause: error,
    });
  }
  const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies : [];
  const origins = Array.isArray(parsed?.origins) ? parsed.origins : [];
  if (!cookies.length && !origins.length) {
    throw new UsageError(
      `Session storage state has no cookies and no origins: ${path}`,
      { hint: "Re-generate it, e.g. `npx playwright test --project=setup`." }
    );
  }
  return { cookies, origins };
}

/** Cookies whose domain matches the origin we are about to seed. */
export function cookiesForOrigin(cookies, origin) {
  const host = new URL(origin).hostname;
  return cookies.filter(cookie => {
    const domain = String(cookie?.domain ?? "").replace(/^\./, "");
    return !domain || host === domain || host.endsWith(`.${domain}`);
  });
}

/**
 * `document.cookie` cannot set an httpOnly cookie. Saying so up front beats a
 * judge run that silently browses as an anonymous visitor.
 */
export function assertSeedableCookies(cookies, { via }) {
  const blocked = cookies.filter(cookie => cookie?.httpOnly);
  if (!blocked.length) return;
  throw new EnvironmentError(
    `${blocked.length} session cookie(s) are httpOnly and cannot be seeded via ${via}: ${blocked
      .map(cookie => cookie.name)
      .join(", ")}`,
    {
      hint: "Use an adapter that attaches to the runner's own browser (auth=cdp-attach), which can set httpOnly cookies over CDP.",
    }
  );
}

export function buildLocalStorageEntries(origins, origin) {
  const target = origins.find(entry => entry?.origin === origin);
  return Array.isArray(target?.localStorage) ? target.localStorage : [];
}

/**
 * One line, like the prelogin script: `aside repl` evaluates piped stdin line
 * by line, so a multi-line program would run only its first statement.
 */
export function buildAsideSeedScript({ origin, cookies, localStorage: items }) {
  const cookiePairs = cookies.map(cookie => ({
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || "/",
  }));

  return [
    `const p = await openTab(${JSON.stringify(origin)});`,
    `await p.waitForLoadState();`,
    `await p.evaluate((seed) => {`,
    `  for (const c of seed.cookies) { document.cookie = c.name + "=" + c.value + "; path=" + c.path; }`,
    `  for (const item of seed.items) { localStorage.setItem(item.name, item.value); }`,
    `}, ${JSON.stringify({ cookies: cookiePairs, items })});`,
    `await p.reload();`,
    `await p.waitForLoadState();`,
    `console.log(${JSON.stringify(SEED_OK_MARKER)} + ":" + p.url());`,
    `await p.close();`,
  ].join(" ") + "\n";
}

/**
 * Seed the session into Aside Browser's own persistent profile, so the judge
 * run that follows reuses it — the same shape as the credential prelogin, minus
 * the credentials.
 */
export function seedAsideSession({ storageStatePath, origin }) {
  const state = readStorageState(storageStatePath);
  const cookies = cookiesForOrigin(state.cookies, origin);
  assertSeedableCookies(cookies, { via: "aside repl" });

  const script = buildAsideSeedScript({
    origin,
    cookies,
    localStorage: buildLocalStorageEntries(state.origins, origin),
  });

  const result = spawnSync(REQUIRED_ASIDE_BIN, ["repl"], {
    shell: false,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    input: script,
    timeout: SEED_TIMEOUT_MS,
  });

  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!output.includes(SEED_OK_MARKER)) {
    // The transcript can carry session tokens; report the failure, not the log.
    throw new EnvironmentError(
      `Seeding the Aside session from ${storageStatePath} failed: the seed script did not complete.`,
      { hint: "Check that the origin is reachable and the storage state is current." }
    );
  }
  return { cookies: cookies.length };
}

/**
 * Seed the runner-owned persistent profile (adapters with auth=cdp-attach).
 * Cookies go in over CDP, so httpOnly is fine here.
 */
export async function seedProfileSession({
  storageStatePath,
  origin,
  root = process.cwd(),
  chromiumFactory = null,
}) {
  const state = readStorageState(storageStatePath);
  const cookies = cookiesForOrigin(state.cookies, origin);
  const items = buildLocalStorageEntries(state.origins, origin);

  const { ensurePrivateProfileDir, writeSessionMarker, importChromium } =
    await import("./qa-browser-session.mjs");
  const profileDir = ensurePrivateProfileDir(root);
  const chromium = chromiumFactory
    ? await chromiumFactory()
    : await importChromium();

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
  });
  try {
    if (cookies.length) await context.addCookies(cookies);
    if (items.length) {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(origin);
      await page.evaluate(entries => {
        for (const item of entries) localStorage.setItem(item.name, item.value);
      }, items);
    }
    writeSessionMarker(root, { cookieCount: cookies.length });
  } finally {
    await context.close();
  }
  return { cookies: cookies.length, profileDir };
}
