# Give the judge a signed-in session

`judge` has to see the page the way a signed-in user does. This page is for the
operator setting that up for the first time on an app that requires login. When
you finish, a judge run reaches the target page authenticated, and `doctor`
confirms it before you spend an agent run finding out.

There are three paths. Which one you need is decided by how your app signs
people in, not by preference. None of the three puts a credential in the agent
prompt, in `argv`, or in an artifact. The legacy flow that does
(`--credentials-in-prompt`) still exists and prints a `[security]` warning every
time it runs.

## Choose a path

| Your app                                                                               | Path                        | Entry point                   |
| -------------------------------------------------------------------------------------- | --------------------------- | ----------------------------- |
| Has a login form a human can complete (password, SSO, CAPTCHA, MFA)                      | Operator login              | `login`                       |
| Mints its session in code — no form to drive; the e2e setup writes a `storageState`      | Seeded storage state        | `staging.storageState`        |
| Uses a provider that refuses automation-controlled browsers (Google, most SSO portals)   | Attach to a browser you run | `judge --cdp-url=<url>`       |
| Needs no login for the page under test                                                   | None                        | `staging.authRequired: false` |

When more than one is available, attaching wins: `--cdp-url` (or
`QA_BROWSER_CDP_URL`) outranks both the stored `login` profile and a configured
`storageState`, because it is the only path an identity provider that blocks
automated browsers leaves open. `judge` reads the flag first and the environment
variable second.

