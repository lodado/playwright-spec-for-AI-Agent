# Run QA in Browserbase

Use Browserbase as the **browser provider**, independently of the AI adapter.
`QA_AI_ADAPTER` still chooses who reasons about the page. Browserbase allocates
Chromium, stores an optional login Context, and exposes the session over CDP.
The default provider remains `local`.

This path requires a Browserbase account and can incur session usage charges.
Browserbase must be able to reach your staging site. Its `localhost` is not your
machine. Private networks need an appropriate tunnel or network access setup.

## 1. Configure secrets privately

Create a gitignored file such as `.env.browserbase`, with owner-only permissions:

```dotenv
BROWSERBASE_API_KEY=your-key
BROWSERBASE_PROJECT_ID=your-project-id
QA_BROWSER_PROVIDER=browserbase
QA_BROWSERBASE_PROFILE=default
QA_BROWSERBASE_TIMEOUT_SECONDS=600
```

Use your secret manager or editor to populate it. Do not paste keys into a
prompt, command arguments, or a tracked config. Run `chmod 600 .env.browserbase`
on POSIX systems and ensure your consuming project's `.gitignore` excludes it
and `.private/`. The repository's `.env.*` and `.private/` rules already do.

The public CLI loads this file with `--env-file=.env.browserbase`. Directly
executing a script under `scripts/` does not perform the CLI's env-file loading.
An already exported environment variable wins over the file.

Install the optional `@playwright/test` peer for CDP and evidence capture. A
local Chromium download is not required for the Browserbase provider:

```bash
npm install -D @playwright/test
```

The provider uses Node's built-in `fetch`, not a new runtime SDK dependency.

## 2. Choose a CDP-capable agent

