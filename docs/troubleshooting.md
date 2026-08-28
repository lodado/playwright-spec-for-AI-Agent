# Troubleshooting

Every message below is the real wording the CLI prints. Start with
`npx playwright-spec-for-ai-agent doctor` — it checks config, specs, adapter,
credentials, targets, and stored artifacts in one table, and exits 3 when a
required check fails.

## Config

```
[qa-config] unknown config key "staging.baseURL" — did you mean "baseUrl"?
[qa-config] "staging.authRequired" must be a boolean, got string
[qa-config] "pages.billing.pageUrl" is not a valid URL: /settings/billing
```

Warnings by default. Add `--strict-config` (or `QA_STRICT_CONFIG=1`) and they
become a usage error (exit 2):

```
Invalid project config (2 problems):
  unknown config key "staging.baseURL" — did you mean "baseUrl"?
  ...

Fix the keys above, or drop --strict-config / QA_STRICT_CONFIG=1 to downgrade these to warnings.
```

Only these top-level keys are recognised: `root`, `paths`, `pages`,
`targetPaths`, `staging`, `fixtures`, `livePolicies`, `hooks`. Full key list in
[configuration.md](./configuration.md).

```
[qa-config] loadProjectConfig() called again with different flags — re-resolving project config. Load it once, in the entry script.
```

Only relevant if you are calling the modules directly.

## Placeholder base URL

```
Refusing to judge a placeholder target URL: https://your-staging-url.example.com/pricing

Set staging.baseUrl in playwright-spec-for-ai-agent.config.*, or STAGING_QA_BASE_URL.
```

`doctor` reports the same condition as `placeholder base URL: <url>` or
`no base URL resolved`, and the config layer warns
`"staging.baseUrl" is a placeholder (…) — set a real staging origin before judging`.

A hostname counts as a placeholder when it is empty, unparseable, `example`,
`example.com`, `example.org`, `example.net` **or any subdomain of those**, or
when it contains `your-`, `yourdomain`, `changeme`, or `todo`. The RFC 2606
domains are reserved: `staging.example.com` can never be a real staging origin,
so it is refused rather than judged and reported as unreachable.

`playwright-spec-for-ai-agent.config.example.mjs` uses `https://staging.example.com`
on purpose. A fresh copy of it therefore fails `doctor` until you set a real
`staging.baseUrl` (or `STAGING_QA_BASE_URL`) — that failure is the example config
doing its job, not a bug.

Origin pinning is also disabled while the base URL is a placeholder, since there
is no real origin to pin to.

## Missing target

```
Missing target for page "pricing".

Set pages.pricing.pageUrl, pages.pricing.targetPath, or targetPaths.pricing in playwright-spec-for-ai-agent.config.*, or pass --target-path=/pricing
```

## Missing agent CLI

`doctor`:

```
FAIL  adapter binary   hermes-agent not found on PATH or in ~/.hermes/hermes-agent
                        → Install hermes-agent, or run with QA_AI_ADAPTER=fixture for an offline dry run.
```

Mid-run, from the adapter itself:

```
Hermes command not found: hermes-agent. Partial output: …/dashboard-hermes-raw-output.txt
```

With `QA_AI_ADAPTER=exec`:

```
QA_AI_ADAPTER=exec needs QA_AGENT_CMD (the agent CLI to run).

Example: QA_AGENT_CMD="claude -p --output-format json" or QA_AGENT_CMD="codex exec --json". The prompt is piped on stdin.
```

Unknown adapter name:

```
Unknown QA_AI_ADAPTER: "hemres".

Built-in adapters: hermes, aside, exec, fixture. For a third-party backend, set QA_AI_ADAPTER to a module specifier — a path ("./qa-adapters/my-agent.mjs") or a package ("@acme/qa-adapter") — exporting `run(query, maxTurns, options)` and optionally `capabilities`, `prelogin`, and `resolveModel`.
```

Model not configured:

```
Hermes model is not configured. Set model.default in ~/.hermes/config.yaml or export HERMES_INFERENCE_MODEL.
```

Timeouts name the variable to raise:

```
Hermes timed out after 600000ms. Partial output: …-hermes-raw-output.txt

Raise HERMES_QA_TIMEOUT_MS if Hermes legitimately needs longer.
```

