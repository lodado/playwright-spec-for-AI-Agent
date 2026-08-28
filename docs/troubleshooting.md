# Troubleshooting

Find the message you saw, learn what it means, and fix it. Every message quoted
below is the wording the CLI prints; the surrounding prose is not.

## Start with `doctor`

```bash
npx playwright-spec-for-ai-agent doctor
```

`doctor` checks config, spec directories, the adapter and its binary and model,
credentials, targets, and stored artifacts in one table. It exits `3` when any
check fails, and answers most of the symptoms below before an agent run is
spent. Add `--json` for machine-readable output.

```
  PASS  adapter        hermes (auth=cdp-attach maxTurns=true video=true blocksEventLoop=true)
  FAIL  billing · target   placeholder base URL: https://staging.example.com
                           → Set staging.baseUrl (or pages.billing.baseUrl) to your real staging origin, or export STAGING_QA_BASE_URL.

  1 failed, 0 warning, 8 passed, 2 skipped.
```

## Symptom index

| What you see                                                    | Go to                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `review` or `slack` refuses to run                                | [The run is quarantined](#the-run-is-quarantined)                            |
| `judge input is stale` / `review input is stale`                  | [A stage refuses its input as stale](#a-stage-refuses-its-input-as-stale)    |
| Every check is `skip` and the agent says it saw a login page      | [Every route redirects to login](#every-route-redirects-to-login)            |
| `did not return valid JSON`                                       | [The agent output cannot be used](#the-agent-output-cannot-be-used)          |
| `Malformed artifact` / `written by a newer version`               | [An artifact is malformed](#an-artifact-is-malformed-or-from-a-newer-version)|
| `chain broken at entry N`                                         | [The run ledger chain is broken](#the-run-ledger-chain-is-broken)            |
| `No session was stored`                                           | [login stored no session](#login-stored-no-session)                          |
| `STAGING_QA_EMAIL unset` with the value in `.env.local`           | [Credentials read as unset](#credentials-read-as-unset-although-envlocal-has-them) |
| `Session storage state not found` and siblings                    | [The storage-state file is rejected](#the-storage-state-file-is-rejected)    |
| `session cookie(s) are httpOnly`                                  | [httpOnly session cookies cannot be seeded](#httponly-session-cookies-cannot-be-seeded) |
| `Could not attach to a browser at …`                              | [Attaching fails](#attaching-to-your-own-browser-fails)                      |
| `Refusing to judge a placeholder target URL`                      | [The target URL is a placeholder](#the-target-url-is-a-placeholder)          |
| `Missing target for page "…"`                                     | [The page has no target](#the-page-has-no-target)                            |
| `is unreachable` / `returned HTTP 5xx before the run started`     | [Staging is down](#staging-is-down)                                          |
| `unknown config key "…"`                                          | [A config key is rejected](#a-config-key-is-rejected)                        |
| `hermes-agent not found` / `needs QA_AGENT_CMD`                   | [The agent CLI is not found](#the-agent-cli-is-not-found)                    |
| `Unknown QA_AI_ADAPTER: "…"`                                      | [The adapter name is not recognised](#the-adapter-name-is-not-recognised)    |
| `Hermes could not start: …`                                       | [Hermes is configured but refuses to start](#hermes-is-configured-but-refuses-to-start) |
| `timed out after 600000ms`                                        | [The agent run times out](#the-agent-run-times-out)                          |
| `Missing // @qa-live-policy` / a spec file is ignored             | [A spec is ignored or rejected](#a-spec-is-ignored-or-rejected)              |
| `Missing SLACK_WEBHOOK_URL` / `Unknown --notify=…`                | [slack refuses to post](#slack-refuses-to-post)                              |
| `is not a check in the latest judgment` / `Missing --reason=`      | [ack refuses the item](#ack-refuses-the-item-or-the-reason)                  |
| `Unknown command: …`                                              | [The command name is wrong](#the-command-name-is-wrong)                      |

## Runs and verdicts

### The run is quarantined

```
Refusing to run review: the last judge run for this page failed and its artifacts are quarantined.
Marker: src/page/dashboard/__QA__/dashboard-qa-run.invalid
Re-run `judge` for this page; a successful run clears the marker.
```

**What it means.** Two things quarantine a run: `judge` throwing after it may
have written partial artifacts, and a judgment whose run-level cause is
`ENVIRONMENT_DEFECT`. Downstream commands refuse to report on artifacts that may
be half-written or that describe a run where the product was never reached.

**What to do.** Read the marker file — it records the reason and the timestamp —
then fix that cause and re-run `judge` for the page. A successful run deletes
the marker. When the reason names `ENVIRONMENT_DEFECT`, go to
[Every route redirects to login](#every-route-redirects-to-login) first.

**Confirm.** `doctor` stops reporting
`run quarantined: <marker path>`, and `review` runs.

Related behaviour: `slack` on a quarantined page posts
`[ERRORED] Nightly <page> QA: judge run quarantined` rather than staying silent,
and exits `3`.

### A stage refuses its input as stale

Between `abstract-ai` and `judge` (exit 2):

```
judge input is stale: it was generated from a different abstract-ai revision.
  expected sha256:…
  actual   sha256:…
```

Between `judge` and `review` (exit 2):

```
review input is stale: it was generated from a different judge plan revision.
  expected sha256:…
  actual   sha256:…
```

**What it means.** Each stage stamps the hash of what it consumed onto what it
produces, and the next stage re-checks it. The spec changed, or a stage was
skipped, so the downstream artifact describes a revision that no longer exists.

**What to do.** Re-run the stage the message names, then continue the pipeline
from there.

**Confirm.** `show --page=<slug>` reports the spec hash as `current` instead of
`STALE — judged sha256:…, spec on disk is sha256:…`.

### Every route redirects to login

The symptom is a judgment where every check is `skip` or `fail` and the agent
says it landed on the login page. The run-level cause comes out
`ENVIRONMENT_DEFECT`, which quarantines the run and exits `3`:

```
Hermes dashboard QA judgment (browse): manual_review [ENVIRONMENT_DEFECT] — 0/12 planned checks addressed (run run-1a2b3c4d)
Environment defect: the product was never really tested. Not reporting this as a product failure.
```

**What it means.** The agent browsed staging as an anonymous visitor. The
harness refuses to report that as a product failure, so `review` and `slack`
will not treat it as a verdict on the app.

**What to do.** Pick the path the target app allows:

1. **The page does not need a session.** Set `staging.authRequired: false`,
   `pages.<page>.authRequired: false`, or pass `--auth-required=false`. The
   default is `true`, so a public marketing page inherits a login it never
   needed.
2. **The app has no login form to drive** — its e2e suite mints the session in
   code. Point `staging.storageState` (or `pages.<page>.storageState`) at the
   Playwright storage-state JSON that setup writes. No credential enters this
   tool: with a storage state configured, `judge` does not ask for
   `STAGING_QA_EMAIL` or `STAGING_QA_PASSWORD` at all.
3. **The identity provider refuses automation-controlled browsers** — Google and
   most SSO portals do. Sign in yourself in a browser you started and let
   `judge` borrow the session with `--cdp-url=` or `QA_BROWSER_CDP_URL`. Run
   `login --attach` to print the recipe.

Full setup for all three is in
[Authenticate a judge run](./how-to/authentication.md).

**Confirm.** Re-run `judge`. The run-level cause is no longer
`ENVIRONMENT_DEFECT` and the marker file is gone.

### The agent output cannot be used

Exit 4:

```
Hermes did not return valid JSON (required: status). Raw output: …-hermes-raw-output.txt Preview: …

Inspect …-hermes-raw-output.txt to see what the agent actually printed.
```

```
Review echoed packetSha256 sha256:…, but the packet it was given hashes to sha256:….

The reviewer answered about a different document than the one this run pinned. Re-run `review`; if it recurs, inspect the review raw output next to the packet.
```

**What it means.** The adapter ran but the output cannot be parsed or trusted.
The second message means the reviewer answered about a document other than the
packet this run pinned.

**What to do.** Open the raw-output artifact named in the message; secrets are
already redacted in it. Re-run the stage. If the model returns prose instead of
JSON every time, raise its turn budget or switch backend.

**Confirm.** The stage exits `0` and writes its JSON artifact.

### An artifact is malformed or from a newer version

```
Malformed artifact …/dashboard-hermes-judgment.json: `status` must be a string
```

```
Artifact …/dashboard-qa-spec.json was written by a newer version (schemaVersion 2 > 1).
```

**What it means.** The first is a half-written or hand-edited artifact. The
second is an artifact from a newer release of this package; it is refused rather
than parsed on a guess.

**What to do.** For the first, delete the file and re-run the stage that
produces it — [Artifacts reference](./reference/artifacts.md#files) says which
one. For the second, upgrade `playwright-spec-for-ai-agent`, or delete the
artifact and re-run.

**Confirm.** The stage that reads the artifact runs to completion.

### The run ledger chain is broken

```
FAIL  dashboard · run ledger   chain broken at entry 4: entry 4 (run-1a2b3c4d) content does not match its hash
                                → The ledger is append-only; a broken chain means it was edited or truncated. Archive it and start a new one.
```

**What it means.** `{slug}-qa-runs.jsonl` is hash-chained. A mismatch means the
file was edited or truncated after the fact.

**What to do.** Move the file aside and let the next run start a fresh chain.
Do not repair it by hand; a repaired chain is indistinguishable from an
unmodified one.

**Confirm.** `doctor` reports `<n> entries, chain verified`.

## Sessions and credentials

### `login` stored no session

```
No session was stored: the browser window closed without any new session cookie.

Run login again and complete the sign-in at https://staging…/login before closing the window.
If the provider refused to sign in from this browser, run `login --attach`.
```

**What it means.** `login` writes its session marker only when the cookie jar
actually gained a cookie between the freshly loaded login page and the moment
the window closed. Chromium creates the profile directory the instant the window
opens, so directory existence proves nothing — and a profile wrongly treated as
authenticated makes every later `judge` run browse staging logged out while
believing it is signed in.

**What to do.** Run `login` again and complete the sign-in before closing the
window. If the provider refuses the bundled Chromium, try
`login --channel=chrome` (or `--channel=msedge`) to launch the real browser; if
it refuses every automation-launched browser, use `login --attach`.

**Confirm.** `login` prints `Session saved (N cookies).` and `doctor` reports
`PASS session profile   pre-authenticated browser session present`.

Two related refusals:

```
QA browser profile must be owner-only.

Run: chmod -R go-rwx .private/qa-browser-profile
```

```
No QA browser profile at .private/qa-browser-profile.

Run: npx playwright-spec-for-ai-agent login
```

### `judge` warns that credentials go into the prompt

```
[security] Credentials will be embedded in the Hermes prompt and its session logs. Prefer `npx playwright-spec-for-ai-agent login` to create a pre-authenticated session.
```

**What it means.** No session was available, so `judge` fell back to putting the
staging credentials in the prompt — and therefore in the agent's session logs.

**What to do.** Create a session with `login`, configure `staging.storageState`,
or attach with `--cdp-url=`. See
[Authenticate a judge run](./how-to/authentication.md).

**Confirm.** The warning stops, and `judge` prints
`auth mode: preauthenticated (<auth>)` in its plan header.

A missing optional peer dependency blocks the same paths, with its own message:

```
The pre-authenticated session flow needs the optional peer dependency @playwright/test.
Install it (npm i -D @playwright/test && npx playwright install chromium)
or pass --credentials-in-prompt to use the legacy prompt-credential flow.
```

### Credentials read as unset although `.env.local` has them

```
FAIL  credentials   STAGING_QA_EMAIL unset / STAGING_QA_PASSWORD unset — required by: dashboard
                     → Export STAGING_QA_EMAIL and STAGING_QA_PASSWORD, or run `login` once to store a session.
```

**What it means.** The CLI loads `./.env.local` and then `./.env`, in that
order, and prints what it did:

```
[env] /repo/.env.local: 4 applied, 0 already set in the environment (kept)
[env] /repo/.env: 2 applied, 4 already set in the environment (kept)
```

Precedence is earliest-wins, and a real environment variable beats both files, so
a CI secret is never overwritten by a checked-out file. If the values are in
`.env.local` and still read as unset, one of four things happened:

- Node is older than 20.12 and cannot parse env files:
  `[env] skipped /repo/.env: node 20.9.0 cannot parse env files (needs >= 20.12)`;
- `--env-file=<path>` was passed, which replaces both defaults and must exist —
  otherwise `--env-file not found: /repo/.env.staging`;
- `QA_NO_ENV_FILE=1` is set, which disables env-file loading entirely;
- the installed version predates `.env.local` support and read only `.env`.

**What to do.** Upgrade Node to 20.12 or later, drop the overriding flag or
variable, or export the two variables directly. A project whose runs are covered
by a session profile, a `storageState`, or `QA_BROWSER_CDP_URL` needs neither
variable for `judge`; `doctor` reports those cases as `PASS` or `SKIP`, not
`FAIL`.

**Confirm.** `doctor` reports `PASS credentials`, or `SKIP credentials` with the
reason it skipped.

### The storage-state file is rejected

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

**What it means.** `staging.storageState` (or `pages.{page}.storageState`) is
resolved against the project root and must point at a Playwright storage-state
JSON with at least one cookie or one origin entry.

**What to do.** Re-generate the file with your e2e auth setup, or correct the
path. The seed transcript is never printed, because it can carry session tokens
— check the origin's reachability and the file's freshness instead.

**Confirm.** `judge` prints
`Session seeded from <path> (N cookie(s)).` before the run starts.

### httpOnly session cookies cannot be seeded

```
2 session cookie(s) are httpOnly and cannot be seeded via aside repl: session, csrf_token

Use an adapter that attaches to the runner's own browser (auth=cdp-attach), which can set httpOnly cookies over CDP.
```

**What it means.** The `self-prelogin` path seeds the session by evaluating
`document.cookie` in the page, which by definition cannot set an httpOnly
cookie. Rather than judge as an anonymous visitor, the run stops and names the
cookies.

**What to do.** Judge through a `cdp-attach` adapter, which sets cookies over
CDP. Either use the default `hermes` adapter with `login` or a configured
`storageState`, or sign in by hand and pass `--cdp-url=`.

**Confirm.** The run reaches the target page and reports checks other than
`skip`.

### Attaching to your own browser fails

```
Could not attach to a browser at http://127.0.0.1:9222: connect ECONNREFUSED 127.0.0.1:9222

Start Chrome with a dedicated profile and remote debugging, sign in there, then re-run:
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9222 --user-data-dir=/tmp/qa-chrome
```

**What it means.** Nothing is listening on that CDP port.

**What to do.** Start the browser with the two flags above, sign in, then re-run
`judge --page=<page> --cdp-url=http://127.0.0.1:9222`. `login --attach` prints
the same recipe with your configured login URL filled in.

Use a dedicated `--user-data-dir`. Attaching to your everyday Chrome profile
hands the agent every site you are signed into, because it drives that browser's
own contexts.

**Confirm.** `judge` runs and writes `evidence/<slug>-<runId>-trace.zip`. Note
that an attached browser records no HAR and no video, and the run carries a
`capture-unavailable` violation — see
[Launched versus attached](./reference/artifacts.md#launched-versus-attached).

## Targets and configuration

### The target URL is a placeholder

```
Refusing to judge a placeholder target URL: https://your-staging-url.example.com/pricing

Set staging.baseUrl in playwright-spec-for-ai-agent.config.*, or STAGING_QA_BASE_URL.
```

**What it means.** A hostname counts as a placeholder when it is empty,
unparseable, `example`, `example.com`, `example.org`, `example.net` **or any
subdomain of those**, or when it contains `your-`, `yourdomain`, `changeme`, or
`todo`. The RFC 2606 domains are reserved, so `staging.example.com` can never be
a real staging origin; it is refused rather than judged and reported as
unreachable.

`playwright-spec-for-ai-agent.config.example.mjs` uses
`https://staging.example.com` on purpose. A fresh copy of it fails `doctor`
until you set a real origin — that failure is the example config doing its job.

**What to do.** Set `staging.baseUrl` in your config, or export
`STAGING_QA_BASE_URL`.

**Confirm.** `doctor` stops reporting `placeholder base URL: <url>` or
`no base URL resolved` and prints the resolved target URL instead.

Origin pinning is disabled while the base URL is a placeholder, since there is
no real origin to pin to.

### The page has no target

```
Missing target for page "pricing".

Set pages.pricing.pageUrl, pages.pricing.targetPath, or targetPaths.pricing in playwright-spec-for-ai-agent.config.*, or pass --target-path=/pricing
```

**What to do.** Set one of the three config keys, or pass `--target-path=`.
Precedence is in
[Configuration reference](./reference/configuration.md).

**Confirm.** `doctor` reports `PASS <page> · target   <url>`.

### Staging is down

`judge` preflights the target with a plain fetch before spending an agent run.
Both of these exit `3`:

```
Target https://staging…/pricing is unreachable: fetch failed

Check the staging deployment and STAGING_QA_BASE_URL before spending an agent run.
```

```
Target https://staging…/pricing returned HTTP 503 before the run started.

Staging is failing; judging it now would report an outage as a product defect.
```

**What to do.** Wait for the deployment, or point at a reachable origin.

**Confirm.** `judge` prints `Preflight <url> -> HTTP <status>` and continues.

The preflight is unauthenticated, so it cannot tell a live session from an
expired one. The judge prompt instructs the agent to stop with `manual_review`
if the page looks logged out.

### A config key is rejected

```
[qa-config] unknown config key "staging.baseURL" — did you mean "baseUrl"?
[qa-config] "staging.authRequired" must be a boolean, got string
[qa-config] "pages.billing.pageUrl" is not a valid URL: /settings/billing
[qa-config] "staging.baseUrl" is a placeholder (https://staging.example.com) — set a real staging origin before judging
```

**What it means.** These are warnings by default. With `--strict-config` (or
`QA_STRICT_CONFIG=1`) they become a usage error, exit `2`:

```
Invalid project config (2 problems):
  unknown config key "staging.baseURL" — did you mean "baseUrl"?
  ...

Fix the keys above, or drop --strict-config / QA_STRICT_CONFIG=1 to downgrade these to warnings.
```

**What to do.** Only these top-level keys are recognised: `root`, `paths`,
`pages`, `targetPaths`, `staging`, `fixtures`, `livePolicies`, `hooks`. The full
key list is in [Configuration reference](./reference/configuration.md).

**Confirm.** `doctor` reports `PASS config`.

One more message applies only when you call the modules directly rather than
through the CLI:

```
[qa-config] loadProjectConfig() called again with different flags — re-resolving project config. Load it once, in the entry script.
```

## Agent backend

### The agent CLI is not found

From `doctor`:

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

**What to do.** Install the CLI, or set `QA_AGENT_CMD`. To exercise the pipeline
with no model at all, run with `QA_AI_ADAPTER=fixture` — it produces a
shape-correct `manual_review`, never a green verdict.

**Confirm.** `doctor` reports `PASS adapter binary <path>`.

### The adapter name is not recognised

```
Unknown QA_AI_ADAPTER: "hemres".

Built-in adapters: hermes, aside, exec, fixture. For a third-party backend, set QA_AI_ADAPTER to a module specifier — a path ("./qa-adapters/my-agent.mjs") or a package ("@acme/qa-adapter") — exporting `run(query, maxTurns, options)` and optionally `capabilities`, `prelogin`, and `resolveModel`.
```

**What it means.** The value is neither a built-in name nor a module specifier.
A specifier must start with `@` or contain `/` or `.`.

**What to do.** Fix the spelling, or point at a module. See
[Adapters reference](./reference/adapters.md) and
[Add an adapter](./how-to/add-an-adapter.md).

**Confirm.** `doctor` prints the resolved descriptor on its `adapter` row.

A related message means the module was found but never imported:

```
QA_AI_ADAPTER module "./qa-adapters/my-agent.mjs" was never loaded: call prepareAdapter() first.
```

It only reaches you when you call `runAgent` from your own code; the entry
scripts already `await prepareAdapter()`.

### Hermes is configured but refuses to start

```
Hermes could not start: Provider 'openai' is set in config.yaml but no API key was found. See raw output: …-hermes-raw-output.txt

Fix the provider/model in ~/.hermes/config.yaml (or `hermes model`), then re-run. `doctor` checks this before a run.
```

A rejected key is reported separately:

```
Hermes API key was rejected or permission denied. See raw output: …-hermes-raw-output.txt
```

**What it means.** A model can be configured while the key for the provider that
serves it is not. Hermes prints its own diagnosis and exits `0`, so this used to
arrive as `did not return valid JSON` (exit 4) and sent people hunting for a
parser bug. It is now an environment failure (exit 3) carrying Hermes's own
words.

**What to do.** Export the provider key, put it in `~/.hermes/.env`, or switch
provider with `hermes model`.

**Confirm.** `doctor` catches this before a run is spent — it reads the provider
from `~/.hermes/config.yaml` and looks for `<PROVIDER>_API_KEY` in the
environment or in `~/.hermes/.env`:

```
FAIL  adapter provider   openai configured but OPENAI_API_KEY is unset — hermes-agent will refuse to start
                          → Export OPENAI_API_KEY, put it in ~/.hermes/.env, or switch provider with `hermes model`.
```

The check is skipped when there is no `~/.hermes/config.yaml`, or when the
provider is unset or `auto`. A separate failure covers the model itself:

```
Hermes model is not configured. Set model.default in ~/.hermes/config.yaml or export HERMES_INFERENCE_MODEL.
```

### The agent run times out

```
Hermes timed out after 600000ms. Partial output: …-hermes-raw-output.txt

Raise HERMES_QA_TIMEOUT_MS if Hermes legitimately needs longer.
```

**What it means.** Every CLI adapter is wall-clock bounded at 10 minutes by
default. The message names the variable that raises it:
`HERMES_QA_TIMEOUT_MS`, `ASIDE_QA_TIMEOUT_MS`, or `QA_AGENT_TIMEOUT_MS`.

**What to do.** Read the partial output first — a timeout on a stalled login
looks the same as a timeout on a slow model. Raise the variable only once you
know the agent was making progress.

**Confirm.** The stage completes and writes its JSON artifact.

## Specs and annotations

### A spec is ignored or rejected

```
Missing // @qa-live-policy on test "shows the plan name" (billing.spec.ts:24).

Add it on the test or an enclosing test.describe, e.g. `// @qa-live-policy: readonly`.
```

```
Unknown @qa-live-policy: read-only. Use one of: readonly, safe-interaction, safe-interaction-no-confirm, mock-judgment, subscription-mutation, auth-mock, skip
```

**What it means.** `@qa-live-policy` is mandatory for every parsed test, and its
value must be a built-in name or one you added under `livePolicies`. The
message lists your configured custom names too.

If a file seems to be ignored entirely, check the whole-comment-line rule in
[Annotations reference](./reference/annotations.md): an annotation counts only
when it is the entire comment line.

**What to do.** Add or correct the annotation on the test or an enclosing
`test.describe`.

**Confirm.** `doctor` reports what it found per page:

```
PASS  billing · spec dir   src/page/billing/__tests__ — 3 annotated, 1 @qa-live-skip, 2 runnable
FAIL  billing · spec dir   src/page/billing/__tests__ — no *.spec.ts carries // @qa-scenario
```

## Reporting

### `slack` refuses to post

```
Missing SLACK_WEBHOOK_URL.

Export SLACK_WEBHOOK_URL=<Slack incoming webhook URL>, or pass --notify=never to skip reporting.
```

```
Unknown --notify=quiet.

Use one of: --notify=failures, --notify=always, --notify=never.
```

**What to do.** Export the webhook URL, or pass a valid `--notify=` mode.

**Confirm.** `doctor` reports `PASS SLACK_WEBHOOK_URL set`.

### `ack` refuses the item or the reason

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

**What it means.** `--item=` must match a check title in the latest judgment
exactly. A typo fails loudly, because an ack that matches nothing looks
identical to a working one until the alert fires again.

**What to do.** Copy the title from
`show --page=<slug> --failed`, and always pass `--reason=`.

**Confirm.** `ack --page=<slug> --list` shows the entry.

### The command name is wrong

```
Unknown command: judeg

Did you mean "judge"?
```

**What to do.** Run `npx playwright-spec-for-ai-agent --help` for the command
list, or see [CLI reference](./reference/cli.md).

## Related pages

- [CLI reference](./reference/cli.md) — commands, flags, and exit codes.
- [Configuration reference](./reference/configuration.md) — every config key.
- [Adapters reference](./reference/adapters.md) — backend environment variables.
- [Artifacts reference](./reference/artifacts.md) — what each file contains.
- [Authenticate a judge run](./how-to/authentication.md) — the three session
  paths in full.
- [Glossary](./glossary.md)
