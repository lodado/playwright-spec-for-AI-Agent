<div align="center">

# playwright-spec-for-AI-Agent

**AI-assisted live staging QA for web apps that already have Playwright specs.**

[![npm version](https://img.shields.io/npm/v/playwright-spec-for-ai-agent?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/playwright-spec-for-ai-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-%3E%3D1.40-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev)
[![GitHub stars](https://img.shields.io/github/stars/lodado/playwright-spec-for-AI-Agent?style=for-the-badge&logo=github)](https://github.com/lodado/playwright-spec-for-AI-Agent/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/lodado/playwright-spec-for-AI-Agent?style=for-the-badge&logo=github)](https://github.com/lodado/playwright-spec-for-AI-Agent/issues)

<br />

[![Playwright](https://img.shields.io/badge/%23Playwright-2EAD33?style=flat-square)](https://github.com/topics/playwright)
[![Test Automation](https://img.shields.io/badge/%23TestAutomation-0A66C2?style=flat-square)](https://github.com/topics/test-automation)
[![Software Testing](https://img.shields.io/badge/%23SoftwareTesting-6E40C9?style=flat-square)](https://github.com/topics/software-testing)
[![Quality Assurance](https://img.shields.io/badge/%23QualityAssurance-2EA44F?style=flat-square)](https://github.com/topics/quality-assurance)
[![AI Agent](https://img.shields.io/badge/%23AIAgent-FF6F00?style=flat-square)](https://github.com/topics/ai-agent)
[![AI Engineering](https://img.shields.io/badge/%23AIEngineering-E91E63?style=flat-square)](https://github.com/topics/ai-engineering)

<br />

[Quick start](#quick-start) · [Configuration](#configuration) · [Annotations](#annotations) · [npm package](https://www.npmjs.com/package/playwright-spec-for-ai-agent) · [Report issue](https://github.com/lodado/playwright-spec-for-AI-Agent/issues)

</div>

---

This tool reads Playwright `*.spec.ts` files, extracts `@qa-scenario` intent, turns it into structured QA scenarios, and uses [Hermes Agent](https://github.com/NousResearch/hermes-agent) to validate the same intent against a staging page.

Hermes Agent is used here as the adapter layer for multiple agents. The CLI keeps the project-specific QA flow stable, while Hermes handles agent execution, browser access, model calls, and judgment/review steps through its agent adapters.

```text
spec → abstract-ai → judge → review → slack (optional)
```

### End-to-end example

> **One annotated Playwright spec** → structured live plan → Hermes browses staging and returns a verdict.

<table>
<tr>
  <td align="center"><strong>① spec</strong><br/><code>*.spec.ts</code></td>
  <td align="center">→</td>
  <td align="center"><strong>② abstract-ai</strong><br/><code>{page}-qa-spec-live.md</code></td>
  <td align="center">→</td>
  <td align="center"><strong>③ judge</strong><br/><code>{page}-hermes-judgment.md</code></td>
</tr>
</table>

#### ① Playwright spec — intent, fixture, live policy

The CLI reads annotations and assertions; it does **not** run Playwright against staging.

```ts
// @qa-page: dashboard
// @qa-scenario: ACTIVE

import { expect, test } from "@playwright/test";

test.describe("Dashboard - Active subscription", () => {
  // @qa-live-policy: readonly
  test("shows the user plan name in the header", async ({ page }) => {
    await expect(page.getByTestId("plan-name")).toBeVisible();
  });

  // @qa-live-policy: mock-judgment
  test("shows health score on dashboard", async ({ page }) => {
    await expect(page.getByTestId("health-score")).toBeVisible();
    await expect(page.getByTestId("health-score")).toContainText("98 pts");
    await expect(page.getByTestId("health-score-label")).toHaveText(
      "Excellent",
    );
  });
});
```

#### ② Abstracted live plan — `{page}-qa-spec-live.md`

`abstract-ai` rewrites the spec into **staging-ready QA scenarios** — short user stories Hermes can follow without replaying brittle Playwright selectors or mock literals.

```markdown
# Dashboard QA spec (Live)

## Scenario: Active subscriber on dashboard

An account with an **active paid subscription** is logged in. Pick checks that match this account state on staging.

### ACTIVE — shows the user plan name in the header

Given the user has an active subscription and is on `/dashboard`  
When I inspect the page header without mutating anything  
Then the current plan name is visible to the user

### ACTIVE — shows health score on dashboard

Given the health widget is backed by mocked API data in CI (`98 pts`, label `Excellent`)  
When I view the health-score area in read-only mode  
Then a numeric score with its unit and a readable status label are shown — exact mock values are not required; if the widget is loading, empty, or shows only qualitative copy without a score, treat as ambiguous
```

Mock literals from CI (`98 pts`, `Excellent`, etc.) become **intent-based Then** lines. When live staging is unclear — not clearly broken, but not clearly good either — Hermes returns `manual_review` instead of forcing pass or fail.

#### ③ Judge verdict — `{page}-hermes-judgment.md`

Hermes logs into staging, opens the target page, runs applicable checks from the plan, and writes a markdown report.

```markdown
# Hermes QA Judgment — dashboard

- Status: **manual_review**
- Mode: `browse`
- Page: `/dashboard`
- Source: hermes-agent

## Summary

1 check passed, 1 needs human review for ACTIVE account on staging.

## Checks

| Result        | Item                                   | Detail                                                                                                                         |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| pass          | shows the user plan name in the header | Header shows plan label "Pro".                                                                                                 |
| manual_review | shows health score on dashboard        | Widget is visible but shows label "Good" with no numeric score; cannot confirm score intent without account-specific baseline. |

## Evidence

- Logged in as qa@example.com
- Target: /dashboard
- Matched scenario: ACTIVE
- Screenshot: health-score widget shows qualitative label only

## Recommended action

Confirm whether ACTIVE staging accounts should display a numeric health score, or if a label-only state is acceptable.
```

The first check is a straightforward readonly pass. The second stays out of `fail` because the widget is present and plausible — but Hermes escalates when mock-backed intent cannot be confirmed with enough confidence.

---

## Table of Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [Command flow](#command-flow)
- [Recommended workflow](#recommended-workflow)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Annotations](#annotations)
- [Output files](#output-files)
- [Prerequisites](#prerequisites)
- [Limits](#limits)

## Why this exists

Deterministic Playwright tests are best kept in CI. They are fast, stable, repeatable, and good at checking mocked UI states.

But mocked E2E tests do not fully answer whether a staging or production-like page still behaves correctly with real data, real routing, real copy, real DOM state, and real deployment conditions.

Production is non-deterministic. Data changes, feature flags drift, copy changes, backend latency varies, third-party services fail, and the visible UI can differ between runs. This library exists because live QA needs judgment and evidence, not only deterministic assertions.

`playwright-spec-for-AI-Agent` bridges that gap:

- keep Playwright specs as the source of QA intent
- avoid running brittle Playwright flows directly against staging
- let an AI agent inspect the live page and judge whether the user-facing scenario still holds
- escalate ambiguous results as `manual_review`

It is a live staging/production-like judgment layer, not a replacement for normal tests.

## What it does

The CLI:

1. Parses Playwright specs with `@qa-scenario` comments.
2. Writes structured QA scenario artifacts.
3. Asks Hermes Agent to abstract the scenario into a live QA plan.
4. Uses Hermes Agent to log into staging and inspect the target page.
5. Produces `pass`, `fail`, `manual_review`, or `skip`.
6. Optionally posts fail/manual-review results to Slack.

## Command flow

```text
spec -> abstract-ai -> judge -> review -> slack (optional)
```

| Command       | Purpose                                                 |
| ------------- | ------------------------------------------------------- |
| `spec`        | Parse `*.spec.ts` files into QA scenario JSON.          |
| `abstract-ai` | Ask Hermes to write a live Given/When/Then plan.        |
| `judge`       | Ask Hermes to inspect staging and judge the scenario.   |
| `review`      | Ask Hermes to review judgment quality without browsing. |
| `slack`       | Send fail/manual-review verdicts to Slack.              |
| `nightly`     | Run the full pipeline.                                  |

## Recommended workflow

| Stage        | Check                                  | Purpose                                |
| ------------ | -------------------------------------- | -------------------------------------- |
| PR           | Mocked Playwright E2E                  | Stable UI regression checks.           |
| PR / Nightly | API contract tests                     | Prevent mock/API drift.                |
| Nightly      | `playwright-spec-for-ai-agent nightly` | AI-assisted live staging judgment.     |
| Release      | Selected live scenarios                | Human or AI-assisted smoke validation. |

```text
Mocked E2E = stable UI-state verification
API contract tests = real API schema guardrail
playwright-spec-for-AI-Agent = live staging QA judgment
```

## Quick start

Run from your app repo root, where Playwright specs live.

AI agent install prompt:

```text
Install and wire up playwright-spec-for-ai-agent in this app repo.

Reference README:
https://www.npmjs.com/package/playwright-spec-for-ai-agent

Use the README above as the source of truth for install steps, config shape, annotations, live policies, and safety rules.

Tasks:
1. Check where Playwright specs live and identify one page to start with.
2. Add playwright-spec-for-ai-agent as a dev dependency:
   npm install -D playwright-spec-for-ai-agent
3. Add package scripts for qa:spec, qa:judge, qa:slack, and qa:nightly.
4. Create playwright-spec-for-ai-agent.config.mjs with this app's specDir, staging.baseUrl, and per-page pageUrl or targetPath.
5. Add STAGING_QA_EMAIL and STAGING_QA_PASSWORD to the env setup or document them for CI secrets when the page requires login (base URL can live in config instead of STAGING_QA_BASE_URL).
6. Add file-level @qa-page and @qa-scenario annotations at the top of the first spec file.
7. Add @qa-live-policy above each test, and @qa-fixture above each test that uses a fixture file.
8. Run qa:spec for the selected page and show me the generated QA artifact paths.

Do not run destructive staging flows. Use safe-interaction-no-confirm, subscription-mutation, auth-mock, or skip when needed.
```

```bash
npx playwright-spec-for-ai-agent spec --page=dashboard
```

Install for team usage:

```bash
npm install -D playwright-spec-for-ai-agent
```

Add scripts:

```json
{
  "scripts": {
    "qa:spec": "playwright-spec-for-ai-agent spec",
    "qa:judge": "playwright-spec-for-ai-agent judge",
    "qa:slack": "playwright-spec-for-ai-agent slack",
    "qa:nightly": "playwright-spec-for-ai-agent nightly"
  }
}
```

Pass CLI flags after `--`:

```bash
npm run qa:spec -- --page=billing
```

Run a page pipeline:

```bash
npx playwright-spec-for-ai-agent spec --page=pricing
npx playwright-spec-for-ai-agent abstract-ai --page=pricing
npx playwright-spec-for-ai-agent judge --page=pricing
npx playwright-spec-for-ai-agent review --page=pricing
```

When `pages.pricing.targetPath` (or `pageUrl`) is set in config, `judge` does not need `--target-path`. Override with `--target-path=/custom` when needed.

Run nightly with Slack:

```bash
npx playwright-spec-for-ai-agent nightly --page=pricing --with-slack --non-interactive
```

## Configuration

Copy the example config into your app repo:

```bash
cp node_modules/playwright-spec-for-ai-agent/playwright-spec-for-ai-agent.config.example.mjs playwright-spec-for-ai-agent.config.mjs
```

Example:

```js
export default {
  paths: {
    specDir: "tests/e2e/{page}",
  },
  staging: {
    baseUrl: "https://staging.your-app.com",
    loginPath: "/login",
    authRequired: true,
    expectedSubscriptionStatus: "INACTIVE",
    expectedPlan: "BASIC",
    accountNotes: "QA account on staging — do not mutate billing",
  },
  pages: {
    dashboard: {
      pageUrl: "https://staging.your-app.com/dashboard",
      expectedSubscriptionStatus: "ACTIVE",
    },
    billing: {
      targetPath: "/settings/billing",
    },
    pricing: {
      targetPath: "/pricing",
      authRequired: false,
    },
  },
};
```

| Field                                     | Purpose                                                           |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `paths.specDir`                           | Where Playwright specs for `{page}` live.                         |
| `staging.baseUrl`                         | Staging origin used by `judge` (unless env/CLI overrides).        |
| `staging.loginPath`                       | Login path relative to `baseUrl`.                                 |
| `staging.authRequired`                    | Set `false` when pages can be judged without logging in.          |
| `staging.expectedSubscriptionStatus`      | Default `@qa-scenario` expectation for Hermes.                    |
| `pages.{page}.pageUrl`                    | Full URL Hermes opens for that page (highest priority after CLI). |
| `pages.{page}.targetPath`                 | Path joined with `staging.baseUrl` when `pageUrl` is not set.     |
| `pages.{page}.authRequired`               | Per-page override for public or no-login pages.                   |
| `pages.{page}.expectedSubscriptionStatus` | Per-page override of staging account expectations.                |

Legacy `targetPaths.{page}` still works; prefer `pages.{page}.targetPath` or `pageUrl` for new configs.

Output artifacts default to `src/page/{page}/__QA__/`. Override with `paths.outputDir`, `pages.{page}.outputDir`, or `--output-dir=`.

Set staging credentials with environment variables:

```bash
STAGING_QA_EMAIL=qa@your-company.com
STAGING_QA_PASSWORD=your-staging-password
```

`STAGING_QA_BASE_URL` and `--base-url=` still override `staging.baseUrl` when set.

Prefer environment variables or CI secrets over `--password=...`, because shell history can leak CLI flags.

### Login fields

When `authRequired` is `true` (the default), Hermes receives `loginPath`, `STAGING_QA_EMAIL`, and `STAGING_QA_PASSWORD`, then logs in through the browser before judging the target page. Make the login form easy to identify with normal accessible markup plus stable QA attributes:

```html
<label for="qa-login-email">Email</label>
<input
  id="qa-login-email"
  data-qa="login-email"
  name="email"
  type="email"
  autocomplete="username"
/>

<label for="qa-login-password">Password</label>
<input
  id="qa-login-password"
  data-qa="login-password"
  name="password"
  type="password"
  autocomplete="current-password"
/>

<button type="submit">Log in</button>
```

The important tags are the email input (`type="email"`, `name="email"`, `autocomplete="username"`, optional `data-qa="login-email"`), the password input (`type="password"`, `name="password"`, `autocomplete="current-password"`, optional `data-qa="login-password"`), and a visible submit button. The library does not require a hard-coded selector, but these attributes make agent login much more reliable.

If the target page does not require login, set `authRequired` to `false` and do not send staging credentials:

```js
export default {
  staging: {
    baseUrl: "https://staging.your-app.com",
    authRequired: false,
  },
  pages: {
    pricing: {
      targetPath: "/pricing",
      authRequired: false,
    },
  },
};
```

You can also pass it for a single run:

```bash
npx playwright-spec-for-ai-agent judge --page=pricing --auth-required=false
```

Or in CI:

```bash
STAGING_QA_AUTH_REQUIRED=false npx playwright-spec-for-ai-agent judge --page=pricing --non-interactive
```

### Interactive `judge`

When stdin is a TTY and `CI` is not set, `judge` prompts for credentials and target confirmation before browsing.

If config already defines the target URL, the prompt shows that URL. Answer **Y** to proceed, or **n** to enter a different full URL or path (for example `/ko` or `https://staging.your-app.com/ko`).

Use `--non-interactive`, `--yes`, or `-y` to skip prompts (required for CI and `nightly`).

## Annotations

Add annotations directly inside Playwright spec files.

Supported annotations:

| Annotation                                            | Scope                | Purpose                                                                                                                                    |
| ----------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `// @qa-page: billing`                                | File                 | Optional page id override.                                                                                                                 |
| `// @qa-scenario: ACTIVE`                             | File                 | Required QA scenario id or intent label.                                                                                                   |
| `// @qa-live-skip: true`                              | File                 | Skip this scenario in live QA.                                                                                                             |
| `// @qa-always-run: true`                             | File                 | Keep the scenario eligible even when default filtering would skip it.                                                                      |
| `// @qa-fixture: avatar=tests/fixtures/qa-avatar.png` | `test`               | Name a fixture file used by this specific test. Add it above each test that needs the fixture.                                             |
| `// @qa-live-policy: readonly`                        | `test` or `describe` | Tell live QA how safely this test can be judged. Add it above each test; use `describe` only when every child test shares the same policy. |

File-level annotations should be placed at the top of the spec file, before imports:

```ts
// @qa-page: billing
// @qa-scenario: ACTIVE
// @qa-live-skip: true
// @qa-always-run: true

import { expect, test } from "@playwright/test";
```

Supported `@qa-live-policy` values:

| Value                         | Meaning                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `readonly`                    | Safe read-only verification.                                                                              |
| `safe-interaction`            | Safe interaction is allowed.                                                                              |
| `safe-interaction-no-confirm` | Interaction is allowed, but final confirmation/destructive submit should not be clicked.                  |
| `mock-judgment`               | Original test depends on mocked API state; Hermes should judge whether live UI reasonably matches intent. |
| `subscription-mutation`       | Subscription or billing mutation; block live execution and treat as unsafe for staging automation.        |
| `auth-mock`                   | Auth is mocked in the Playwright test; block direct live execution.                                       |
| `skip`                        | Explicitly skip live QA for this test.                                                                    |

Minimal annotation:

```ts
// @qa-scenario: A billing user can see the inactive subscription state
```

Test-level annotations:

```ts
// Put these above each test.
// @qa-live-policy: readonly
// @qa-fixture: avatar=tests/fixtures/qa-avatar.png
```

Example Playwright spec:

```ts
// @qa-page: billing
// @qa-scenario: A billing user can see the inactive subscription state

import { expect, test } from "@playwright/test";

// @qa-live-policy: readonly
// @qa-fixture: avatar=tests/fixtures/qa-avatar.png
test("shows inactive billing state", async ({ page }) => {
  await page.goto("/settings/billing");

  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  await expect(page.getByText("Inactive subscription")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade" })).toBeVisible();
});
```

Example with a live policy:

```ts
// @qa-page: billing
// @qa-scenario: CANCEL_SUBSCRIPTION

import { expect, test } from "@playwright/test";

test.describe("Billing cancellation", () => {
  // @qa-live-policy: safe-interaction-no-confirm
  test("opens the cancellation confirmation dialog", async ({ page }) => {
    await page.goto("/settings/billing");
    await page.getByRole("button", { name: "Cancel subscription" }).click();

    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Confirm cancellation" }),
    ).toBeVisible();
  });
});
```

The CLI reads the spec as source material. It does not run Playwright against staging.

## Output files

Default paths:

```text
src/page/{page}/__tests__/*.spec.ts
src/page/{page}/__QA__/
```

Common output files:

```text
{page}-qa-spec.json
{page}-qa-spec-abstracted.json
{page}-qa-spec-live.json
{page}-qa-spec-live.md
{page}-qa-judge-plan.md
{page}-hermes-judgment.json
{page}-hermes-judgment.md
{page}-hermes-raw-output.txt
```

## Prerequisites

- Node.js 20+
- Playwright specs in the app repo
- Hermes Agent installed and configured
- Staging credentials for `judge` and `nightly` when `authRequired` is not `false`

Install Hermes Agent:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
  | bash -s -- --skip-setup --skip-browser
```

Hermes needs an inference model in `~/.hermes/config.yaml` or `HERMES_INFERENCE_MODEL`.

### Switching the AI agent backend

Hermes is the default, but every stage (`abstract-ai`, `judge`, `review`) calls the agent
through an adapter, so the backend is swappable per run:

```bash
QA_AI_ADAPTER=aside npx playwright-spec-for-ai-agent judge --page=dashboard
```

Supported adapters:

- `hermes` (default) — Hermes Agent, stateless ephemeral home, toolsets disabled per mode
- `aside` — [Aside Browser](https://aside.app) CLI (`aside exec`); model and effort come from
  Aside user settings unless overridden with `ASIDE_QA_MODEL` / `ASIDE_QA_EFFORT`

Aside caveats: no max-turns or toolset-disable flags (text-only stages rely on the prompt's
"do not use tools" instruction), and the judge's pre-authenticated CDP attach is Hermes-only —
Aside drives its own browser and performs the staging login itself.

Adding a backend = one runner module exporting `(query, maxTurns, options) -> JSON` plus one
entry in the adapter table in `scripts/ai-agent-adapter.mjs`.

## Limits

This tool is not:

- a replacement for deterministic Playwright CI
- a replacement for API contract tests
- a deterministic production test runner
- safe for destructive flows unless explicitly marked as skipped or safe
- guaranteed to catch backend regressions that do not affect visible UI, DOM, screenshots, navigation, or user-facing copy
- a full QA engineer replacement

It automates the first-pass live staging judgment layer and escalates uncertain cases.
