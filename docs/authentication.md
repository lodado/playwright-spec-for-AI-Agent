# Authentication

`judge` has to see the page the way a signed-in user does. There are three ways
to give it a session, and which one you need is decided by how your app signs
people in — not by preference.

None of the three puts a credential in the agent prompt, in `argv`, or in an
artifact. The legacy flow that does (`--credentials-in-prompt`) still exists and
warns every time it runs.

## Which path do I need?

| Your app                                                                    | Path                             | Entry point                    |
| --------------------------------------------------------------------------- | -------------------------------- | ------------------------------ |
| Has a login form a human can complete (password, SSO, CAPTCHA, MFA)           | Operator login                   | `login`                        |
| Mints its session in code — no form to drive; the e2e setup writes a `storageState` | Seeded storage state       | `staging.storageState`         |
| Uses a provider that refuses automation-controlled browsers (Google, most SSO portals) | Attach to a browser you run | `judge --cdp-url=<url>`      |
| Needs no login for the page under test                                        | None                             | `staging.authRequired: false`  |

When more than one is available, attaching wins: a `--cdp-url` (or
`QA_BROWSER_CDP_URL`) outranks the stored `login` profile, because it is the only
path an identity provider that blocks automated browsers leaves open.

## 1. `login` — sign in by hand, once

```bash
npx playwright-spec-for-ai-agent login --page=pricing
npx playwright-spec-for-ai-agent login --channel=chrome
```

A headed browser opens on `staging.baseUrl` + `staging.loginPath` (per page when
`--page` is given) in a persistent profile at `.private/qa-browser-profile`,
created owner-only (`0700`); `.private/` is gitignored. Sign in however the app
wants, then close the window. Nothing is typed by this tool and no credential is
stored by it — the session lives in the browser profile.

`--channel=<name>` launches real Chrome (`chrome`) or Edge (`msedge`) instead of
the bundled Chromium build. Some identity providers refuse to sign in from a
browser they do not recognise, and the bundled build is the one they refuse most.

The cookie jar is compared before and after. A window closed without signing in
is reported, not silently accepted:

```
No session was stored: the browser window closed without any new session cookie.
```

Success writes `.private/qa-browser-profile/.qa-session`. That marker — not the
directory — is what later runs read, because Chromium creates the directory the
moment the window opens.

`judge` then relaunches the profile headless with a loopback CDP endpoint and
hands the agent only that URL. This path needs the optional peer
`@playwright/test` (`npm i -D @playwright/test && npx playwright install chromium`).

## 2. `staging.storageState` — replay a session your repo already has

Apps whose e2e suite mints its session in code (a signed cookie, a magic token, a
service account) have no login form for `login` to drive. They do usually have a
Playwright `storageState` JSON that the auth-setup project writes. Point the tool
at that file:

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

Cookies whose domain covers the target host are replayed, together with the
`localStorage` entries recorded for exactly that origin. A configured storage
state *is* the session, so `judge` stops asking for `STAGING_QA_EMAIL` /
`STAGING_QA_PASSWORD` for that page.

Which adapter you run matters. The replay is implemented for adapters that drive
their own browser (capability `auth: "self-prelogin"` — the bundled `aside`
adapter), where `judge` seeds the state through `aside repl` before the run:

```bash
QA_AI_ADAPTER=aside npx playwright-spec-for-ai-agent judge --page=billing
```

With a `cdp-attach` adapter — the default `hermes` — a configured `storageState`
suppresses the credential requirement, but no built-in path seeds the file into
the runner-owned profile: that run still uses whatever `login` stored. If your
session cookies are httpOnly, or you are on `hermes`, use `login` or the attach
path below instead.

### httpOnly cookies

The seeding path sets cookies through `document.cookie`, which cannot set an
httpOnly cookie. Rather than judge the page as an anonymous visitor, the run
stops and names them:

```
2 session cookie(s) are httpOnly and cannot be seeded via aside repl: sid, csrf
```

## 3. `--cdp-url` — attach to a browser you already run

For a provider that refuses every automation-launched browser, the answer is not
a better automation: the human logs in as a human, and the tool borrows the
session. `login --attach` prints the recipe and exits without opening anything:

```
$ npx playwright-spec-for-ai-agent login --attach --base-url=https://staging.acme.internal
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

On Linux the first line is `google-chrome` instead of the macOS app path; the
flags are the same. `QA_BROWSER_CDP_URL` is the environment equivalent of
`--cdp-url`, and the flag wins over it.

The flag only applies to adapters whose capability is `auth: "cdp-attach"`
(`hermes`, or `exec` with `QA_AGENT_AUTH=cdp-attach`). Other adapters never read
`BROWSER_CDP_URL`, so passing it changes nothing — see
[adapters.md](./adapters.md).

If nothing is listening, the run stops with the command to start it:

```
Could not attach to a browser at http://127.0.0.1:9222: ...
```

## What you give up

Evidence is captured by the runner from the browser context it owns, so what it
can capture depends on how that context came to exist.

| Capture                | `login` profile | Attached browser | Adapter's own browser |
| ---------------------- | --------------- | ---------------- | --------------------- |
| Trace                  | yes             | yes              | no                    |
| Screenshots + aria     | yes             | yes              | no                    |
| HAR                    | yes             | no               | no                    |
| Video (`QA_RECORD_VIDEO`) | yes          | no               | no                    |
| Origin pinning / read-only mutation guard | yes | no          | no                    |

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
- **A dedicated `--user-data-dir` is not cosmetic.** Attaching hands the agent
  every session in that profile, so pointing it at your everyday Chrome would put
  every site you are signed into inside the agent's reach. Use the throwaway
  profile from the recipe.
- **The CDP endpoint is unauthenticated** for as long as the run lasts, on both
  the `login` and attach paths. Chromium offers no CDP auth; the mitigations are
  the loopback bind and the endpoint's lifetime.

## What this tool never does

- It does not automate a real Google or SSO sign-in. There is no credential
  typing, no consent-screen clicking, no bot-detection workaround anywhere in
  these paths — a provider that blocks automated browsers is meant to be answered
  by a human, which is what `--cdp-url` is for.
- It does not want your everyday browser profile. Every path here is a private
  profile, a file your repo already has, or a throwaway `--user-data-dir`.
- It never asks the model for a credential. What reaches the agent is a CDP URL,
  or nothing at all.

Related: [configuration.md](./configuration.md) for the config keys and
environment variables, [adapters.md](./adapters.md) for adapter capabilities,
[troubleshooting.md](./troubleshooting.md) for the errors these paths print.
