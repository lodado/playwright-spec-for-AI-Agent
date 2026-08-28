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
spec → abstract-ai → judge → review → slack (optional)
```

## What it is, and is not

- **It is** a live-staging judgment layer for apps that already have Playwright specs.
- **It is not** a test generator, a test healer, or a replacement for your CI suite.
- **It never runs Playwright against staging.** Specs are read as source material, never executed there, and never modified.
- Ambiguous results become `manual_review` rather than a forced pass or fail.
- Zero runtime dependencies. `@playwright/test` is an *optional* peer, needed only for the browser session paths and the trace/HAR evidence they enable.

## Try it offline, in one command

```bash
npx playwright-spec-for-ai-agent demo
```

No credentials, no model, no network: a bundled demo app on a local port, driven by
the `fixture` adapter whose judge always returns `manual_review`, so an offline run
can never look green. `--keep` or `--out=<dir>` keeps the artifacts to inspect.

## Quick start

Run from your app repo, where the Playwright specs live.

```bash
npm install -D playwright-spec-for-ai-agent
cp node_modules/playwright-spec-for-ai-agent/playwright-spec-for-ai-agent.config.example.mjs \
   playwright-spec-for-ai-agent.config.mjs

# annotate one spec file (docs/annotations.md), then:
npx playwright-spec-for-ai-agent doctor              # exits 3 if setup is incomplete
npx playwright-spec-for-ai-agent login --page=pricing # log in once; judge reuses the session

npx playwright-spec-for-ai-agent spec        --page=pricing
npx playwright-spec-for-ai-agent abstract-ai --page=pricing
npx playwright-spec-for-ai-agent judge       --page=pricing
npx playwright-spec-for-ai-agent review      --page=pricing
npx playwright-spec-for-ai-agent show        --page=pricing
```

Or the whole thing nightly, across every configured page:

```bash
npx playwright-spec-for-ai-agent nightly --all --with-slack --non-interactive
```

`judge` needs `hermes-agent` by default; point it at another backend with
`QA_AI_ADAPTER` — see [docs/adapters.md](docs/adapters.md).

## Giving the judge a session

| Your app                                       | What to do                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| Has a login form                               | `login` — sign in by hand once, into a private profile `judge` reuses           |
| Mints its session in code, no form to drive    | Point `staging.storageState` at the storage state your e2e auth setup writes    |
| Provider blocks automated browsers (Google, SSO) | Start Chrome yourself (`login --attach` prints the recipe), then `judge --cdp-url=<url>` |

Exact commands, and what evidence each path gives up:
[docs/authentication.md](docs/authentication.md).

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

## Commands

| Command       | Purpose                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `spec`        | Parse `@qa-scenario` specs into QA scenario JSON.                      |
| `abstract-ai` | Agent writes the Given/When/Then live plan.                            |
| `login`       | Headed browser, log in once; `--channel` real Chrome, `--attach` recipe. |
| `judge`       | Agent opens the target page and judges live DOM.                       |
| `review`      | Second agent re-reviews the judgment against a pinned evidence packet. |
| `slack`       | Post the verdict to a Slack webhook.                                   |
| `nightly`     | `spec → abstract-ai → judge → review → (slack)`, one or many pages.    |
| `doctor`      | Preflight config, specs, adapter, credentials, staging, artifacts.     |
| `show`        | One screen of the latest verdict, checks, coverage, and evidence.      |
| `report`      | One table over every configured page's latest judgment.                |
| `ack`         | Acknowledge a `manual_review` item so it stops re-alerting.            |
| `demo`        | Offline end-to-end run against the bundled demo app.                   |

`<command> --help` lists that command's flags; full reference in [docs/](#documentation).

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
| **Runs against staging**     | An AI agent in a browser. Never Playwright.          | Generated/healed Playwright tests              | The framework's own browser automation | The framework's own browser automation | Your Playwright suite, as written |
| **Output**                   | A judged verdict + evidence, per planned check       | Test files / a repaired test                   | Automation results                     | Test results                           | Pass/fail per assertion           |
| **Test authoring required**  | You already did it                                   | The tools write them                           | You write NL steps                     | You write NL cases                     | You write and maintain them       |
| **Safety model**             | Origin pinning, read-only mutation guard, runner-owned evidence, downgrade-only verdicts | Your own CI conventions | Your own configuration | Your own configuration | Whatever your test does |

Other tools are summarised briefly from their stated purpose — check their own docs before comparing. Only the first column is a claim about this repository.

## Security model

- **Credentials stay out of the prompt on all three session paths.** `login` stores a
  session in an owner-only profile (`.private/qa-browser-profile`, mode `0700`);
  `staging.storageState` replays a file your repo already has; `--cdp-url` borrows a
  browser you signed into yourself. The agent is handed a CDP URL or nothing.
- **The CDP window is real and bounded.** While the agent runs, that endpoint is
  loopback-bound but *unauthenticated* — any process running as your user could attach.
  Chromium offers no CDP auth, so the mitigations are the loopback bind and the
  endpoint's lifetime. Attaching to your everyday Chrome profile would hand the agent
  every site you are signed into; use a dedicated `--user-data-dir`.
  `--credentials-in-prompt` opts back into the legacy flow, and warns.
- **Origin pinning.** `allowedOrigins` defaults to the staging origin; a navigation
  off it is aborted (or flagged from the HAR) and floors the verdict at `fail` with
  cause `HARNESS_DEFECT`. On a read-only plan, non-GET requests are treated the same.
- **Prompt-injection demarcation.** Plan content sits between explicit
  `<<<QA-PLAN-DATA:BEGIN/END>>>` markers declared as data, marker-shaped text inside it
  is stripped, and injection-shaped accessible names are annotated, never deleted.
- **The harness captures the evidence, not the agent.** Trace, HAR, screenshots, and
  aria snapshots come from the Playwright context the runner owns, so the audited thing
  cannot forge or omit them — though an attached browser records no HAR. Secrets are
  redacted from every artifact, and Slack escapes what the agent wrote.

## Limits

Not a replacement for deterministic Playwright CI, API contract tests, or a QA engineer.
It cannot catch backend regressions with no user-facing effect, it is not a deterministic
production test runner, and it is unsafe for destructive flows unless they are marked
`skip` or a `blocked-*` policy. Judgments carry model non-determinism — verdict
history and `--samples=` exist because one run is not proof.

## Documentation

- [docs/annotations.md](docs/annotations.md) — the annotation vocabulary and live policies
- [docs/authentication.md](docs/authentication.md) — the three ways to give the judge a session
- [docs/configuration.md](docs/configuration.md) — every config key, flag, and environment variable
- [docs/adapters.md](docs/adapters.md) — hermes / aside / exec / fixture, and writing your own
- [docs/verdicts.md](docs/verdicts.md) — how a verdict is decided, and triaging `manual_review`
- [docs/artifacts.md](docs/artifacts.md) — every file a run writes, and the judgment JSON contract
- [docs/ci.md](docs/ci.md) — exit codes, GitHub Actions, CTRF, Slack
- [docs/troubleshooting.md](docs/troubleshooting.md) — real error messages and what to do about them
- [examples/](examples/) — annotated spec examples and the offline demo app

MIT licensed. [Issues and PRs](https://github.com/lodado/playwright-spec-for-AI-Agent/issues).
