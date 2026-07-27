<div align="center">

# Playwright Spec for AI Agent

**Turn existing Playwright specs into AI-assisted live staging QA.**

[![npm version](https://img.shields.io/npm/v/playwright-spec-for-ai-agent?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/playwright-spec-for-ai-agent)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-%3E%3D1.48-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

[Quick start](#10-minute-quick-start) · [Live judgment](#continue-to-live-judgment) · [Annotations](#annotations) · [Troubleshooting](#troubleshooting) · [QA Native](#qa-native) · [Workspace](../../README.md)

</div>

This CLI reads Playwright source files as QA intent. It does not replay brittle mocked flows against staging. Instead, it extracts annotated scenarios, asks Hermes Agent to turn them into live plans, and judges the visible staging experience as `pass`, `fail`, `manual_review`, or `skip`.

```text
Playwright spec → structured scenario → live plan → staging judgment → review/report
```

Use it when your app already has Playwright specs and you want a bounded live QA layer. Keep deterministic Playwright CI and API contract tests as the primary regression gates.

## 10-minute quick start

The first success path only parses local source. It does not need Hermes, a browser, staging credentials, or an API key.

### 1. Install

```bash
npm install -D playwright-spec-for-ai-agent
```

Requirements: Node.js 20 or newer and an app repository containing Playwright specs.

### 2. Create the minimal config

Create `playwright-spec-for-ai-agent.config.mjs` in your app root:

```js
export default {
  paths: {
    specDir: "tests/e2e/{page}",
  },
  staging: {
    baseUrl: "https://staging.example.com",
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

The package also ships a larger template:

```bash
cp node_modules/playwright-spec-for-ai-agent/playwright-spec-for-ai-agent.config.example.mjs \
  playwright-spec-for-ai-agent.config.mjs
```

### 3. Annotate one spec

Create or update `tests/e2e/pricing/pricing.spec.ts`:

```ts
// @qa-page: pricing
// @qa-scenario: A visitor can understand the pricing options

import { expect, test } from "@playwright/test";

// @qa-live-policy: readonly
test("shows pricing options", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
});
```

### 4. Extract the scenario

```bash
npx playwright-spec-for-ai-agent spec --page=pricing
```

Expected output begins under:

```text
src/page/pricing/__QA__/
└── pricing-qa-spec.json
```

If that file exists, installation, config discovery, spec discovery, and annotation parsing are working.

## Continue to live judgment

Live planning and judgment use [Hermes Agent](https://github.com/NousResearch/hermes-agent).

### 1. Install and configure Hermes

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
  | bash -s -- --skip-setup --skip-browser
```

Configure an inference model in `~/.hermes/config.yaml` or set `HERMES_INFERENCE_MODEL`.

### 2. Generate the live plan

```bash
npx playwright-spec-for-ai-agent abstract-ai --page=pricing
```

Expected artifact:

```text
src/page/pricing/__QA__/pricing-qa-spec-live.md
```

### 3. Judge staging

For a public page:

```bash
npx playwright-spec-for-ai-agent judge --page=pricing --non-interactive
```

For an authenticated page, keep credentials out of flags and shell history:

```bash
export STAGING_QA_EMAIL=qa@example.com
export STAGING_QA_PASSWORD='replace-with-a-secret'
npx playwright-spec-for-ai-agent judge --page=dashboard --non-interactive
```

Expected judgment:

```text
src/page/<page>/__QA__/<page>-hermes-judgment.md
```

Unclear live states become `manual_review`; they are not forced into pass or fail.

## Command flow

```text
spec → abstract-ai → judge → review → slack (optional)
                  └──────────── nightly ────────────┘
```

| Command | Needs Hermes | Purpose |
| --- | --- | --- |
| `spec` | No | Parse annotated `*.spec.ts` files into structured scenarios. |
| `abstract-ai` | Yes | Convert mocked spec intent into a staging-ready live plan. |
| `judge` | Yes | Browse staging and produce a verdict with evidence. |
| `review` | Yes | Review saved judgment quality without browsing again. |
| `slack` | No | Send fail/manual-review results to Slack. |
| `nightly` | Yes | Run the configured page pipeline non-interactively. |

Add convenient package scripts if desired:

```json
{
  "scripts": {
    "qa:spec": "playwright-spec-for-ai-agent spec",
    "qa:judge": "playwright-spec-for-ai-agent judge",
    "qa:nightly": "playwright-spec-for-ai-agent nightly"
  }
}
```

Pass flags after `--`:

```bash
npm run qa:spec -- --page=pricing
```

## Configuration

| Field | Purpose |
| --- | --- |
| `paths.specDir` | Spec path template; `{page}` is replaced by the CLI page id. |
| `paths.outputDir` | Optional global QA artifact directory. |
| `staging.baseUrl` | Default staging origin. |
| `staging.loginPath` | Login path relative to the staging origin. |
| `staging.authRequired` | Whether judgment requires staging credentials. |
| `pages.{page}.pageUrl` | Full target URL for one page. |
| `pages.{page}.targetPath` | Path joined with `staging.baseUrl`. |
| `pages.{page}.authRequired` | Per-page authentication override. |
| `pages.{page}.outputDir` | Per-page artifact directory override. |

Target priority is CLI `--target-path`, then `pageUrl`, then `targetPath` joined to the base URL. `STAGING_QA_BASE_URL` and `--base-url` override the configured base URL.

Interactive `judge` confirms credentials and target when stdin is a TTY. Use `--non-interactive`, `--yes`, or `-y` in CI.

## Annotations

File annotations belong before imports; live policy belongs above each test or a shared `describe`.

| Annotation | Required | Purpose |
| --- | --- | --- |
| `@qa-page` | No | Override the page id. |
| `@qa-scenario` | Yes | Name the scenario or account state. |
| `@qa-live-policy` | Yes unless skipped | Declare what live interaction is safe. |
| `@qa-live-skip` | No | Block the whole file from live QA. |
| `@qa-always-run` | No | Keep the scenario eligible during filtering. |
| `@qa-fixture` | No | Name a fixture used by one test. |

Supported live policies:

| Policy | Meaning |
| --- | --- |
| `readonly` | Inspect without interaction. |
| `safe-interaction` | Allow bounded, non-destructive interaction. |
| `safe-interaction-no-confirm` | Interact but stop before final confirmation. |
| `mock-judgment` | Judge intent rather than exact mocked values. |
| `subscription-mutation` | Block billing/subscription mutation. |
| `auth-mock` | Block flows whose authentication only exists in mocks. |
| `skip` | Explicitly exclude the test. |

For exact parser support and unsupported syntax, see the [Playwright syntax reference](https://github.com/lodado/playwright-spec-for-AI-Agent/blob/main/apps/playwright-spec-for-ai-agent/PLAYWRIGHT_SYNTAX_SUPPORT.md).

## Nightly CI

Store credentials and model configuration as CI secrets, then run:

```bash
npx playwright-spec-for-ai-agent nightly \
  --page=pricing \
  --non-interactive
```

Add `--with-slack` only after configuring the Slack webhook expected by your project. Start with read-only or no-confirmation scenarios; never use a live QA account that can mutate production billing or destructive state.

## Output files

Common files under the configured QA output directory:

```text
<page>-qa-spec.json
<page>-qa-spec-abstracted.json
<page>-qa-spec-live.json
<page>-qa-spec-live.md
<page>-qa-judge-plan.md
<page>-hermes-judgment.json
<page>-hermes-judgment.md
<page>-hermes-raw-output.txt
```

## QA Native

The package also ships `qa-native`, an evidence-driven runtime for direct read-only Playwright execution, browserless judgment, and bounded remediation.

```bash
export QA_NATIVE_INTEGRITY_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"
npx playwright install chromium
npx qa-native execute \
  --spec=tests/e2e/pricing/pricing.spec.ts \
  --base-url=https://staging.example.com \
  --run-dir=.qa/runs/pricing-1
npx qa-native judge --run-dir=.qa/runs/pricing-1
```

Read the [QA Native guide](https://github.com/lodado/playwright-spec-for-AI-Agent/blob/main/apps/playwright-spec-for-ai-agent/docs/qa-native.md) before enabling patch verification or GitHub publication.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No specs found | Check `paths.specDir`, the `{page}` directory, and the `--page` value. |
| Scenario is missing | Put `@qa-scenario` before imports at file scope. |
| Tests are skipped from live QA | Add a supported `@qa-live-policy` and check `@qa-live-skip`. |
| `hermes` is not found | Install Hermes and ensure its binary is on `PATH`. |
| Model configuration is missing | Configure `~/.hermes/config.yaml` or `HERMES_INFERENCE_MODEL`. |
| Login fails | Verify `staging.baseUrl`, `loginPath`, account state, and credential environment variables. |
| Browser executable is missing in QA Native | Run `npx playwright install chromium`. |
| Live state is plausible but uncertain | `manual_review` is the expected safe result. |

## Safety and limits

- The CLI reads specs as source material; it does not replace deterministic Playwright CI.
- Live judgment is non-deterministic and should not replace API contract tests.
- Destructive, subscription, billing, and mocked-auth flows must be blocked or stopped before confirmation.
- Credentials belong in environment variables or CI secrets, never committed config or CLI password flags.
- QA Native can create private worktrees and Draft PRs only after strict verification; it has no merge or auto-merge path.
- Results are first-pass live QA evidence, not a replacement for a QA engineer.

<details>
<summary>Install with an AI coding agent</summary>

```text
Install playwright-spec-for-ai-agent in this app repository.

1. Locate the Playwright specs and choose one read-only page.
2. Install playwright-spec-for-ai-agent as a dev dependency.
3. Create playwright-spec-for-ai-agent.config.mjs with specDir, staging.baseUrl, and the selected page target.
4. Add file-level @qa-page and @qa-scenario annotations.
5. Add @qa-live-policy above each selected test.
6. Run the spec command and report the generated artifact paths.

Do not run destructive staging flows. Stop before confirmations and keep credentials in environment variables.
```

</details>
