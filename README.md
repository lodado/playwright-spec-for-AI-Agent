<div align="center">

# playwright-spec-for-AI-Agent

**Judge a live staging page against the Playwright specs you already wrote.**

[![npm version](https://img.shields.io/npm/v/playwright-spec-for-ai-agent?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/playwright-spec-for-ai-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)

</div>

Your `*.spec.ts` files already encode what "correct" means. This CLI reads the
`@qa-scenario` annotations on them, turns each scenario into a Given/When/Then plan,
sends an AI agent to look at the real staging page, and returns `pass`, `fail`,
`manual_review`, or `skip` — with the harness, not the agent, deciding whether the
evidence supports it.

```text
spec → abstract-ai → judge → review → slack · issues (optional)
```

## What it is, and is not

- **It is** a live-staging judgment layer for apps that already have Playwright specs.
- **It is not** a test generator, a test healer, or a replacement for your CI suite.
- **It never executes your Playwright test suite against staging.** Specs are read as source material and never modified. Browser session setup and evidence capture can use Playwright APIs.
- Ambiguous results become `manual_review` rather than a forced pass or fail.
- Zero runtime dependencies. `@playwright/test` is an *optional* peer, needed only for the browser session paths and the trace/HAR evidence they enable.

## Try it offline, in one command

```bash
npx playwright-spec-for-ai-agent demo
```

No credentials, no model, no external service: a bundled demo app on a local port, driven by
the `fixture` adapter whose judge always returns `manual_review`, so an offline run
can never look green. `--keep` or `--out=<dir>` keeps the artifacts to inspect.

Then walk the same pipeline against your own page:
[docs/get-started.md](docs/get-started.md).

## What a run looks like

**① Your spec** — the annotations are the QA intent. Nothing here is executed against staging.

```ts
// @qa-page: dashboard
// @qa-scenario: ACTIVE

import { expect, test } from "@playwright/test";

// @qa-live-policy: mock-judgment
test("shows health score on dashboard", async ({ page }) => {
  await expect(page.getByTestId("health-score")).toContainText("98 pts");
  await expect(page.getByTestId("health-score-label")).toHaveText("Excellent");
});
```

**② `abstract-ai` → `dashboard-qa-spec-live.md`** — CI mock literals become intent, because they cannot be replayed live.

```markdown
### ACTIVE — shows health score on dashboard

Given the health widget is backed by mocked API data in CI (`98 pts`, `Excellent`)
When I view the health-score area in read-only mode
Then a numeric score with its unit and a readable status label are shown — exact
mock values are not required; a loading or label-only widget is ambiguous
```

**③ `judge` → `dashboard-hermes-judgment.md`** — the agent browses, the harness scores.

```markdown
- Status: **manual_review**  ·  Cause: SPEC_GAP  ·  Run: `run-4f2a91c0`

| Result        | Item                            | Detail                                                      |
| ------------- | ------------------------------- | ----------------------------------------------------------- |
| manual_review | shows health score on dashboard | Widget visible but shows label "Good" with no numeric score. |
```

Out of `fail` because the widget is present; out of `pass` because the plan asked for a score and none was observed.

**④ `handoff` (or `issues`)** — the same verdict, addressed to whoever fixes it.

```markdown
## Check 1 — shows health score on dashboard

Result: **manual_review** · cause SPEC_GAP · judge confidence high

Contract (frozen live plan, do not restate it differently):
- Then: a numeric score with its unit and a readable status label are shown

Origin: spec file `dashboard.spec.ts` · policy `@qa-live-policy: mock-judgment`

What the judge reported observing:
> Widget visible but shows label "Good" with no numeric score.
```

Piped into a coding agent, or filed as a GitHub issue by `nightly --with-issues`.

## Annotations

QA intent lives in the specs you already have, as `//` comments. `spec` reads
them; nothing else in the pipeline reads your test code.

**File-level** — at the top of the file, before the imports:

| Annotation                | Required | Effect                                                            |
| ------------------------- | -------- | ------------------------------------------------------------------- |
| `// @qa-scenario: ACTIVE` | yes      | Scenario id. A file without it is invisible to `spec`.            |
| `// @qa-page: billing`    | no       | Page id override for a file outside the page's spec dir.          |
| `// @qa-live-skip: true`  | no       | Exclude the file from live QA; its tests report `skip`.           |
| `// @qa-always-run: true` | no       | Judge this scenario even when another one was selected.           |

**Test-level** — `// @qa-live-policy` is required on every test or an enclosing
`test.describe`, and decides how far the judge may go on the live site:

| Value                         | Judge behaviour                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `readonly`                    | Inspect the page. No mutating clicks.                                           |
| `safe-interaction`            | Follow the steps in the plan; dismiss risky dialogs with Esc. Must be executed. |
| `safe-interaction-no-confirm` | Open the flow, stop before the confirm or destructive submit.                   |
| `mock-judgment`               | The CI test used `page.route` mocks. Judge by intent, not by mock literals.     |
| `subscription-mutation`       | Blocked on live: reported as `skip`.                                            |
| `auth-mock`                   | Blocked on live: reported as `skip`.                                            |
| `skip`                        | Blocked on live: reported as `skip`.                                            |

`// @qa-fixture: avatar=tests/fixtures/qa-avatar.png` names an upload file, at
file, describe, or test level.

When fixtures are declared, `judge` checks that they are readable files, then
asks the selected agent to upload them into isolated file inputs before account
detection or judging. The runner compares the uploaded names, sizes, and SHA-256
hashes with the local files. A missing file, unsupported adapter, unavailable
upload tool, or failed upload stops the run as an environment error, without
producing a product verdict or retrying the judge. This requires a `cdp-attach`
adapter; terminal-based upload tools are allowed. No application upload is
submitted by the probe. Passing proves the tools worked for that probe, not
that every application upload flow will succeed.

`doctor` checks files and adapter compatibility offline and warns when actual
upload has not been verified. Run `doctor --page=<slug> --check-upload` to run
the same upload probe. Hermes checks the runner's upload bridge without a model
call; external adapters use model calls. Browserbase also allocates a temporary
billable session. `--check-network` alone does not run this probe.
`judge --dry-run` checks files but does not call the agent. Runs without
fixtures do not incur an upload probe.

Three rules account for most annotations that "did not work":

1. An annotation must be the **whole comment line**. Prose that quotes one — as
   this README does — is documentation, not an annotation.
2. `@qa-live-skip` and `@qa-always-run` require the line to end after `true`.
   `@qa-live-policy` tolerates a trailing `// note`; `@qa-fixture` does not.
3. A test with no `@qa-live-policy`, and no policy on an enclosing describe,
   makes `spec` exit 2 rather than guess.

Full reference, including what each verb means to the harness:
[docs/reference/annotations.md](docs/reference/annotations.md).

## Closing the loop

A verdict that only a person reads is a verdict that waits for a person.
`nightly --with-issues` files one GitHub issue per page that still needs action,
with the `handoff` document as the body: each unsettled check beside the frozen
contract it was judged against, the spec file behind it, the evidence the
harness captured, and the guardrails that say *propose, do not apply* and
*never weaken a check to make it pass*. Label a coding agent onto it and the
fix arrives as a pull request you review.

**Nothing in that loop can certify itself.** The agent has no staging
credentials, so it cannot run `judge`. Merging its pull request closes no
issue. The issue closes when the next scheduled run re-judges the deployed page
and passes — an independent check, for free, because the tool that files the
work is not the tool that does it. It still fixes nothing on its own.

Same failures tonight means silence, so a comment always means something
changed; a returning failure reopens the original thread; a flipping check is
labelled `qa:flaky` rather than presented as fact. Harness defects and
quarantined runs are not filed at all — a check that was never really judged is
ops work, and filing it at the product team is how a label becomes noise.

Full walkthrough: [docs/how-to/close-the-loop.md](docs/how-to/close-the-loop.md).

## Commands

Fifteen commands. The pipeline is `spec`, `abstract-ai`, `judge`, `review`, and
the optional notifiers `slack` and `issues`; `nightly` runs them over one page or
every page. `login` gives the judge a session, `doctor` preflights the setup, and
`show`, `report`, and `ack` triage what came back. `handoff` turns a verdict into
a fix-planning task you can pipe into a coding agent. `demo` runs the whole
pipeline offline. `benchmark` checks frozen verdict cases without a model:

```bash
npm run qa:benchmark -- --repeat=3 --output=benchmark.json
```

See [the benchmark guide](docs/how-to/benchmark.md) for evidence-only adapter
comparisons and metric limits.

Run `<command> --help` for its flags, or read
[docs/reference/cli.md](docs/reference/cli.md) for the full reference.

## Agent backends

Choose **who judges** with `QA_AI_ADAPTER`. Choose **where the browser runs**
with `QA_BROWSER_PROVIDER`. These are separate settings. The defaults are
`hermes` and `local`.

| AI adapter | What runs | Login/browser model | Browserbase judge |
| --- | --- | --- | --- |
| `hermes` | Hermes Agent with your configured model | Attaches to the runner's authenticated browser over CDP | Supported |
| `aside` | `aside exec` | Uses Aside's own browser and prelogin or storage-state seeding | Not supported |
| `exec` | Your configured CLI, including Claude Code or Codex | CDP attach when `QA_AGENT_AUTH=cdp-attach`; otherwise legacy credentials-in-prompt | Only with a CDP-capable browser tool |
| `stagehand` | Optional Stagehand 3.7.3 SDK; configurable model API | Runner-owned local browser or explicit CDP attach | Not yet validated |
| `fixture` | Deterministic local JSON, no model | Does not browse or verify a live site | Not supported |
| Custom module | A project-relative or installed adapter module | Declares its own capabilities | Only when it declares and implements `cdp-attach` |

**Start here:** [Run each adapter](docs/how-to/run-an-adapter.md) provides
prerequisites, configuration, commands, expected results, and failure checks for
Hermes, Aside, Claude Code, Codex, fixtures, and custom modules.
[Adapter reference](docs/reference/adapters.md) lists all variables and the
capability contract.

For example, after configuring your page, generating its live plan, authenticating
the selected agent CLI, and preparing the site's login session:

```bash
QA_AI_ADAPTER=hermes npx playwright-spec-for-ai-agent doctor --page=dashboard
QA_AI_ADAPTER=hermes npx playwright-spec-for-ai-agent judge --page=dashboard
```

`doctor` checks setup without spending an agent run. A passing configuration
check does not prove that the site's login or the model's judgment is correct.

## Browser providers

Browserbase is a **remote browser provider**, not another AI adapter. Selecting
it does not replace Hermes, select a different model, or guarantee faster runs.

| Provider | Where it runs | Login reuse | Evidence and limits |
| --- | --- | --- | --- |
| `local` (default) | A local browser or an explicitly attached CDP browser | Local login profile, storage state, or an already signed-in browser | Evidence and guards depend on the session path |
| `browserbase` | Remote Chromium accessed over CDP | Manual Live View login and a saved Context scoped to project, origin, and account profile; storage state can seed an ephemeral session | Screenshots, ARIA, trace when available, and a session dashboard link. No local HAR/video or local origin/mutation enforcement |

### Log in through Browserbase

Install the optional `@playwright/test` peer. No local Chromium download is
required for this provider. Put `BROWSERBASE_API_KEY` and
`BROWSERBASE_PROJECT_ID` in a gitignored, owner-only `.env.browserbase` file.
Also configure your staging URL and page as described in
[Get started](docs/get-started.md). Never put keys in command arguments or commit
filled-in environment files.

Run from the configured project root. Replace the page, profile, success URL,
and authenticated-only selector with values from your app:

```bash
npx playwright-spec-for-ai-agent login --page=dashboard \
  --browser-provider=browserbase --browserbase-profile=qa-user \
  --success-url=/dashboard --success-selector='[data-testid="account-menu"]' \
  --env-file=.env.browserbase

npx playwright-spec-for-ai-agent doctor --page=dashboard \
  --browser-provider=browserbase --browserbase-profile=qa-user \
  --env-file=.env.browserbase

npx playwright-spec-for-ai-agent judge --page=dashboard \
  --browser-provider=browserbase --browserbase-profile=qa-user \
  --env-file=.env.browserbase
```

`login` prints a private Live View link. Complete login there. The command saves
Context metadata only after observing the configured success condition and
completing session release. At least one success condition is required; both
must match when both are supplied. `judge` rechecks the saved condition and
uses one remote session for account-state detection and judgment.

The remote path isolates synchronous agents in a child process to keep CDP
responsive, redacts provider secrets from surfaced text, and cleans up allocated
sessions. Browserbase usage can incur charges, and its browser must be able to
reach your site. Its `localhost` is not your machine. SSO/MFA remains subject to
your identity provider's restrictions.

Read [Browserbase setup, supported features, and limitations](docs/how-to/browserbase.md)
for the full workflow, `exec` integration, timeout/cancellation behavior, and
what has and has not been validated. Offline tests and real local-CDP tests do
not establish that cloud login or Context persistence works for your account.

## Why this exists

Deterministic Playwright tests belong in CI: fast, stable, good at mocked UI states.
They do not answer whether the *deployed* page still behaves correctly with real data,
routing, copy, and latency — and production-like environments are non-deterministic,
so live QA needs judgment and evidence, not only assertions. This tool is that
first-pass layer, and it escalates whatever it cannot settle.

## How this differs

Those tools write or run tests; this one judges staging against tests you wrote.

|                              | **this tool**                                        | Playwright Planner / Generator / Healer agents | Stagehand                              | Magnitude                              | raw Playwright vs. staging        |
| ---------------------------- | ---------------------------------------------------- | ---------------------------------------------- | -------------------------------------- | -------------------------------------- | --------------------------------- |
| **Input**                    | Annotations on specs you already have                | The app, plus a prompt or a failing test       | Natural-language steps in your code    | Natural-language test cases            | The spec file                     |
| **Runs against staging**     | An AI agent in a browser, not your test suite.       | Generated/healed Playwright tests              | The framework's own browser automation | The framework's own browser automation | Your Playwright suite, as written |
| **Output**                   | A judged verdict + evidence, per planned check       | Test files / a repaired test                   | Automation results                     | Test results                           | Pass/fail per assertion           |
| **Test authoring required**  | You already did it                                   | The tools write them                           | You write NL steps                     | You write NL cases                     | You write and maintain them       |
| **Safety model**             | Origin pinning, read-only mutation guard, runner-owned evidence, downgrade-only verdicts | Your own CI conventions | Your own configuration | Your own configuration | Whatever your test does |

Other tools are summarised briefly from their stated purpose — check their own docs before comparing. Only the first column is a claim about this repository.

## Security model

- **No credential reaches the prompt on any of the three session paths.** `login`
  stores a session in an owner-only profile (`.private/qa-browser-profile`, mode
  `0700`); `staging.storageState` replays a file your repo already has; `--cdp-url`
  borrows a browser you signed into yourself. The agent receives a CDP URL, or nothing.
- **A locally exposed Chromium CDP endpoint is unauthenticated** for the length of the run. Chromium offers
  no CDP auth, so the mitigations are the loopback bind and the endpoint's lifetime —
  which is why the attach recipe uses a dedicated `--user-data-dir` instead of your
  everyday Chrome profile.
- **Browserbase connection links are private capabilities.** The provider redacts
  API keys and connection URLs from surfaced text and stores only scoped Context
  metadata locally. Do not share the Live View link or point agents at production
  accounts. See [Browserbase safety limits](docs/how-to/browserbase.md#evidence-and-safety-limits).
- **Origin pinning.** `allowedOrigins` defaults to the staging origin; a navigation
  off it floors the verdict at `fail` with cause `HARNESS_DEFECT`. On a read-only
  plan, non-GET requests are treated the same.
- **Guard coverage depends on the browser path.** Browserbase and attached remote
  contexts do not provide the local runner's origin/mutation enforcement or HAR.
  A read-only prompt is not a security boundary. Use server-side read-only roles
  when actions must be prevented.
- **A filed issue is still quoted evidence.** The judge's prose reaches a reader
  with write access to your repository, so it travels quoted and injection-scanned
  with the same patterns applied to aria snapshots. Filing on a public repository
  is refused unless you opt in: the body carries the staging URL and page structure.
- **Runner evidence is separate from agent claims.** Available trace, HAR,
  screenshots, and ARIA snapshots come from the runner's Playwright context.
  Judge and reviewer require a nonempty captured file registered in the run,
  or quoted text verified against a captured ARIA snapshot. A quote or URL in
  the agent's prose alone is insufficient. This checks provenance, not whether
  the evidence proves the claim; see [the verdict rules](docs/explanation/how-verdicts-are-decided.md#per-check-floors).
  Capture availability varies by provider and session path. Text redaction does
  not remove sensitive application data from screenshots or traces; protect them
  as private artifacts.

Full detail, and what each session path gives up:
[docs/how-to/authentication.md](docs/how-to/authentication.md).

## Limits

Not a replacement for deterministic Playwright CI, API contract tests, or a QA engineer.
It cannot catch backend regressions with no user-facing effect, it is not a deterministic
production test runner, and it is unsafe for destructive flows unless they are marked
`skip` or a `blocked-*` policy. Judgments carry model non-determinism — verdict
history and `--samples=` exist because one run is not proof. Filing an issue does
not make a verdict more certain: `qa:flaky` and `manual_review` propagate a
suspended judgment, they do not resolve one.

## Documentation

Start at [docs/get-started.md](docs/get-started.md); the full map is
[docs/README.md](docs/README.md).

- [docs/how-to/authentication.md](docs/how-to/authentication.md) — give the judge a session
- [docs/how-to/ci.md](docs/how-to/ci.md) — run it unattended, and read the exit code
- [docs/how-to/close-the-loop.md](docs/how-to/close-the-loop.md) — file failing verdicts as issues an agent can work on
- [docs/reference/configuration.md](docs/reference/configuration.md) — every config key, flag, and environment variable
- [docs/reference/annotations.md](docs/reference/annotations.md) — the annotation vocabulary and live policies
- [docs/explanation/how-verdicts-are-decided.md](docs/explanation/how-verdicts-are-decided.md) — why a verdict came out the way it did
- [docs/troubleshooting.md](docs/troubleshooting.md) — real error messages and what to do about them
- [examples/](examples/) — annotated spec examples and the offline demo app

MIT licensed. [Issues and PRs](https://github.com/lodado/playwright-spec-for-AI-Agent/issues).