Only two of the three run unattended. See [Run in CI](./ci.md#choose-a-session-path-that-works-unattended).

## Path 1: sign in by hand with `login`

Use this when a human can complete your login form and will be at the keyboard
once.

This path needs the optional peer `@playwright/test`:

```bash
npm i -D @playwright/test && npx playwright install chromium
```

1. Open the headed browser:

   ```bash
   npx playwright-spec-for-ai-agent login --page=pricing
   ```

   The window opens on `staging.baseUrl` + `staging.loginPath` (per page when
   `--page` is given), in a persistent profile at `.private/qa-browser-profile`
   created owner-only (`0700`). `.private/` is gitignored.

2. Sign in however the app wants, then close the window. This tool types
   nothing and stores no credential — the session lives in the browser profile.

3. Add `--channel=chrome` (or `--channel=msedge`) if the provider rejects the
   sign-in:

   ```bash
   npx playwright-spec-for-ai-agent login --channel=chrome
   ```

   That launches real Chrome or Edge instead of the bundled Chromium build,
   which is the build identity providers refuse most often.

### Confirm the session took

The cookie jar is compared before and after. A window closed without signing in
is reported, not silently accepted:

```
No session was stored: the browser window closed without any new session cookie.
```

Success writes `.private/qa-browser-profile/.qa-session`. That marker — not the
directory — is what later runs read, because Chromium creates the directory the
moment the window opens. `doctor` reads the same marker:

```
$ npx playwright-spec-for-ai-agent doctor
PASS  session profile   pre-authenticated browser session present
```

On the next `judge`, the profile is relaunched headless with a loopback CDP
endpoint, and the agent is handed only that URL.

## Path 2: replay a `storageState` your repo already has

Use this when your e2e suite mints its session in code (a signed cookie, a magic
token, a service account) and there is no form for `login` to drive. Those
suites usually already write a Playwright `storageState` JSON.

1. Point the config at that file:

   ```js
   // playwright-spec-for-ai-agent.config.mjs
   export default defineConfig({
     staging: {
       storageState: "playwright/.auth/user.json", // resolved from the project root
     },
     pages: {
       billing: { storageState: "playwright/.auth/admin.json" }, // per-page override
     },
   });
   ```

   A per-page `storageState` wins over the `staging` one.

2. Generate the file before judging, in the same job:

   ```bash
   npx playwright test --project=setup
   npx playwright-spec-for-ai-agent judge --page=billing
   ```

Cookies whose domain covers the target host are replayed, together with the
`localStorage` entries recorded for exactly that origin. A configured storage
state *is* the session, so `judge` stops asking for `STAGING_QA_EMAIL` /
`STAGING_QA_PASSWORD` for that page.

How the state is seeded depends on the adapter's `auth` capability, and that
decides whether httpOnly cookies survive:

| Adapter `auth`                        | Seeded into                             | httpOnly cookies |
| ------------------------------------- | --------------------------------------- | ---------------- |
| `cdp-attach` (`hermes`)               | the runner's own profile, over CDP      | work             |
| `self-prelogin` (`aside`)             | Aside's browser, via `aside repl`       | rejected         |

On a `self-prelogin` adapter the seeding goes through `document.cookie`, which
cannot set an httpOnly cookie. Rather than judge the page as an anonymous
visitor, the run stops and names them:

```
2 session cookie(s) are httpOnly and cannot be seeded via aside repl: sid, csrf
```

If you hit that, judge the page on a `cdp-attach` adapter or use path 3. See
[Adapters](../reference/adapters.md) for which adapter declares what.

A `storageState` path that does not exist, does not parse, or holds neither
cookies nor origins fails as a usage error before the agent is called.

### Confirm the session took

When every page that requires login has a storage state, `doctor` stops asking
for credentials:

```
$ npx playwright-spec-for-ai-agent doctor
PASS  credentials   storage state configured for: billing — no credentials needed
```

The judge run itself prints the seed line before the agent starts:

```
Session seeded from playwright/.auth/admin.json (4 cookie(s)).
```

## Path 3: attach to a browser you already run

Use this when the identity provider refuses every automation-launched browser.
The answer is not better automation: a human signs in as a human, and the tool
borrows the session.

1. Print the recipe:

   ```bash
   npx playwright-spec-for-ai-agent login --attach --base-url=https://staging.acme.internal
   ```

   ```
   Attach to a browser you control instead of one this tool launches:

     1. "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
          --remote-debugging-port=9222 \
          --user-data-dir=/tmp/qa-chrome

     2. Sign in normally in that window and open https://staging.acme.internal/login.

     3. npx playwright-spec-for-ai-agent judge --page=<page> --cdp-url=http://127.0.0.1:9222

   A dedicated --user-data-dir keeps your everyday Chrome profile — and every
   session in it — out of reach of the agent. Do not point this at your main
   profile: the agent would inherit every site you are signed into.
   ```

   The command prints and exits; it opens nothing. On Linux the first line is
   `google-chrome` instead of the macOS app path, with the same flags.

2. Start that browser with the dedicated `--user-data-dir` and sign in.

3. Judge through it:

   ```bash
   npx playwright-spec-for-ai-agent judge --page=dashboard --cdp-url=http://127.0.0.1:9222
   ```

   `QA_BROWSER_CDP_URL` is the environment equivalent; the flag wins over it.

The flag only applies to adapters whose capability is `auth: "cdp-attach"`
(`hermes`, or `exec` with `QA_AGENT_AUTH=cdp-attach`). Other adapters never read
`BROWSER_CDP_URL`, so passing it changes nothing.

**Never point this at your everyday Chrome profile.** Attaching hands the agent
every session in that profile. The throwaway `--user-data-dir` in the recipe is
the security boundary, not a formality.

### Confirm the session took

```
$ QA_BROWSER_CDP_URL=http://127.0.0.1:9222 npx playwright-spec-for-ai-agent doctor
SKIP  credentials   QA_BROWSER_CDP_URL=http://127.0.0.1:9222 — judge attaches to your browser, no credentials needed
```

If nothing is listening, the run stops with the command to start it:

```
Could not attach to a browser at http://127.0.0.1:9222: ...
```

## What each path costs

Evidence is captured by the runner from the browser context it owns, so what it
can capture depends on how that context came to exist.

| Capture                                   | `login` profile | Attached browser | Adapter's own browser |
| ----------------------------------------- | --------------- | ---------------- | --------------------- |
| Trace                                     | yes             | yes              | no                    |
| Screenshots + aria snapshots              | yes             | yes              | no                    |
| HAR                                       | yes             | no               | no                    |
| Video (`QA_RECORD_VIDEO`)                 | yes             | no               | no                    |
| Origin pinning / read-only mutation guard | yes             | no               | no                    |

- **HAR is a launch-time option.** An attached context already exists, so it
  cannot be recorded. The run does not pretend otherwise: it records a
  `capture-unavailable` violation reading `HAR is not recorded for an attached
  browser (launch-time option).`
- **Origin pinning and the read-only mutation guard travel with the HAR.** A
  blocking adapter gets them from post-run HAR inspection, and an attached
  browser has no HAR — so on this path neither is enforced. Judge a read-only
  plan, or accept that a stray navigation or non-GET request will not be caught.
- **`close()` disconnects; it never closes your browser.** The tool did not
  launch it, so it is not the tool's to close. The window stays as you left it.
- **The CDP endpoint is unauthenticated** for as long as the run lasts, on both
  the `login` and the attach path. Chromium offers no CDP auth; the mitigations
  are the loopback bind and the endpoint's lifetime.

## Undo a path

- **`login`**: delete `.private/qa-browser-profile`. `doctor` drops back to
  `SKIP session profile`, and the next `judge` falls through to whatever path
  remains.
- **`storageState`**: remove the key from the config (or the per-page override).
  `judge` starts requiring `STAGING_QA_EMAIL` / `STAGING_QA_PASSWORD` again for
  that page.
- **Attach**: drop `--cdp-url` and unset `QA_BROWSER_CDP_URL`, then close the
  browser you started. Nothing persists on this path.

## What this tool never does

- It does not automate a real Google or SSO sign-in. There is no credential
  typing, no consent-screen clicking, and no bot-detection workaround in any of
  these paths — a provider that blocks automated browsers is meant to be
  answered by a human, which is what `--cdp-url` is for.
- It does not want your everyday browser profile. Every path here is a private
  profile, a file your repo already has, or a throwaway `--user-data-dir`.
- It never asks the model for a credential. What reaches the agent is a CDP URL,
  or nothing at all.

## Related

- [Configuration](../reference/configuration.md) — the `staging` keys and the environment variables named here.
- [Adapters](../reference/adapters.md) — which adapter declares which `auth` capability.
- [Run in CI](./ci.md) — the two paths that work unattended.
- [Troubleshooting](../troubleshooting.md) — the errors these paths print.
