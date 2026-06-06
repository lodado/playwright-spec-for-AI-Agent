# playwright-spec-for-AI-Agent

AI-assisted live staging QA for web apps that already have Playwright specs.

This tool reads Playwright `*.spec.ts` files, extracts `@qa-scenario` intent, turns it into structured QA scenarios, and uses [Hermes Agent](https://github.com/NousResearch/hermes-agent) to validate the same intent against a staging page.

Hermes Agent is used here as the adapter layer for multiple agents. The CLI keeps the project-specific QA flow stable, while Hermes handles agent execution, browser access, model calls, and judgment/review steps through its agent adapters.

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
4. Create playwright-spec-for-ai-agent.config.mjs with this app's specDir, outputDir, and targetPaths.
5. Add STAGING_QA_EMAIL, STAGING_QA_PASSWORD, and STAGING_QA_BASE_URL to the env setup or document them for CI secrets.
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
npx playwright-spec-for-ai-agent judge --page=pricing --target-path=/pricing
npx playwright-spec-for-ai-agent review --page=pricing
```

Run nightly with Slack:

```bash
npx playwright-spec-for-ai-agent nightly --page=pricing --with-slack --non-interactive
```

## Configuration

Copy the example config into your app repo:

```bash
cp playwright-spec-for-ai-agent.config.example.mjs playwright-spec-for-ai-agent.config.mjs
```

Example:

```js
export default {
  paths: {
    specDir: "tests/e2e/{page}",
    outputDir: ".qa/{page}",
  },
  staging: {
    expectedSubscriptionStatus: "INACTIVE",
  },
  targetPaths: {
    billing: "/settings/billing",
    dashboard: "/dashboard",
  },
};
```

Set staging credentials with environment variables:

```bash
STAGING_QA_EMAIL=qa@your-company.com
STAGING_QA_PASSWORD=your-staging-password
STAGING_QA_BASE_URL=https://staging.your-app.com
```

Prefer environment variables or CI secrets over `--password=...`, because shell history can leak CLI flags.

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
- Staging credentials for `judge` and `nightly`

Install Hermes Agent:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
  | bash -s -- --skip-setup --skip-browser
```

Hermes needs an inference model in `~/.hermes/config.yaml` or `HERMES_INFERENCE_MODEL`.

## Limits

This tool is not:

- a replacement for deterministic Playwright CI
- a replacement for API contract tests
- a deterministic production test runner
- safe for destructive flows unless explicitly marked as skipped or safe
- guaranteed to catch backend regressions that do not affect visible UI, DOM, screenshots, navigation, or user-facing copy
- a full QA engineer replacement

It automates the first-pass live staging judgment layer and escalates uncertain cases.