## Hermes is configured but refuses to start

A model can be configured while the key for the provider that serves it is not.
Hermes then prints its own diagnosis and exits 0, so the failure used to arrive
as `did not return valid JSON` (exit 4) and sent people hunting for a parser bug.
It is now an **environment** failure (exit 3) carrying Hermes's own words:

```
Hermes could not start: Provider 'openai' is set in config.yaml but no API key was found. See raw output: …-hermes-raw-output.txt

Fix the provider/model in ~/.hermes/config.yaml (or `hermes model`), then re-run. `doctor` checks this before a run.
```

A rejected key is reported separately:

```
Hermes API key was rejected or permission denied. See raw output: …-hermes-raw-output.txt
```

`doctor` catches the first case before an agent run is spent. It reads the
provider from `~/.hermes/config.yaml` and looks for `<PROVIDER>_API_KEY` in the
environment or in `~/.hermes/.env`:

```
FAIL  adapter provider   openai configured but OPENAI_API_KEY is unset — hermes-agent will refuse to start
                          → Export OPENAI_API_KEY, put it in ~/.hermes/.env, or switch provider with `hermes model`.
```

The check is skipped when there is no `~/.hermes/config.yaml`, or when the
provider is unset or `auto`.

## Stale plan

Between `abstract-ai` and `judge` (exit 2):

```
judge input is stale: it was generated from a different abstract-ai revision.
  expected sha256:…
  actual   sha256:…

Re-run: npx playwright-spec-for-ai-agent abstract-ai --page=dashboard
```

Between `judge` and `review` (exit 2):

```
review input is stale: it was generated from a different judge plan revision.
  expected sha256:…
  actual   sha256:…

Re-run `npx playwright-spec-for-ai-agent judge --page=dashboard` so the plan and the judgment come from one revision.
```

`show --page=<slug>` reports the same condition as a `stale` spec state when the
judgment's `specHash` no longer matches the spec on disk.

## Quarantined run

```
Refusing to run review: the last judge run for this page failed and its artifacts are quarantined.
Marker: src/page/dashboard/__QA__/dashboard-qa-run.invalid
Re-run `judge` for this page; a successful run clears the marker.
```

Two things quarantine a run: `judge` throwing after it may have written partial
artifacts, and a judgment whose run-level cause is `ENVIRONMENT_DEFECT` —

```
Environment defect: the product was never really tested. Not reporting this as a product failure.
```

which exits 3. `slack` on a quarantined page posts an `[ERRORED]` message rather
than staying silent, and exits 3. `doctor` reports
`run quarantined: <marker path>`. A successful `judge` deletes the marker.

