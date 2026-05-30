# playwright-spec-qa

AI-powered staging QA pipeline for web apps with Playwright test suites.

Parses your existing `*.spec.ts` files, collects read-only evidence from staging, and asks [Hermes Agent](https://github.com/NousResearch/hermes-agent) to judge each test case against the live DOM — without mutating any data.

**You do not copy `scripts/` into your app.** Run everything with `npx` from your repo root.

```
spec → run (optional) → judge → slack (optional)
```

| Command   | What it does                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `spec`    | Parses `*.spec.ts` files annotated with `@qa-scenario` into a JSON + Markdown spec                           |
| `run`     | Logs into staging with Playwright and collects read-only evidence (screenshot, visible text, console errors) |
| `judge`   | Sends evidence + spec to Hermes Agent for a pass / fail / manual_review verdict                              |
| `slack`   | Posts the verdict to a Slack webhook on failure or manual review                                             |
| `nightly` | Runs `spec` → optional `run` → `judge` → optional `slack` in one command                                     |

---

## Quick start with `npx`

### 1. Run from GitHub (no install)

In **your app repo root** (where Playwright specs live):

```bash
npx github:lodado/playwright-spec-for-AI-Agent spec --page=dashboard
```

After the package is published to npm, you can use the shorter name:

```bash
npx playwright-spec-qa spec --page=dashboard
```

### 2. Install as a dev dependency (recommended for teams)

```bash
npm install -D playwright-spec-qa playwright
npx playwright install chromium
```

Add scripts to your app's `package.json`:

```json
{
  "scripts": {
    "qa:spec": "playwright-spec-qa spec",
    "qa:run": "playwright-spec-qa run",
    "qa:judge": "playwright-spec-qa judge",
    "qa:slack": "playwright-spec-qa slack",
    "qa:nightly": "playwright-spec-qa nightly"
  }
}
```

When using npm scripts, pass CLI flags after `--`:

```bash
npm run qa:spec -- --page=billing
```

### 3. Set staging credentials

Copy env vars from this repo's [`.env.example`](./.env.example) into your app's `.env` (or export in the shell / CI secrets):

```bash
STAGING_QA_EMAIL=qa@your-company.com
STAGING_QA_PASSWORD=your-staging-password
STAGING_QA_BASE_URL=https://staging.your-app.com
```

`run` and `judge` need email/password. `spec` does not.

### 4. Point at your spec and output folders

By default the CLI looks for specs at `src/page/{page}/__tests__/` and writes QA artifacts to `src/page/{page}/__QA__/`.

If your layout is different (e.g. billing specs under `tests/e2e/billing/`), use **either** a config file **or** CLI flags.

**Option A — config file (best for multiple pages)**

Copy [`hermes-qa.config.example.mjs`](./hermes-qa.config.example.mjs) to your app as `hermes-qa.config.mjs`:

```js
export default {
  paths: {
    specDir: "tests/e2e/{page}",
    outputDir: ".qa/{page}",
  },
  targetPaths: {
    billing: "/settings/billing",
    dashboard: "/dashboard",
  },
  playwrightRunPages: ["dashboard"],
  pages: {
    billing: {
      targetPath: "/settings/billing",
      playwrightRun: false,
    },
  },
};
```

**Option B — CLI only (good for one-off runs)**

```bash
npx playwright-spec-qa spec --page=billing \
  --spec-dir=tests/e2e/{page} \
  --output-dir=.qa/{page} \
  --project-root=. \
  --config=./hermes-qa.config.mjs
```

| Flag                              | Meaning                                                   |
| --------------------------------- | --------------------------------------------------------- |
| `--page=billing`                  | Page id; replaces `{page}` in path templates              |
| `--spec-dir=tests/e2e/{page}`     | Folder with `*.spec.ts` (must include `// @qa-scenario:`) |
| `--output-dir=.qa/{page}`         | Where JSON/MD/screenshots are written                     |
| `--project-root=.`                | Your app root (defaults to cwd or config file directory)  |
| `--config=./hermes-qa.config.mjs` | Explicit config; otherwise searched upward from cwd       |

Resolved paths for `--page=billing`:

- Specs: `./tests/e2e/billing/*.spec.ts`
- Output: `./.qa/billing/billing-qa-spec.json`, `billing-hermes-judgment.md`, etc.

Placeholders: `{page}` = `--page=` value, `{root}` = project root.

### 5. Annotate Playwright specs

See [Annotating your spec files](#annotating-your-spec-files). At minimum each file needs `// @qa-scenario:` and each test needs `// @qa-live-policy:`.

### 6. Run the pipeline

**Billing (browse mode — Hermes checks live staging, no Playwright run):**

```bash
# 1) Build spec from tests
npx playwright-spec-qa spec --page=billing \
  --spec-dir=tests/e2e/{page} \
  --output-dir=.qa/{page} \
  --project-root=. \
  --config=./hermes-qa.config.mjs

# 2) Judge on staging (needs credentials + target path)
npx playwright-spec-qa judge --page=billing \
  --target-path=/settings/billing \
  --spec-dir=tests/e2e/{page} \
  --output-dir=.qa/{page} \
  --project-root=. \
  --config=./hermes-qa.config.mjs

# 3) Open report
open .qa/billing/billing-hermes-judgment.md
```

If `targetPath` is set in `hermes-qa.config.mjs` under `pages.billing` or `targetPaths.billing`, you can omit `--target-path=`.

**Dashboard (artifact mode — Playwright collects evidence, then Hermes judges):**

```bash
npx playwright-spec-qa spec --page=dashboard
npx playwright-spec-qa run --page=dashboard
npx playwright-spec-qa judge --page=dashboard
```

**Full nightly (spec + run + judge + Slack):**

```bash
npx playwright-spec-qa nightly --page=dashboard --with-slack --non-interactive
```

Flags for `nightly`:

- `--with-run` — force Playwright run even if page is not in `playwrightRunPages`
- `--without-run` — skip Playwright (browse-only judge)
- `--with-slack` — notify on fail / manual_review

### 7. Example repo layout

```
your-app/
├── hermes-qa.config.mjs      # optional paths + targetPaths
├── .env                      # STAGING_QA_* credentials
├── tests/e2e/
│   └── billing/
│       └── billing.spec.ts   # // @qa-scenario: ACTIVE
└── .qa/
    └── billing/              # generated (gitignore this)
        ├── billing-qa-spec.json
        ├── billing-qa-spec.md
        └── billing-hermes-judgment.md
```

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

## `npx` command reference

```bash
npx playwright-spec-qa --help
npx playwright-spec-qa spec --help    # same global flags on every command
```

| Command   | Requires `--page=` | Needs credentials              | Typical use                                   |
| --------- | ------------------ | ------------------------------ | --------------------------------------------- |
| `spec`    | Yes                | No                             | Parse annotated `*.spec.ts` → JSON + Markdown |
| `run`     | Yes                | Yes                            | Playwright login + read-only staging checks   |
| `judge`   | Yes                | Yes                            | Hermes pass/fail/manual_review                |
| `slack`   | Yes                | No (needs `SLACK_WEBHOOK_URL`) | Notify on failure                             |
| `nightly` | Yes                | Yes (if run/judge included)    | CI / scheduled full pipeline                  |

**Install source**

| Method                | Command                                                                     |
| --------------------- | --------------------------------------------------------------------------- |
| GitHub (always works) | `npx github:lodado/playwright-spec-for-AI-Agent <command> ...`              |
| npm package           | `npx playwright-spec-qa <command> ...`                                      |
| Local dev dep         | `npm install -D playwright-spec-qa` then `playwright-spec-qa <command> ...` |

**Path & config flags** (all commands)

```bash
--page=<slug>              # required, e.g. billing, dashboard, settings/billing
--config=<path>            # hermes-qa.config.mjs (auto-discovered if omitted)
--project-root=<path>      # app root (default: cwd or config file directory)
--spec-dir=<template>      # e.g. tests/e2e/{page}
--output-dir=<template>    # e.g. .qa/{page}
--target-path=<path>       # staging URL path, e.g. /settings/billing
```

**Staging flags** (`run`, `judge`, `nightly`)

```bash
--email=<addr>             # or STAGING_QA_EMAIL
--password=<secret>        # or STAGING_QA_PASSWORD
--base-url=<origin>        # or STAGING_QA_BASE_URL
--login-path=/login        # or STAGING_QA_LOGIN_PATH
--non-interactive          # CI: no prompts
```

**Judge flags**

```bash
--mode=browse|artifact     # force mode (default: artifact if run-result exists)
```

Config file is searched upward from cwd for:

- `hermes-qa.config.mjs` / `.js` / `.cjs` / `.json`
- `playwright-spec-qa.config.mjs` / `.js` / `.cjs` / `.json`

CLI flags override config file values for that run.

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

## More usage examples

### Pricing (browse only)

```bash
npx playwright-spec-qa spec --page=pricing
npx playwright-spec-qa judge --page=pricing --target-path=/pricing
```

### Dashboard (Playwright + Hermes)

```bash
npx playwright-spec-qa spec --page=dashboard
npx playwright-spec-qa run --page=dashboard
npx playwright-spec-qa judge --page=dashboard
```

### CI one-liner

```bash
npx playwright-spec-qa nightly --page=dashboard \
  --with-slack \
  --non-interactive \
  --email="$STAGING_QA_EMAIL" \
  --password="$STAGING_QA_PASSWORD"
```

### Legacy: vendored `scripts/`

You can still copy `scripts/` into your repo and run `node scripts/extract-page-e2e-spec.mjs`. Prefer `npx` so updates do not require manual merges.

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

| Option                                                                        | Required      | Description                                                      |
| ----------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------- |
| `--page=`                                                                     | Yes           | Page slug, e.g. `dashboard`, `pricing`                           |
| `--config=`                                                                   | No            | Path to `hermes-qa.config.*` (auto-discovered from cwd upward)   |
| `--project-root=`                                                             | No            | App root (default: config file directory or cwd)                 |
| `--spec-dir=`                                                                 | No            | Spec directory template (`{page}`, `{root}`)                     |
| `--output-dir=`                                                               | No            | QA output directory template (`{page}`, `{root}`)                |
| `--target-path=`                                                              | Per page      | Staging path (or `targetPaths` / `pages.*.targetPath` in config) |
| `--mode=browse\|artifact`                                                     | No            | Override Hermes judge mode                                       |
| `--email=` / `STAGING_QA_EMAIL`                                               | For run/judge | Staging login email                                              |
| `--password=` / `STAGING_QA_PASSWORD`                                         | For run/judge | Staging login password                                           |
| `--expected-plan=` / `STAGING_QA_EXPECTED_PLAN`                               | No            | Expected plan name                                               |
| `--expected-subscription-status=` / `STAGING_QA_EXPECTED_SUBSCRIPTION_STATUS` | No            | Expected subscription state                                      |
| `--account-notes=` / `STAGING_QA_ACCOUNT_NOTES`                               | No            | Free-text note forwarded to Hermes                               |
| `--base-url=` / `STAGING_QA_BASE_URL`                                         | No            | Staging origin                                                   |
| `QA_OUTPUT_DIR`                                                               | No            | Override output directory                                        |
| `SLACK_WEBHOOK_URL`                                                           | For slack     | Slack incoming webhook                                           |

---

## Output files

Output directory = `--output-dir` template or `paths.outputDir` in config (default: `src/page/{page}/__QA__/`).

For `--page=billing` and `--output-dir=.qa/{page}`:

| Step  | Files under `.qa/billing/`                                                   |
| ----- | ---------------------------------------------------------------------------- |
| spec  | `billing-qa-spec.json`, `billing-qa-spec.md`                                 |
| run   | `billing-run-result.json`, `billing-run-report.md`, `billing-screenshot.png` |
| judge | `billing-hermes-judgment.json`, `billing-hermes-judgment.md`                 |
| debug | `billing-hermes-query.txt`, `billing-hermes-raw-output.txt`                  |

Slug rule: `--page=settings/billing` → file prefix `settings-billing-`.

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

```yaml
- run: npm install -D playwright-spec-qa playwright
- run: npx playwright install chromium
- run: npx playwright-spec-qa nightly --page=dashboard --with-slack --non-interactive
  env:
    STAGING_QA_EMAIL: ${{ secrets.STAGING_QA_EMAIL }}
    STAGING_QA_PASSWORD: ${{ secrets.STAGING_QA_PASSWORD }}
    STAGING_QA_BASE_URL: https://staging.your-app.com
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

Or without installing: `npx github:lodado/playwright-spec-for-AI-Agent nightly ...`

Required secrets: `STAGING_QA_EMAIL`, `STAGING_QA_PASSWORD`, optional `SLACK_WEBHOOK_URL`.

---

## Adapting to your app

1. **Paths** — set `paths.specDir` / `paths.outputDir` in `hermes-qa.config.mjs`, or pass `--spec-dir=` / `--output-dir=`.
2. **Login flow** — fork or patch `run-staging-page-ai-qa.mjs` login selectors for your app (when vendoring scripts).
3. **Plan/status detection** — update `dashboard-spec-parser.mjs` `liveTextLocatorForLive()` regex for your UI copy.
4. **Confirm button names** — extend `detectSubscriptionMutation()` with your destructive-action button labels.
5. **Target paths** — `targetPaths` / `pages.<slug>.targetPath` in config, or `--target-path=` per run.

---

## Troubleshooting

| Symptom                                 | Cause                            | Fix                                                       |
| --------------------------------------- | -------------------------------- | --------------------------------------------------------- |
| `Missing --page=`                       | Missing page argument            | Add `--page=billing` (after `--` for npm scripts)         |
| `ENOENT` / empty spec dir               | Wrong `--spec-dir`               | Check path; use `tests/e2e/{page}` and existing specs     |
| `Missing staging QA credentials`        | No email/password                | Set `.env` or `--email=` `--password=`                    |
| `Missing {page}-qa-spec.md`             | spec step not run                | Run `npx playwright-spec-qa spec --page=...` first        |
| `Missing {page}-run-result.json`        | artifact mode but no run         | Run `run` first, or `judge --mode=browse`                 |
| `npx playwright-spec-qa` not found      | Package not on npm yet           | Use `npx github:lodado/playwright-spec-for-AI-Agent`      |
| Playwright browser missing              | Chromium not installed           | `npx playwright install chromium`                         |
| `Hermes did not return a JSON decision` | Hermes exited without JSON       | Check `{page}-hermes-raw-output.txt`                      |
| `checks[]` table is empty               | Hermes returned no per-test rows | Browse mode result is `manual_review`; inspect raw output |

---

## License

MIT
