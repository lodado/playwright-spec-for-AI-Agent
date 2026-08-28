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

A hostname counts as a placeholder when it is empty, unparseable, exactly
`example`/`example.com`/`example.org`/`example.net`, or contains `your-`,
`yourdomain`, `changeme`, or `todo`. Note that `staging.example.com` is
deliberately **not** a placeholder — it is a plausible real host and appears in
this project's own docs.

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

Run `npx playwright-spec-for-ai-agent login` again and complete the sign-in at https://staging…/login before closing the window.
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

```
[env] /repo/.env: 4 applied, 2 already set in the environment (kept)
--env-file not found: /repo/.env.staging
[env] skipped /repo/.env: node 20.9.0 cannot parse env files (needs >= 20.12)
```

Real environment variables always win over `.env`. `QA_NO_ENV_FILE=1` disables
loading entirely.

## Unknown command

```
Unknown command: judeg

Did you mean "judge"?
```
