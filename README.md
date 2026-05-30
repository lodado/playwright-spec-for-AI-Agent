# hermes-qa

AI-powered staging QA pipeline for web apps with Playwright test suites.

Parses your existing `*.spec.ts` files, collects read-only evidence from staging, and asks [Hermes Agent](https://github.com/NousResearch/hermes-agent) to judge each test case against the live DOM — without mutating any data.

```
qa:spec → qa:run (optional) → qa:judge → qa:slack (optional)
```

| Step       | What it does                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| `qa:spec`  | Parses `*.spec.ts` files annotated with `@qa-scenario` into a JSON + Markdown spec                           |
| `qa:run`   | Logs into staging with Playwright and collects read-only evidence (screenshot, visible text, console errors) |
| `qa:judge` | Sends evidence + spec to Hermes Agent for a pass / fail / manual_review verdict                              |
| `qa:slack` | Posts the verdict to a Slack webhook on failure or manual review                                             |

---

## Prerequisites

- Node.js 20+
- [Playwright](https://playwright.dev) (`@playwright/test`)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) CLI installed and configured

```bash
# Install Playwright browser
npx playwright install chromium

# Install Hermes Agent
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
  | bash -s -- --skip-setup --skip-browser
```

Hermes also needs an inference model configured in `~/.hermes/config.yaml`, or via `HERMES_INFERENCE_MODEL` env var.

---

## Installation

Copy `scripts/` into your project root and add the npm scripts to your `package.json`:

```json
{
  "scripts": {
    "qa:spec": "node scripts/extract-page-e2e-spec.mjs",
    "qa:run": "node scripts/run-staging-page-ai-qa.mjs",
    "qa:judge": "node scripts/run-hermes-page-judge.mjs",
    "qa:slack": "node scripts/slack-page-qa-report.mjs",
    "qa:nightly": "node scripts/run-page-qa-nightly.mjs"
  }
}
```

Copy `.env.example` to `.env` and fill in your values.

---

## Annotating your spec files

Add file-level and test-level annotations to your existing Playwright specs.

### File-level annotations

```ts
// @qa-scenario: ACTIVE          — which account state this file covers
// @qa-live-skip: true           — exclude this file from live Hermes runs
// @qa-always-run: true          — run regardless of live account state (e.g. BVA tests)
```

### Per-test `@qa-live-policy`

Every `test()` in an annotated file needs a live policy — place it directly above the test or the enclosing `test.describe`:

| Annotation                    | Hermes behavior on live staging                                      |
| ----------------------------- | -------------------------------------------------------------------- |
| `readonly`                    | DOM assertions only, no clicks                                       |
| `safe-interaction`            | Opens dialogs / toggles; dismisses with Esc — never clicks confirm   |
| `safe-interaction-no-confirm` | Same as above; even if the mock test clicks confirm, Hermes must not |
| `mock-judgment`               | Skips `page.route` replay; Hermes judges intent against live DOM     |
| `subscription-mutation`       | Skipped (would change billing state)                                 |
| `auth-mock`                   | Skipped (requires mocked 401 flow)                                   |

Example:

```ts
// @qa-scenario: ACTIVE

import { expect, test } from "@playwright/test";

// @qa-live-policy: readonly
test("shows plan name in header", async ({ page }) => {
  await expect(page.getByTestId("plan-name")).toBeVisible();
});

// @qa-live-policy: safe-interaction
test.describe("when subscription history button is clicked", () => {
  test("opens the history dialog", async ({ page }) => {
    await page.getByTestId("subscription-history-btn").click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});

// @qa-live-policy: subscription-mutation
test("cancels subscription", async ({ page }) => {
  // Blocked on live — Hermes skips this
});
```

See `examples/sample-spec.ts` for a complete example.

---

## Usage

### Pricing page (browse mode — no Playwright run needed)

```bash
# 1. Generate QA spec
node scripts/extract-page-e2e-spec.mjs --page=pricing

# 2. Hermes browses staging and judges live DOM directly
node scripts/run-hermes-page-judge.mjs --page=pricing --target-path=/pricing

# 3. View results
open src/page/pricing/__QA__/pricing-hermes-judgment.md
```

### Dashboard page (artifact mode — Playwright collects evidence first)

```bash
# 1. Generate QA spec
node scripts/extract-page-e2e-spec.mjs --page=dashboard

# 2. Playwright read-only evidence collection
node scripts/run-staging-page-ai-qa.mjs --page=dashboard

# 3. Hermes judges the collected artifacts
node scripts/run-hermes-page-judge.mjs --page=dashboard

# 4. View results
open src/page/dashboard/__QA__/dashboard-hermes-judgment.md
```

### One-liner nightly run

```bash
# With Playwright run + Slack notification
node scripts/run-page-qa-nightly.mjs --page=dashboard --with-slack

# Browse mode only (no Playwright run)
node scripts/run-page-qa-nightly.mjs --page=pricing --target-path=/pricing --with-slack
```

---

## Judge modes

`qa:judge` auto-selects mode unless `--mode=` is set:

| Condition                       | Mode selected   |
| ------------------------------- | --------------- |
| `{page}-run-result.json` exists | `artifact`      |
| No run result                   | `browse`        |
| `--mode=artifact`               | forced artifact |
| `--mode=browse`                 | forced browse   |

**Artifact mode** — Hermes reads Playwright evidence (screenshot, visible text, errors) and judges against the spec.

**Browse mode** — Hermes logs into staging, navigates to the target page, inspects the live DOM, and runs each test case directly.

---

## CLI options

| Option                                                                        | Required      | Description                                                            |
| ----------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------- |
| `--page=`                                                                     | Yes           | Page slug, e.g. `dashboard`, `pricing`                                 |
| `--target-path=`                                                              | Per page      | Staging path. Defaults: `dashboard → /dashboard`, `pricing → /pricing` |
| `--mode=browse\|artifact`                                                     | No            | Override Hermes judge mode                                             |
| `--email=` / `STAGING_QA_EMAIL`                                               | For run/judge | Staging login email                                                    |
| `--password=` / `STAGING_QA_PASSWORD`                                         | For run/judge | Staging login password                                                 |
| `--expected-plan=` / `STAGING_QA_EXPECTED_PLAN`                               | No            | Expected plan name                                                     |
| `--expected-subscription-status=` / `STAGING_QA_EXPECTED_SUBSCRIPTION_STATUS` | No            | Expected subscription state                                            |
| `--account-notes=` / `STAGING_QA_ACCOUNT_NOTES`                               | No            | Free-text note forwarded to Hermes                                     |
| `--base-url=` / `STAGING_QA_BASE_URL`                                         | No            | Staging origin                                                         |
| `QA_OUTPUT_DIR`                                                               | No            | Override output directory                                              |
| `SLACK_WEBHOOK_URL`                                                           | For slack     | Slack incoming webhook                                                 |

---

## Output files

Default output directory: `src/page/{page}/__QA__/`

| Step  | Files                                                                     |
| ----- | ------------------------------------------------------------------------- |
| spec  | `{page}-qa-spec.json`, `{page}-qa-spec.md`                                |
| run   | `{page}-run-result.json`, `{page}-run-report.md`, `{page}-screenshot.png` |
| judge | `{page}-hermes-judgment.json`, `{page}-hermes-judgment.md`                |
| debug | `{page}-hermes-query.txt`, `{page}-hermes-raw-output.txt`                 |

`*-hermes-query.txt` and `*-hermes-raw-output.txt` are for debugging Hermes failures. Passwords and API keys are redacted before writing.

---

## Status aggregation (browse mode)

The local normalizer re-derives the overall status from `checks[]`, ignoring Hermes's top-level status field to prevent false passes:

| `checks[]` content            | Final status    |
| ----------------------------- | --------------- |
| Any `fail`                    | `fail`          |
| Any `manual_review` or `skip` | `manual_review` |
| Empty array                   | `manual_review` |
| All `pass`                    | `pass`          |

---

## GitHub Actions

Example nightly workflow: `.github/workflows/nightly-qa.yml`

Required secrets:

```
STAGING_QA_EMAIL
STAGING_QA_PASSWORD
SLACK_WEBHOOK_URL
```

The `qa:run` and `qa:judge` steps use `continue-on-error: true` so Slack notification and artifact upload always run. The workflow fails at the end if either step failed.

---

## Adapting to your app

1. **Spec directory** — scripts look for `*.spec.ts` in `src/page/{page}/__tests__/` by default. Override with `--spec-dir=`.
2. **Login flow** — edit `run-staging-page-ai-qa.mjs` to match your app's login form selectors.
3. **Plan/status detection** — `dashboard-spec-parser.mjs` `liveTextLocatorForLive()` contains a regex for username/plan copy. Update it to match your app's text.
4. **Confirm button names** — `detectSubscriptionMutation()` checks for button names that indicate destructive actions. Add your app's button copy there.
5. **Target paths** — set `DEFAULT_TARGET_PATHS` in `page-qa-paths.mjs` or pass `--target-path=` per run.

---

## Troubleshooting

| Symptom                                 | Cause                            | Fix                                                       |
| --------------------------------------- | -------------------------------- | --------------------------------------------------------- |
| `Missing --page=`                       | Missing page argument            | Pass `--page=pricing` after `--` when using npm scripts   |
| `Missing staging QA credentials`        | No email/password                | Set env vars or pass `--email=` `--password=`             |
| `Missing {page}-qa-spec.md`             | spec step not run                | Run `qa:spec` first                                       |
| `Missing {page}-run-result.json`        | artifact mode but no run         | Run `qa:run` first, or use `--mode=browse`                |
| Playwright browser missing              | Chromium not installed           | `npx playwright install chromium`                         |
| `Hermes did not return a JSON decision` | Hermes exited without JSON       | Check `{page}-hermes-raw-output.txt`                      |
| `checks[]` table is empty               | Hermes returned no per-test rows | Browse mode result is `manual_review`; inspect raw output |

---

## License

MIT
