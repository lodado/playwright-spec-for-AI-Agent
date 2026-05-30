# playwright-spec-qa

AI-powered staging QA pipeline for web apps with Playwright test suites.

Parses your existing `*.spec.ts` files, then [Hermes Agent](https://github.com/NousResearch/hermes-agent) logs into staging, opens each target page, and judges tests against the **live DOM** — without mutating billing or subscription state.

**You do not copy `scripts/` into your app.** Run everything with `npx` from your repo root.

## Why this exists

It turns Playwright specs from deterministic test scripts into AI-readable QA scenarios for live staging validation.


1. **Real E2E on live/staging matters**
   Mocked Playwright runs are useful, but they don’t prove the app actually works in production-like conditions.

2. **Live E2E without mocks is inherently non-deterministic**
   Account state, billing status, remaining credits, feature flags, and third-party data can change what “pass” should look like.

3. **Larger teams usually solve this with QA engineers**
   QA engineers choose safe scenarios, avoid destructive actions, interpret ambiguous UI states, and decide whether a result is a real failure.

4. **Startups often don’t have a dedicated QA role**
   Instead of building a full QA process from scratch, we can reuse existing Playwright specs as structured intent and let an AI agent inspect the live DOM, screenshots, and test context.

5. **This tool wires that flow together**
   `Playwright spec` → extracted `spec` as JSON/MD → **Hermes agent** judges staging behavior and returns `pass` / `fail` / `manual_review` / `skip`.


Annotations (`@qa-scenario`, `@qa-live-policy`, `@qa-fixture`) declare what is safe to verify on live; Hermes handles the rest.

```
spec → judge → slack (optional)
```

| Command   | What it does                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------- |
| `spec`    | Parses `*.spec.ts` files annotated with `@qa-scenario` into a JSON + Markdown spec                 |
| `judge`   | Hermes logs in, visits `--target-path`, infers scenario, returns `pass` / `fail` / `manual_review` |
| `slack`   | Posts the verdict to a Slack webhook on `fail` or `manual_review` (not on `pass`)                  |
| `nightly` | Runs `spec` → `judge` → optional `slack` in one command                                            |

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
npm install -D playwright-spec-qa
```

Add scripts to your app's `package.json`:

```json
{
  "scripts": {
    "qa:spec": "playwright-spec-qa spec",
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

Prefer **environment variables** (or CI secrets) over `--password=` on the command line — shell history and process lists can leak CLI flags.

`judge` and `nightly` need staging email/password. `spec` does not.

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
  staging: {
    expectedSubscriptionStatus: "INACTIVE",
    fixtures: {
      avatar: "tests/fixtures/qa-avatar.png",
    },
  },
  targetPaths: {
    billing: "/settings/billing",
    dashboard: "/dashboard",
  },
  pages: {
    billing: { targetPath: "/settings/billing" },
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
| `--output-dir=.qa/{page}`         | Where JSON/MD artifacts are written                       |
| `--project-root=.`                | Your app root (defaults to cwd or config file directory)  |
| `--config=./hermes-qa.config.mjs` | Explicit config; otherwise searched upward from cwd       |

Resolved paths for `--page=billing`:

- Specs: `./tests/e2e/billing/*.spec.ts`
- Output: `./.qa/billing/billing-qa-spec.json`, `billing-hermes-judgment.md`, etc.

Placeholders: `{page}` = `--page=` value, `{root}` = project root.

### 5. Annotate Playwright specs

See [Annotating your spec files](#annotating-your-spec-files). At minimum:

- each file: `// @qa-scenario:`
- each test: `// @qa-live-policy:`
- upload tests (optional): `// @qa-fixture: name=tests/fixtures/file.png`

### 6. Run the pipeline

**Any page (pricing, dashboard, billing, …):**

```bash
npx playwright-spec-qa spec --page=pricing
npx playwright-spec-qa judge --page=pricing --target-path=/pricing

open .qa/pricing/pricing-hermes-judgment.md
```

If `targetPath` is set in `hermes-qa.config.mjs`, you can omit `--target-path=`.

**Nightly + Slack:**

```bash
npx playwright-spec-qa nightly --page=pricing --with-slack --non-interactive
```

### 7. Example repo layout

```
your-app/
├── hermes-qa.config.mjs      # paths, targetPaths, staging fixtures
├── .env                      # STAGING_QA_* credentials (gitignored)
├── tests/
│   ├── fixtures/
│   │   └── qa-avatar.png     # upload files for @qa-fixture / setInputFiles
│   └── e2e/
│       └── billing/
│           └── billing.spec.ts   # // @qa-scenario: ACTIVE
└── .qa/
    └── billing/              # generated (gitignore this)
        ├── billing-qa-spec.json
        ├── billing-qa-spec.md
        ├── billing-hermes-judgment.json
        ├── billing-hermes-judgment.md
        └── billing-hermes-raw-output.txt   # debug only
```

---

## Prerequisites

- Node.js 20+
- [Playwright](https://playwright.dev) test specs in your app (`@playwright/test` — this tool only **reads** them)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) CLI installed and configured

```bash
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

| Command   | Requires `--page=` | Needs credentials              | Typical use                                    |
| --------- | ------------------ | ------------------------------ | ---------------------------------------------- |
| `spec`    | Yes                | No                             | Parse annotated `*.spec.ts` → JSON + Markdown  |
| `judge`   | Yes                | Yes                            | Hermes visits staging page and judges live DOM |
| `slack`   | Yes                | No (needs `SLACK_WEBHOOK_URL`) | Notify on failure                              |
| `nightly` | Yes                | Yes                            | `spec` → `judge` → optional `slack`            |

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

**Staging flags** (`judge`, `nightly`)

```bash
--email=<addr>             # or STAGING_QA_EMAIL (preferred in CI)
--password=<secret>        # or STAGING_QA_PASSWORD (prefer env over CLI)
--base-url=<origin>        # or STAGING_QA_BASE_URL
--login-path=/login        # or STAGING_QA_LOGIN_PATH
--expected-subscription-status=INACTIVE   # or STAGING_QA_EXPECTED_SUBSCRIPTION_STATUS
--expected-plan=BASIC      # or STAGING_QA_EXPECTED_PLAN
--account-notes=...        # or STAGING_QA_ACCOUNT_NOTES
--non-interactive          # CI: no prompts (no interactive status prompt)
```

Config file is searched upward from cwd for:

- `hermes-qa.config.mjs` / `.js` / `.cjs` / `.json`
- `playwright-spec-qa.config.mjs` / `.js` / `.cjs` / `.json`

CLI flags override config file values for that run.

---

## Subscription status (ACTIVE / INACTIVE / CANCEL_PENDING)

This value picks which `@qa-scenario` block in your spec JSON is executed on staging. It is **not** read from your Playwright test code at runtime — you (or the tool) declare what state the staging account should be in.

### How it is decided (priority)

| Priority | Source             | Example                                                                                                     |
| -------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| 1        | CLI                | `--expected-subscription-status=INACTIVE`                                                                   |
| 2        | Environment        | `STAGING_QA_EXPECTED_SUBSCRIPTION_STATUS=INACTIVE`                                                          |
| 3        | Config file        | `staging.expectedSubscriptionStatus` or `pages.<page>.expectedSubscriptionStatus` in `hermes-qa.config.mjs` |
| 4        | Interactive prompt | TTY asks: `Expected subscription status (...)` — leave empty to let Hermes infer on the live page           |
| 5        | Hermes (judge)     | Opens `--target-path`, reads DOM/copy, picks the matching `@qa-scenario` from your spec                     |

Set it in config so CI and teammates never get prompted:

```js
// hermes-qa.config.mjs
export default {
  staging: {
    expectedSubscriptionStatus: "INACTIVE",
    expectedPlan: "BASIC",
  },
  pages: {
    dashboard: {
      expectedSubscriptionStatus: "ACTIVE", // overrides staging.* for this page only
    },
  },
};
```

### When you leave status empty

`judge` sends the full spec to Hermes. Hermes logs in, navigates to `--target-path` (e.g. `/pricing`, `/dashboard`), inspects the **live page**, and chooses which `scenarioId` block in the JSON matches that account — then runs or judges each test under that scenario (plus `@qa-always-run` scenarios).

Works the same for **pricing**, **dashboard**, and any other page; there is no separate Playwright runner step.

---

## Annotating your spec files

Add file-level and test-level annotations to your existing Playwright specs.

### File-level annotations

```ts
// @qa-scenario: ACTIVE          — which account state this file covers
// @qa-live-skip: true           — exclude this file from live Hermes runs
// @qa-always-run: true          — run regardless of live account state (e.g. BVA tests)
// @qa-fixture: avatar=tests/fixtures/qa-avatar.png  — default upload file for this spec file
```

### Upload fixtures (`@qa-fixture`)

For tests that call `setInputFiles`, declare which file Hermes should upload on live staging.

```ts
// File-level default (applies to all tests in this spec unless overridden)
// @qa-fixture: avatar=tests/fixtures/qa-avatar.png

// Per-test override (place directly above the test or test.describe)
// @qa-fixture: avatar=tests/fixtures/other.png
test("uploads avatar", async ({ page }) => {
  await page
    .getByTestId("avatar-input")
    .setInputFiles("tests/fixtures/qa-avatar.png");
});
```

**Resolution order** (later wins): `hermes-qa.config` root `fixtures` → `staging.fixtures` → `pages.<page>.fixtures` → file-level `@qa-fixture` → describe `@qa-fixture` → test `@qa-fixture`.

Paths are **repo-relative**. During `judge`, paths are resolved to absolute paths and sent to Hermes as `uploadFixtures.defaults` and `uploadFixtures.byCheckId` (keyed by each test's `checkId` in the spec JSON).

If a fixture file is missing on disk, the CLI prints `QA fixture missing on disk: ...` before calling Hermes.

**Config example** (`hermes-qa.config.mjs`):

```js
export default {
  staging: {
    fixtures: { avatar: "tests/fixtures/qa-avatar.png" },
  },
  pages: {
    settings: {
      fixtures: { document: "tests/fixtures/qa-upload.pdf" },
    },
  },
};
```

### Per-test `@qa-live-policy`

Every `test()` in an annotated file needs a live policy — place it directly above the test or the enclosing `test.describe`:

| Annotation                    | Hermes behavior on live staging                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `readonly`                    | DOM-only checks — no interaction needed                                                                                 |
| `safe-interaction`            | Safe UI actions that still require live test replay to verify (clicks, navigation, dialogs)                             |
| `safe-interaction-no-confirm` | UI action where completing verification would be dangerous on live — Hermes verifies up to the dangerous step, Esc only |
| `mock-judgment`               | Skips `page.route` replay; Hermes judges intent against live DOM                                                        |
| `subscription-mutation`       | Skipped (would change billing state)                                                                                    |
| `auth-mock`                   | Skipped (requires mocked 401 flow)                                                                                      |

**When to pick which policy**

- **`readonly`** — assertions only; no clicks needed on live.
- **`safe-interaction`** — safe, but you must replay steps (open dialog, navigate) to verify.
- **`safe-interaction-no-confirm`** — replay is safe until confirm/submit; finishing verification would be dangerous on live.
- **`mock-judgment`** — test uses `page.route` mocks; Hermes judges the live equivalent without mocking.
- **`subscription-mutation` / `auth-mock`** — Hermes records `skip` in `checks[]` (overall status stays `pass` if everything else passes).

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

// @qa-live-policy: safe-interaction-no-confirm
test("closes dialog when confirm is clicked", async ({ page }) => {
  await page.getByTestId("subscription-history-btn").click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  // Full verification needs confirm — dangerous on live; Hermes verifies dialog + Esc only
});

// @qa-live-policy: safe-interaction
// @qa-fixture: avatar=tests/fixtures/qa-avatar.png
test("uploads profile image", async ({ page }) => {
  await page
    .getByTestId("avatar-input")
    .setInputFiles("tests/fixtures/qa-avatar.png");
  await expect(page.getByTestId("avatar-preview")).toBeVisible();
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

### CI one-liner

```bash
export STAGING_QA_EMAIL=...
export STAGING_QA_PASSWORD=...
export STAGING_QA_BASE_URL=https://staging.your-app.com

npx playwright-spec-qa nightly --page=dashboard \
  --with-slack \
  --non-interactive
```

### Legacy: vendored `scripts/`

You can still copy `scripts/` into your repo and run `node scripts/extract-page-e2e-spec.mjs`. Prefer `npx` so updates do not require manual merges.

---

## CLI options

| Option                                                                        | Required  | Description                                                       |
| ----------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------- |
| `--page=`                                                                     | Yes       | Page slug, e.g. `dashboard`, `pricing`                            |
| `--config=`                                                                   | No        | Path to `hermes-qa.config.*` (auto-discovered from cwd upward)    |
| `--project-root=`                                                             | No        | App root (default: config file directory or cwd)                  |
| `--spec-dir=`                                                                 | No        | Spec directory template (`{page}`, `{root}`)                      |
| `--output-dir=`                                                               | No        | QA output directory template (`{page}`, `{root}`)                 |
| `--target-path=`                                                              | Per page  | Staging path (or `targetPaths` / `pages.*.targetPath` in config)  |
| `--email=` / `STAGING_QA_EMAIL`                                               | For judge | Staging login email                                               |
| `--password=` / `STAGING_QA_PASSWORD`                                         | For judge | Staging login password                                            |
| `--expected-plan=` / `STAGING_QA_EXPECTED_PLAN`                               | No        | Expected plan name                                                |
| `--expected-subscription-status=` / `STAGING_QA_EXPECTED_SUBSCRIPTION_STATUS` | No        | Expected subscription state                                       |
| `--account-notes=` / `STAGING_QA_ACCOUNT_NOTES`                               | No        | Free-text note forwarded to Hermes                                |
| `--base-url=` / `STAGING_QA_BASE_URL`                                         | No        | Staging origin                                                    |
| Config `fixtures` / `staging.fixtures` / `pages.*.fixtures`                   | No        | Default upload files for Hermes live replay (repo-relative paths) |
| `QA_OUTPUT_DIR`                                                               | No        | Override output directory                                         |
| `SLACK_WEBHOOK_URL`                                                           | For slack | Slack incoming webhook                                            |

---

## Output files

Output directory = `--output-dir` template or `paths.outputDir` in config (default: `src/page/{page}/__QA__/`).

For `--page=billing` and `--output-dir=.qa/{page}`:

| Step  | Files under `.qa/billing/`                                   |
| ----- | ------------------------------------------------------------ |
| spec  | `billing-qa-spec.json`, `billing-qa-spec.md`                 |
| judge | `billing-hermes-judgment.json`, `billing-hermes-judgment.md` |
| debug | `billing-hermes-query.txt`, `billing-hermes-raw-output.txt`  |

Slug rule: `--page=settings/billing` → file prefix `settings-billing-`.

`*-hermes-query.txt` and `*-hermes-raw-output.txt` are for debugging Hermes failures. Passwords and API keys are redacted before writing.

During `judge`, Hermes also receives `uploadFixtures` in its prompt payload (absolute paths resolved from `@qa-fixture` + config). These are not written as separate files.

---

## Status aggregation (browse mode)

The local normalizer re-derives the overall `status` from `checks[]`, ignoring Hermes's top-level status field to prevent false passes.

### Per-check results

| Check `result`  | Meaning                                                                              |
| --------------- | ------------------------------------------------------------------------------------ |
| `pass`          | Live DOM matches the test intent                                                     |
| `fail`          | Live DOM contradicts an assertion                                                    |
| `skip`          | Blocked on live (e.g. `subscription-mutation`, confirm required) — **not a failure** |
| `manual_review` | Ambiguous or needs human / Playwright follow-up                                      |

### Overall status

| `checks[]` content       | Final status    |
| ------------------------ | --------------- |
| Any `fail`               | `fail`          |
| Any `manual_review`      | `manual_review` |
| Empty array              | `manual_review` |
| All `pass` and/or `skip` | `pass`          |

`skip` alone does **not** elevate the verdict to `manual_review`. Example: 10 pass + 1 skip → overall **`pass`**.

---

## GitHub Actions

```yaml
- run: npm install -D playwright-spec-qa
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
2. **Subscription status** — set `staging.expectedSubscriptionStatus` or let Hermes infer on each page.
3. **Target paths** — `targetPaths` / `pages.<slug>.targetPath` in config, or `--target-path=` per run.
4. **Upload fixtures** — commit files under e.g. `tests/fixtures/`, declare with `@qa-fixture` or `staging.fixtures` in config.
5. **Live policies** — pick `@qa-live-policy` per test: `readonly` for DOM-only, `safe-interaction` for safe replay, `safe-interaction-no-confirm` when verification would be dangerous.
6. **Parser heuristics** — extend `detectSubscriptionMutation()` in `dashboard-spec-parser.mjs` if your specs use different destructive-action patterns.

---

## Troubleshooting

| Symptom                                 | Cause                            | Fix                                                       |
| --------------------------------------- | -------------------------------- | --------------------------------------------------------- |
| `Missing --page=`                       | Missing page argument            | Add `--page=billing` (after `--` for npm scripts)         |
| `ENOENT` / empty spec dir               | Wrong `--spec-dir`               | Check path; use `tests/e2e/{page}` and existing specs     |
| `Missing staging QA credentials`        | No email/password                | Set `.env` or `STAGING_QA_*` env vars                     |
| `Missing {page}-qa-spec.md`             | spec step not run                | Run `npx playwright-spec-qa spec --page=...` first        |
| `QA fixture missing on disk`            | `@qa-fixture` path wrong         | Commit file under repo; check repo-relative path          |
| `npx playwright-spec-qa` not found      | Package not on npm yet           | Use `npx github:lodado/playwright-spec-for-AI-Agent`      |
| `Hermes did not return a JSON decision` | Hermes exited without JSON       | Check `{page}-hermes-raw-output.txt`                      |
| `checks[]` table is empty               | Hermes returned no per-test rows | Browse mode result is `manual_review`; inspect raw output |
| Verdict `manual_review` but checks skip | Old behavior / Hermes top-level  | Re-run `judge`; `skip` no longer forces `manual_review`   |

---

## License

MIT