Supported: Hermes, or `exec` with `QA_AGENT_AUTH=cdp-attach` and a browser tool
that honors the supplied CDP endpoint. Existing `exec` Playwright MCP recipes
are in [Adapters](../reference/adapters.md#handing-the-cli-our-browser).

Aside, the fixture adapter, and a generic credentials-in-prompt CLI do not
attach to the allocated browser, so Browserbase judge rejects them before
allocating a session. Browserbase is not an LLM and does not replace the agent.

For example, add your existing exec settings to the private env file:

```dotenv
QA_AI_ADAPTER=exec
QA_AGENT_AUTH=cdp-attach
# Point QA_AGENT_CMD at your configured Claude/Codex CLI with Playwright MCP.
```

For remote runs, `BROWSER_CDP_URL` and `PLAYWRIGHT_MCP_CDP_ENDPOINT` both name
the allocated session in the agent worker, even if the latter previously pointed
elsewhere. The parent environment is unchanged. Do not hard-code a different
endpoint in MCP config.

The agent runs in an isolated worker so a synchronous CLI cannot freeze the
owning CDP connection while opening a new tab. Worker console output is suppressed
to avoid leaking connection secrets. Built-in adapters still write their normal
redacted raw-output artifacts. Local provider execution remains unchanged.

## 3. Log in once through Live View

Configure the staging base URL/login path in the existing project config, then:

```bash
npx playwright-spec-for-ai-agent login --page=dashboard \
  --browser-provider=browserbase --browserbase-profile=qa-user \
  --success-url=/dashboard --success-selector='[data-testid="account-menu"]' \
  --env-file=.env.browserbase
```

Use the actual URL and selector for your app. At least one of `--success-url`
or `--success-selector` is required. If both are supplied, **both must match**.
The URL must be on the login site's origin and must not include query parameters.
Matching ignores query parameters in the observed URL, but preserves its hash.
Choose a selector visible only after login, not a public header or login button.
URL-only confirmation is weaker on apps that show a login form without redirecting.

The command:

1. Creates or reuses a Context scoped to project ID, site origin, and profile.
2. Creates a session with `persist: true`.
3. Prints a **private Live View access link**. Open it and complete login, SSO,
   or MFA yourself. Do not share or upload that link.
4. Waits for the explicit success condition, rather than guessing from a cookie.
5. Disconnects, requests session release, waits for completion and Context saving.
6. Writes only Context metadata to `.private/qa-browserbase-contexts.json` (`0600`).

There is no password in the QA prompt. A failed first login does not write a
ready marker and attempts to delete the newly created Context. An existing
Context is never deleted automatically on a failed re-login.

`--browserbase-profile=admin` gives another account on the same site a separate
Context. Use the same profile for login, doctor, and judge. The local registry
prevents concurrent use of the same project/origin/profile on this machine.
It does not coordinate different CI machines. Avoid sharing a Context among
simultaneous remote jobs.

## 4. Check setup without creating a browser

```bash
npx playwright-spec-for-ai-agent doctor --page=dashboard \
  --browser-provider=browserbase --browserbase-profile=qa-user \
  --env-file=.env.browserbase

npx playwright-spec-for-ai-agent doctor --page=dashboard \
  --browser-provider=browserbase --browserbase-profile=qa-user \
  --check-network --env-file=.env.browserbase
```

The first command checks configuration, key presence, CDP capability and stored
Context metadata. `--check-network` also retrieves saved Contexts from Browserbase.
Neither allocates a browser or runs an LLM. Context existence is **not proof that
the site's login remains valid**. Without a stored Context, no API authentication
check is claimed. `judge` rechecks the saved success condition in the browser.

## 5. Judge using the same Context

```bash
npx playwright-spec-for-ai-agent judge --page=dashboard \
  --browser-provider=browserbase --browserbase-profile=qa-user \
  --env-file=.env.browserbase
```

The session is allocated before account-state detection, and both detection and
judgment use that same CDP context. The saved success URL/selector is checked
before spending a model call. Expiration or a redirect back to login stops the
run. The normal spec, plan, verdict, review, report and handoff contracts remain.
`nightly` accepts the same provider/profile/timeout flags.

Judge sessions use `persist: false`, so QA does not overwrite the saved Context.
**This does not prevent server mutations.** Logging out, submitting forms or
changing account data can still affect the real account and its session.

Existing `staging.storageState` is supported for cookies and localStorage and
wins over the stored Context. It seeds an ephemeral remote session and does not
save a Context. httpOnly cookies use the browser cookie API. IndexedDB injection
from a Playwright state file is not implemented by this path. Use Context login
when your app requires it. For a public page (`authRequired: false`), no saved
Context is needed.

## Evidence and safety limits

| Output/behavior | Browserbase path |
| --- | --- |
| Final screenshots, ARIA snapshots, Playwright trace | Captured through the attached context when available |
| Session reference | Safe session ID/dashboard link in judgment JSON and Markdown |
| Live View | Private link printed during operator login, not written into artifacts |
| Local runner HAR | Unavailable on an already-created remote context |
| `QA_RECORD_VIDEO` | Does not enable remote video downloads; no local video is claimed |
| Browserbase recording/debug data | Inspect in its dashboard, subject to account settings and retention; automatic export is not implemented |
| Origin/mutation enforcement | The existing local guards are unavailable on this remote path. Explicit evidence violations report the gap |
| API key / CDP connection URL | Redacted from adapter output and surfaced errors; never stored as provider metadata |
| Trace/screenshots/site state | Can contain sensitive application data. Treat them as private even though provider secrets are redacted from text |
| File upload/download | Not a separately managed remote transfer workflow in this first provider version |

Only grant staging/test-account access suitable for the agent's task. Use
server-side read-only roles where needed. Do not rely on a read-only prompt as a
security boundary. Missing evidence/guard coverage must not be interpreted as a
fully validated pass.

## Timeouts, cleanup and recovery

`--browserbase-timeout=<seconds>` (or `QA_BROWSERBASE_TIMEOUT_SECONDS`) accepts
60–21600, defaults to 600, and is subject to your Browserbase plan limits.
No paid-tier `keepAlive` option is requested. The provider requests release on
normal completion and failures after allocation. Signal cleanup is best-effort.
SIGKILL, host crashes, and an ambiguous failed allocation response cannot be
cleaned up reliably by a local process. The remote timeout bounds orphan lifetime.
Check the Browserbase dashboard if release fails.

A profile lock left after a crash is not stolen automatically. Verify that no
QA process uses the profile, then remove only its `.private/qa-browserbase-*.lock`
file. Do not delete another active process's lock or the entire private directory.

`--cdp-url`, `QA_BROWSER_CDP_URL`, and `--credentials-in-prompt` conflict with
Browserbase judge. `--attach` and `--channel` conflict with Browserbase login.
Select `--browser-provider=local` to keep using the existing local workflow.

## What the tests prove

| Requirement | Check | Boundary |
| --- | --- | --- |
| Provider flags, help, invalid inputs | `browserbase-cli.test.ts` invokes the public CLI in child processes | No cloud allocation |
| REST methods, statuses, validation, redaction | `browserbase-client.test.ts` | HTTP responses are mocked, not live API acceptance |
| Scoped Contexts, verified login, release, cancellation | `browser-provider.test.ts`, `browserbase-login-cli.test.ts` | Cloud/browser substitutes test failure paths |
| Non-allocating doctor and missing/expired Context handling | `browserbase-doctor.test.ts` | API and adapter boundaries are mocked |
| Judge routing, shared session, expired auth, safe artifacts | `browserbase-judge.test.ts` | Model and cloud session are mocked |
| Real CDP, shared httpOnly cookies, demo interactions, screenshots, ARIA, trace ZIP, disconnect | `browserbase-cdp.integration.test.ts` | Real installed Chromium and unchanged demo app; only cloud REST is substituted |
| Synchronous agent opens and navigates new tabs without freezing the owning CDP client | `browserbase-agent-cdp.integration.test.ts` | Real local Chromium and synchronous subprocess, not a live model/cloud session |
| Isolated adapter results, typed errors, secret handling and timeout | `browserbase-agent-runner.test.ts` | Local worker and controlled adapters |

Run `npm test` for the repository regression suite. The real-CDP test explicitly
skips if Chromium is not installed. A passing offline suite does not verify
Browserbase credentials, Live View access, Context persistence across real cloud
sessions, a site's SSO policy, private-network reachability, or model quality.
Validate those against an authorized staging account after configuring credentials.

Official references: [Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts),
[Create session](https://docs.browserbase.com/reference/api/create-a-session),
[Session live view](https://docs.browserbase.com/platform/browser/observability/session-live-view).