The usual cause of that second case is a run that browsed staging logged out —
see [Every route redirects to login](#every-route-redirects-to-login-and-nothing-was-tested).

## Agent output that cannot be used

Exit 4:

```
Hermes did not return valid JSON (required: status). Raw output: …-hermes-raw-output.txt Preview: …

Inspect …-hermes-raw-output.txt to see what the agent actually printed.
```

```
Review echoed packetSha256 sha256:…, but the packet it was given hashes to sha256:….

The reviewer answered about a different document than the one this run pinned. Re-run `review`; if it recurs, inspect the review raw output next to the packet.
```

Malformed or future artifacts:

```
Malformed artifact …/dashboard-hermes-judgment.json: `status` must be a string
Artifact …/dashboard-qa-spec.json was written by a newer version (schemaVersion 2 > 1).
```

## Annotations

```
Missing // @qa-live-policy on test "shows the plan name" (billing.spec.ts:24).

Add it on the test or an enclosing test.describe, e.g. `// @qa-live-policy: readonly`.
```

```
Unknown @qa-live-policy: read-only. Use one of: readonly, safe-interaction, safe-interaction-no-confirm, mock-judgment, subscription-mutation, auth-mock, skip
```

If a file seems to be ignored entirely, check the whole-comment-line rule in
[annotations.md](./annotations.md): an annotation only counts when it is the
entire comment line. `doctor` reports what it found per page:

```
PASS  billing · spec dir   src/page/billing/__tests__ — 3 annotated, 1 @qa-live-skip, 2 runnable
FAIL  billing · spec dir   src/page/billing/__tests__ — no *.spec.ts carries // @qa-scenario
```

## Sessions and credentials

```
No session was stored: the browser window closed without any new session cookie.

Run login again and complete the sign-in at https://staging…/login before closing the window.
If the provider refused to sign in from this browser, run `login --attach`.
```

The login command only writes its session marker when the cookie jar actually
changed. Chromium creates the profile directory the moment the window opens, so
directory existence proves nothing — and a profile wrongly treated as
authenticated makes every later judge run browse staging logged out while
believing it is signed in.

```
QA browser profile must be owner-only.

Run: chmod -R go-rwx .private/qa-browser-profile
```

```
No QA browser profile at .private/qa-browser-profile.

Run: npx playwright-spec-for-ai-agent login
```

```
The pre-authenticated session flow needs the optional peer dependency @playwright/test.
Install it (npm i -D @playwright/test && npx playwright install chromium)
or pass --credentials-in-prompt to use the legacy prompt-credential flow.
```

Without a session, `judge` falls back to embedding credentials in the prompt and
says so:

```
[security] Credentials will be embedded in the Hermes prompt and its session logs. Prefer `npx playwright-spec-for-ai-agent login` to create a pre-authenticated session.
```

## Every route redirects to login, and nothing was tested

The symptom is a judgment where every check is `skip` or `fail` with the agent
saying it landed on the login page. The run-level cause comes out
`ENVIRONMENT_DEFECT`, which quarantines the run and exits 3:

```
Hermes dashboard QA judgment (browse): manual_review [ENVIRONMENT_DEFECT] — 0/12 planned checks addressed (run run-1a2b3c4d)
Environment defect: the product was never really tested. Not reporting this as a product failure.
```

The marker records why: `judge run run-1a2b3c4d: ENVIRONMENT_DEFECT — <first line
of the summary>`. `review` and `slack` then refuse to treat it as a verdict on
the app. This is the harness working; it means the agent browsed staging as an
anonymous visitor. There are three ways out, in order of how much the target app
lets you do:

1. **The page does not actually need a session** — set `staging.authRequired:
   false`, or `pages.<page>.authRequired: false`, or pass `--auth-required=false`.
   The default is `true`, so a public marketing page inherits a login it never
   needed.
2. **The app has no login form to drive** — its e2e suite mints the session in
   code. Point `staging.storageState` (or `pages.<page>.storageState`) at the
   Playwright storageState JSON that setup writes. For an adapter that logs
   itself in (`auth: "self-prelogin"`, the aside adapter today), the cookies and
   localStorage matching the target origin are replayed into that adapter's own
   browser profile before the run. No credential enters this tool: with a
   storage state configured, `judge` does not ask for `STAGING_QA_EMAIL` /
   `STAGING_QA_PASSWORD` at all.
3. **The identity provider refuses automation-controlled browsers** — Google and
   most SSO portals do. Sign in yourself in a browser you started, and let
   `judge` borrow that session with `--cdp-url=` (or `QA_BROWSER_CDP_URL`). See
   below.

### Attaching to a browser you already run

`login --attach` prints the recipe and exits without opening anything:

```
  1. "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
       --remote-debugging-port=9222 \
       --user-data-dir=/tmp/qa-chrome

  2. Sign in normally in that window and open https://staging…/login.

  3. npx playwright-spec-for-ai-agent judge --page=<page> --cdp-url=http://127.0.0.1:9222
```

The dedicated `--user-data-dir` is not decoration. **Attaching to your everyday
Chrome profile hands the agent every site you are signed into** — mail, cloud
console, bank — because it drives that browser's own contexts. Use a throwaway
profile directory.

`--cdp-url` outranks the private `login` profile when both exist, and applies to
adapters whose capability is `auth: "cdp-attach"`. If nothing is listening:

```
Could not attach to a browser at http://127.0.0.1:9222: connect ECONNREFUSED 127.0.0.1:9222

Start Chrome with a dedicated profile and remote debugging, sign in there, then re-run:
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9222 --user-data-dir=/tmp/qa-chrome
```

Evidence is narrower on an attached browser and the run says so rather than
implying otherwise — see [artifacts.md](./artifacts.md#runnerevidence). Closing
the session disconnects the client; it never closes your browser.

If the bundled Chromium is the only problem — the provider signs in fine in real
Chrome — `login --channel=chrome` (or `--channel=msedge`) launches that instead,
and the session still lands in the private profile.

### Seeding a session from a storageState file

```
Session storage state not found: /repo/playwright/.auth/user.json

Point staging.storageState at a Playwright storageState file (the one your e2e setup writes), or remove the setting.
```

```
Session storage state has no cookies and no origins: /repo/playwright/.auth/user.json

Re-generate it, e.g. `npx playwright test --project=setup`.
```

```
Seeding the Aside session from /repo/playwright/.auth/user.json failed: the seed script did not complete.

Check that the origin is reachable and the storage state is current.
```

The seed transcript is never printed: it can carry session tokens.

`doctor`'s `credentials` check does not know about `staging.storageState` yet:
with no session profile and no `STAGING_QA_EMAIL` / `STAGING_QA_PASSWORD` it
still reports `FAIL credentials` (and so exits 3) on a project whose runs are
covered by a storage state. `judge` itself does not ask for them.

### httpOnly cookies cannot be seeded through `document.cookie`

The self-prelogin path (the aside adapter) seeds the session by evaluating
`document.cookie` in the page, which by definition cannot set an httpOnly
cookie. Rather than judge as an anonymous visitor, the run stops and names the
cookies:

```
2 session cookie(s) are httpOnly and cannot be seeded via aside repl: session, csrf_token

Use an adapter that attaches to the runner's own browser (auth=cdp-attach), which can set httpOnly cookies over CDP.
```

In practice that means judging through an attached browser: sign in by hand and
pass `--cdp-url=`.

## Staging reachability

`judge` preflights the target with a plain fetch before spending an agent run:

```
Target https://staging…/pricing is unreachable: fetch failed

Check the staging deployment and STAGING_QA_BASE_URL before spending an agent run.
```

```
Target https://staging…/pricing returned HTTP 503 before the run started.

Staging is failing; judging it now would report an outage as a product defect.
```

Both exit 3. The preflight is unauthenticated, so it cannot tell a live session
from an expired one — `judge` says so, and the prompt instructs the agent to
stop with `manual_review` if the page looks logged out.

## Run ledger

```
FAIL  dashboard · run ledger   chain broken at entry 4: entry 4 (run-1a2b3c4d) content does not match its hash
                                → The ledger is append-only; a broken chain means it was edited or truncated. Archive it and start a new one.
```

## Slack

```
Missing SLACK_WEBHOOK_URL.

Export SLACK_WEBHOOK_URL=<Slack incoming webhook URL>, or pass --notify=never to skip reporting.
```

```
Unknown --notify=quiet.

Use one of: --notify=failures, --notify=always, --notify=never.
```

## Ack

```
"shows health scores" is not a check in the latest judgment.

Available items:
  - shows the user plan name in the header
  - shows health score on dashboard
```

```
Missing --reason=<text>.

An ack without a reason is indistinguishable from an ignored alert.
```

## Env file

The CLI loads `./.env.local` and then `./.env`, in that order:

```
[env] /repo/.env.local: 4 applied, 0 already set in the environment (kept)
[env] /repo/.env: 2 applied, 4 already set in the environment (kept)
--env-file not found: /repo/.env.staging
[env] skipped /repo/.env: node 20.9.0 cannot parse env files (needs >= 20.12)
```

Precedence is earliest-wins, and a real environment variable beats both files —
a CI secret is never overwritten by a checked-out file. `--env-file=<path>`
replaces both defaults and is required to exist. `QA_NO_ENV_FILE=1` disables
loading entirely.

**Credentials reported unset although they are in `.env.local`** was the older
behaviour: only `.env` was read, so a Next/Vite/CRA project — which keeps its
untracked secrets in `.env.local` — had `doctor` report
`STAGING_QA_EMAIL unset` with the value sitting in the repo. If you see that,
you are on a version before `.env.local` was added; export the variables or pass
`--env-file=.env.local` until you upgrade.

## Unknown command

```
Unknown command: judeg

Did you mean "judge"?
```
