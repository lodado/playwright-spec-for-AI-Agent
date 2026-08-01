<div align="center">

# Playwright Spec for AI Agent

**Turn existing Playwright specs into evidence-driven live staging QA.**

[![npm version](https://img.shields.io/npm/v/playwright-spec-for-ai-agent?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/playwright-spec-for-ai-agent)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-%3E%3D1.48-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

[Quick start](#quick-start) · [Architecture](ARCHITECTURE.md) · [Overfitting audit](docs/qa-native-overfitting-audit.md) · [Providers & modes](#providers-and-modes) · [Config](#project-config-hermes-qaconfigmjs) · [Options](#execute-options) · [Annotations](#annotations) · [Commands](#commands) · [Env vars](#environment-variables) · [Code-backed Issues](#publish-a-code-backed-github-issue) · [Safety](#safety-and-limits)

</div>

`qa-native` reads your Playwright specs as QA intent, compiles the annotated
scenarios into a static QA IR, runs them against live staging under a bounded
read-only browser policy, seals the browser evidence, and judges the result as
`PASS`, `FAIL`, `MANUAL_REVIEW`, or `SKIP` — without replaying brittle mocked
flows or mutating staging state.

```text
Playwright spec → AST policy manifest → independent AI extraction → live applicability preflight → policy-bounded browser evidence → judgment → independent review → code-backed report
```

Page runs send each complete selected spec to a text-only Hermes extractor that
returns explicit Given (initial observable state), When (authored flow), and Then
(observable outcome) fields, then
give only the source, immutable manifest, and candidate to a fresh independent reviewer. Up to three
reviewed revisions are allowed; a fourth rejection fails closed. Approved meaning is cached as
private JSON under `.qa/abstract/cache/` and page-local Markdown under
`.qa/abstract/<page>/`, keyed by source,
extractor, reviewer, model, and prompt versions. The model cannot add actions,
policy, selectors, or a verdict: the nearest test or enclosing-suite `@qa-live-policy` resolved into the immutable manifest still owns
authority, the gateway owns capabilities, and a separate evidence-only judge
compares claims with sealed runtime evidence. A fresh reviewer then checks that
each judgment is grounded in its cited evidence. Missing evidence never proves a
claim. Hermes/adaptive runs use the abstract compiler by default for both `--page`
and `--spec`; `--compiler=ast` remains a compatibility escape hatch.

Large specs are extracted and independently reviewed in batches of at most
eight tests. Only a timed-out or invalid batch is recursively reduced and
retried; successful batches are retained.

Use it when your app already has Playwright specs and you want a bounded live QA
layer. Keep deterministic Playwright CI and API contract tests as the primary
regression gates.

> **Migrating from ≤ 1.x?** The legacy page-QA CLI
> (`playwright-spec-for-ai-agent <spec|abstract-ai|judge|review|slack|nightly>`)
> was removed in 2.0. Use the `qa-native` commands below.

## Quick start

### 1. Install

```bash
npm install -D playwright-spec-for-ai-agent
npx playwright install chromium
```

Requirements: Node.js 20 or newer, an app repository with Playwright specs, and
[Hermes Agent](https://github.com/NousResearch/hermes-agent) configured with an
inference model for adaptive execution and judgment.

### 2. Annotate one spec

```ts
// @qa-page: pricing
// @qa-scenario: A visitor can understand the pricing options

import { expect, test } from "@playwright/test";

// @qa-live-policy: readonly
test("shows pricing options", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
});
```

### 3. Execute → judge → review → report

```bash
export QA_NATIVE_INTEGRITY_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"

npx qa-native execute \
  --spec=tests/e2e/pricing/pricing.spec.ts \
  --base-url=https://staging.example.com \
  --run-dir=.qa/runs/pricing-1 \
  --provider=hermes \
  --mode=adaptive
npx qa-native judge --run-dir=.qa/runs/pricing-1
npx qa-native review --run-dir=.qa/runs/pricing-1
npx qa-native report --run-dir=.qa/runs/pricing-1 --repository-root=. --revision=HEAD
```

If a run is judged again, select the completed judgment-set directory for the
independent review: `npx qa-native review --run-dir=.qa/runs/pricing-1
--judgment=judgments/<set-dir>`. The same directory may be passed to `report`.

For approved abstract specs, `execute` first observes the live page once and
selects scenario applicability. High-confidence conflicts become
`NOT_APPLICABLE` and are not executed; ambiguous scenarios retain the legacy
execute path so coverage cannot disappear silently. The selector receives only
the compiled Given conditions, not titles, Then claims, destination URLs,
dialogs, toasts, future mock responses, fixture identities, or other post-action
state. Given is not a fixture reconstruction: hidden API setup is excluded when
the rendered Then claim directly establishes the product state. Only read-only
observable initial route/account/product state can skip a scenario, and Given
never presupposes the presence or state of the subject evaluated by Then. A
missing subject therefore reaches judgment instead of becoming not-applicable.
Executed scenarios are sealed into one evidence manifest. Unclear executed states become
`MANUAL_REVIEW`; they are not forced into pass or fail. **AI-native (`--provider=hermes --mode=adaptive`) is the
default**; pass `--mode=strict` for the deterministic read-only provider that needs
no inference model. See [Providers and modes](#providers-and-modes).

### Choosing the spec: `--spec` vs `--page`

`execute` needs exactly one spec source, and an explicit spec always wins:

- **`--spec=<file>`** — run that one spec file. Requires `--base-url`. Use this
  to pin an exact, predetermined spec so nothing improvises which tests run.
- **`--page=<name>`** — resolve the page's _designated_ specs from the project
  config (`hermes-qa.config.mjs` / `playwright-spec-for-ai-agent.config.mjs`)
  instead of naming a file. From the page's `__tests__` directory, `--page`
  selects the specs whose `@qa-scenario` matches the page's `expectedScenario`
  (case-insensitive; page config, then the `staging` default;
  `expectedSubscriptionStatus` remains a legacy alias), plus any marked
  `// @qa-always-run: true`, minus any
  `// @qa-live-skip: true`. When no status is configured, the whole directory is
  designated. The selected specs are compiled and merged into one run,
  `--base-url` defaults to `batch.defaultBaseUrl`, navigation uses the config's
  per-page `targetPath` (e.g. a locale-prefixed route), and scenarios blocked by
  `@qa-live-policy` (`skip` / `auth-mock` / `subscription-mutation`) are still
  skipped. Abstract/adaptive runs then perform scenario-level live applicability
  preflight inside those designated specs. `--config=<file>` overrides config auto-discovery.

```bash
# Extract and independently review the page specs without opening a browser:
npx qa-native abstract-ai --page=dashboard

# Run the dashboard page's designated specs, base URL from config:
npx qa-native execute --page=dashboard --run-dir=.qa/runs/dashboard-1 \
  --provider=hermes --mode=adaptive
```

Hermes/adaptive runs use `--compiler=abstract` by default for both `--page` and
`--spec`. Pass `--compiler=ast` only for the compatibility compiler.

Giving both `--spec` and `--page`, or neither, is an error. This keeps a QA run
tied to the specs you defined for a page rather than an ad-hoc plan.

See the [QA Native guide](docs/qa-native.md) and the
[one-shot runbook](docs/qa-native-one-shot-runbook.md) for the full flow,
operator setup, and verdict handling.

## Providers and modes

`execute` has two ways to run a spec. Pick one with `--provider` and `--mode`:

| Combination                                       | What it does                                                                                                                                                                 | When to use                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `--provider=hermes --mode=adaptive` **(default)** | **AI-driven.** A bounded agent proposes one small action at a time (observe, navigate, click, wait, upload…) to reach the spec's milestones. Needs a Hermes inference model. | Flaky/unclear live states where a fixed plan is too brittle.    |
| `--provider=playwright --mode=strict`             | **Deterministic.** Compiles the spec into a fixed plan and replays it exactly — navigate, the declared interactions, observe, checkpoint. No AI.                             | Reproducible runs, no inference model, pinning exact behaviour. |

Both run `@qa-fixture` file uploads (the file is author-designated, never agent-chosen).

Both seal the same tamper-evident browser evidence and hand it to a **browserless
judge**. Adaptive is the default; strict trades resilience for deterministic,
model-free replay.
The adaptive agent can never declare a verdict itself — it only gathers evidence.

## Verdicts

`judge` returns one of four verdicts per scenario:

| Verdict         | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `PASS`          | The evidence shows the expected state.                                  |
| `FAIL`          | The evidence contradicts the expectation. Feed it to `report`.          |
| `MANUAL_REVIEW` | Live state is plausible but uncertain — a human should look. Not a bug. |
| `SKIP`          | Sealed evidence establishes that the scenario is not applicable.        |

Preflight `NOT_APPLICABLE` scenarios are reported separately and are not judged
or counted as failures. An executed scenario whose evidence proves every claim
inapplicable receives `SKIP`. Other unclear states resolve to `MANUAL_REVIEW`.

## Project config (`hermes-qa.config.mjs`)

`--page` (and the report/remediate commands) read a project config from the repo
root. Auto-discovered filenames: `playwright-spec-for-ai-agent.config.mjs`,
`hermes-qa.config.mjs`, or `playwright-spec-qa.config.mjs` (`.js` / `.cjs` /
`.json` also work). Override with `--config=<file>`.

```js
// hermes-qa.config.mjs — every field is optional; defaults shown in comments
export default {
  paths: {
    specDir: "src/page/{page}/__tests__", // where a page's specs live ({page} = --page value)
    outputDir: "src/page/{page}/__QA__", // generated artifacts
  },
  batch: {
    defaultBaseUrl: "https://staging.example.com", // --base-url default for --page
  },
  targetPaths: {
    dashboard: "/ko/dashboard", // navigation path per page (overrides @qa-page)
  },
  staging: {
    expectedScenario: "INACTIVE", // --page selects @qa-scenario == this
  },
  pages: {
    dashboard: {
      specDir: "src/page/dashboard/__tests__", // per-page override of paths.specDir
      targetPath: "/ko/dashboard", // per-page override of targetPaths
      expectedScenario: "INACTIVE", // per-page override of staging default
    },
  },
};
```

With this, `--page=dashboard` runs every `src/page/dashboard/__tests__/*.spec.ts`
whose `@qa-scenario` is `INACTIVE` (plus any `@qa-always-run`, minus any
`@qa-live-skip`), navigates to `/ko/dashboard`, and defaults the base URL to
`staging.example.com`.

## `execute` options

```text
qa-native execute (--spec=<file> | --page=<name>) [--base-url=<url>] --run-dir=.qa/runs/<id> [options]
```

| Option                    | Purpose                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `--spec=<file>`           | Run one spec file (needs `--base-url`). Mutually exclusive with `--page`.                      |
| `--page=<name>`           | Run the config-designated specs for a page (see above).                                        |
| `--config=<file>`         | Use a specific project config instead of auto-discovery.                                       |
| `--base-url=<url>`        | Staging origin. Required with `--spec`; defaults to `batch.defaultBaseUrl` with `--page`.      |
| `--run-dir=.qa/runs/<id>` | Where evidence is sealed (must not already exist). Required.                                   |
| `--provider` / `--mode`   | `hermes`/`adaptive` (default) or `playwright`/`strict` — see above.                            |
| `--compiler`              | `abstract` for AST metadata plus AI semantics (Hermes default); `ast` for compatibility.       |
| `--storage-state=<file>`  | Signed-in session; auto-discovers `.private/storage-state.json`.                               |
| `--auth-bootstrap=<file>` | SSO/session-refresh page with origin/endpoint allowlists.                                      |
| `--allowed-origin=<url>`  | Extra exact origin(s) leased to the page; comma-separated, up to 7.                            |
| `--allow-partial`         | Skip statically un-runnable scenarios instead of failing the whole file (implied by `--page`). |
| `--budget-actions=<n>`    | Adaptive: max actions (default 32).                                                            |
| `--budget-turns=<n>`      | Adaptive: max agent turns (default 32).                                                        |
| `--budget-time-ms=<n>`    | Adaptive: wall-clock budget in ms (default 300000).                                            |
| `--budget-tokens=<n>`     | Adaptive: max model tokens (default 100000).                                                   |

## Authenticated pages

The login is a Playwright `storageState` JSON file (the signed-in session).
Drop it at the shared default path and every run reuses it:

```text
.private/storage-state.json   # owner-only: chmod 600
```

`execute` auto-discovers `.private/storage-state.json` when `--storage-state` is
omitted; an explicit `--storage-state=<file>` overrides it. The file must be a
workspace-local, owner-only regular file. `.private/` is gitignored, so the
session is never committed.

`--auth-bootstrap=.private/auth-bootstrap.json` can additionally open an
SSO/session-refresh page with explicit origin and endpoint allowlists; after
bootstrap, the active scenario policy and leased origins take over. See the
[QA Native guide](docs/qa-native.md#authenticated-pages) for its JSON format and
secret-handling constraints.

## Annotations

File annotations belong before imports; live policy belongs above each test or a
shared `describe`.

| Annotation        | Required | Purpose                                                                                                   |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `@qa-page`        | No       | Page id; the target path resolves relative to `--base-url`.                                               |
| `@qa-scenario`    | Yes      | Name the scenario or account state.                                                                       |
| `@qa-live-policy` | Yes      | Declare what live interaction is safe.                                                                    |
| `@qa-live-skip`   | No       | `true` skips the test (or whole file at file level) on live; it is never executed.                        |
| `@qa-always-run`  | No       | `true` includes the spec under `--page` even when its `@qa-scenario` does not match the configured state. |
| `@qa-fixture`     | No       | `name=repo-relative/path` file for an `setInputFiles("name")` upload (see below).                         |

### File uploads (`@qa-fixture`)

File upload replays a real file, so the file must be **explicitly designated** by
`@qa-fixture` — never chosen by the agent. It runs in **both** strict and adaptive
mode: in adaptive mode the AI may only upload when the scenario declares a fixture,
and only that fixture. Declare the file and name it in the `setInputFiles` call:

```ts
// @qa-scenario: UPLOAD
// @qa-live-policy: safe-interaction
// @qa-fixture: doc=src/page/deep-parser/__QA__/fixtures/sample.pdf
test("uploads a document", async ({ page }) => {
  await page.getByTestId("file-input").setInputFiles("doc"); // "doc" names the @qa-fixture
  await expect(page.getByText("업로드 완료")).toBeVisible();
});
```

The fixture path is repo-relative and resolved strictly inside the project root
(no symlink escape, 32 MB cap) before Playwright touches it. An upload whose
`setInputFiles` argument does not name a declared `@qa-fixture` is blocked (a
`UPLOAD_FIXTURE_UNRESOLVED` diagnostic), so it is skipped rather than run blind.

Supported live policies:

| Policy                                       | Meaning                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `readonly`                                   | Inspect without interaction.                                                                                      |
| `safe-interaction`                           | Allow bounded interaction; HTTP methods and WebSockets are allowed only on exact leased origins.                  |
| `safe-interaction-no-confirm`                | Interaction allowed, but verifying the outcome on live would be dangerous — verdicts come from semantic judgment. |
| `mock-judgment`                              | The spec relies on Playwright mocks; the judge rules on live-DOM evidence semantically instead.                   |
| `subscription-mutation`, `auth-mock`, `skip` | Statically blocked on live; skipped under `--allow-partial`, otherwise the file fails closed.                     |

See the [policy table](docs/qa-native.md#qa-live-policy-values) for how each value
compiles and behaves under adaptive execution.

For exact parser support and unsupported syntax, see the
[Playwright syntax reference](https://github.com/lodado/playwright-spec-for-AI-Agent/blob/main/apps/playwright-spec-for-ai-agent/PLAYWRIGHT_SYNTAX_SUPPORT.md).

## Publish a code-backed GitHub Issue

After `judge` produces one `FAIL` or `MANUAL_REVIEW` result, `report` connects
the browser evidence to tracked source at an exact Git commit. Commit the code
you want to inspect first; uncommitted working-tree changes are not searched.

```bash
npx qa-native report \
  --run-dir=.qa/runs/pricing-1 \
  --repository-root=. \
  --revision=HEAD
```

The report pins `HEAD` to a commit, searches bounded source files for relevant
test IDs, visible text, routes, and endpoints, then writes the diagnosis,
suspected file ranges, and repair recommendation under:

```text
.qa/runs/pricing-1/reports/report-<hash>/
├── diagnosis-<hash>.json
├── code-context-<hash>.json
├── repair-recommendation-<hash>.json
└── report-<hash>.md
```

Review the Markdown report before publishing. Then authenticate GitHub CLI and
set a stable publication key (keep the same value in CI secrets so recurring
failures are matched safely):

```bash
gh auth login
export QA_NATIVE_PUBLICATION_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"

npx qa-native publish-issue \
  --run-dir=.qa/runs/pricing-1 \
  --repository-root=. \
  --repository=owner/repository \
  --revision=HEAD
```

The authenticated GitHub identity needs permission to read repository contents,
search Issues and Draft PRs, create Issues, and add comments. These labels must
already exist: `qa-runtime`, `auto-generated`, `origin:<diagnosed-origin>`,
`severity:<diagnosed-severity>`, and `scenario:<scenario-id>`.

Before creating remote state, `publish-issue` verifies that the pinned commit
exists in the target repository and that the suspected files still match their
recorded SHA-256 hashes. The Issue carries expected and observed behavior,
evidence references, suspected files and line ranges, uncertainty, and a replay
command; it never publishes source snippets or credentials.

Publication is idempotent:

| Existing open fingerprint match | Result                                        |
| ------------------------------- | --------------------------------------------- |
| None                            | Create one Issue.                             |
| One match from a new run        | Add an authenticated occurrence comment.      |
| One match from the same run     | No-op.                                        |
| Multiple matches                | Stop as ambiguous without selecting a target. |

Select exactly one result with `--judgment=judgments/judge-<hash>/judge-result-<hash>.json`
when a run has multiple failures. Only `FAIL` and `MANUAL_REVIEW` results are
publishable. Publication records stay private under
`.qa/runs/<run-id>/publications/`; `publish-issue` cannot create branches,
patches, pull requests, or merges.

Read the [QA Native guide](docs/qa-native.md) before enabling patch verification
or GitHub publication.

## Commands

`execute` → `judge` → `report` → `publish-issue` is the core flow; the rest support
replay and remediation. Run `qa-native --help` for full flags.

| Command         | Purpose                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| `execute`       | Compile the spec(s) and run them against live staging, sealing browser evidence.              |
| `judge`         | Turn sealed evidence into a `PASS` / `FAIL` / `MANUAL_REVIEW` / `SKIP` verdict.               |
| `replay`        | Re-verify a sealed run's evidence offline, without a browser.                                 |
| `diagnose`      | Produce a failure diagnosis for a judged run.                                                 |
| `suggest-fix`   | Add a repair recommendation on top of the diagnosis.                                          |
| `report`        | Connect a failure to source at a pinned commit; write diagnosis, code context, and repair.    |
| `propose-patch` | Generate a candidate patch for a reported failure.                                            |
| `verify-patch`  | Verify a proposed patch under strict checks before it can be published.                       |
| `publish-issue` | Publish a code-backed GitHub Issue (idempotent; see above).                                   |
| `publish`       | Report and publish in one authenticated step (`--publish=auto`).                              |
| `remediate`     | End-to-end remediation: a private worktree and Draft PR after strict verification (no merge). |

Report, publish, and remediate commands take `--repository-root=.` and `--revision=<commit>`;
publication commands also take `--repository=<owner/repo>`. Select one result of a multi-failure run
with `--judgment=<result.json>`.

## Environment variables

| Variable                    | Required for            | Purpose                                                                          |
| --------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `QA_NATIVE_INTEGRITY_KEY`   | `execute`, `judge`, all | 32-byte base64 key that seals and verifies evidence. Keep it stable in CI.       |
| `QA_NATIVE_PUBLICATION_KEY` | `publish-issue` etc.    | 32-byte base64 key for idempotent Issue fingerprints. Keep it stable in CI.      |
| `QA_NATIVE_DEBUG`           | debugging               | Set to `1` to print the full error stack on stderr instead of just the category. |

Generate a key with:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
```

## What a run leaves behind

Each `execute` writes a sealed, tamper-evident run directory:

```text
.qa/runs/<id>/
├── qa-ir.json            # the compiled QA intent
├── execution-plan.json   # strict mode only
├── run.json              # runtime outcome
├── evidence/             # sealed DOM/ARIA/action-log bundles + HMAC manifest
├── judgments/            # written by `judge`
└── reviews/              # independent grounding decisions written by `review`

.qa/abstract/cache/       # owner-only, reviewed full-spec JSON shared across pages
.qa/abstract/<page>/      # page-local Markdown views
.qa/abstract-cache/       # compatibility cache for AST slice fallback
```

For abstract/adaptive runs, `qa-ir.json` also contains the authenticated
`extensions.applicabilityDecisions` used to select execution. The run envelope
hashes the complete QA IR and the exact execution-input list.

Evidence is never deleted. A run that fails validation is quarantined to
`<id>.invalid/` rather than removed. `.qa/` is workspace-local; keep it gitignored.

## Troubleshooting

| Symptom                               | Fix                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| No scenarios compiled                 | Put `@qa-scenario` before imports and add a supported `@qa-live-policy`.                                       |
| Browser executable is missing         | Run `npx playwright install chromium`.                                                                         |
| `hermes-agent` protocol error         | Install a Hermes Agent whose CLI supports `--query`/`--max_turns`; run `node scripts/hermes-runner-smoke.mjs`. |
| Model configuration is missing        | Configure `~/.hermes/config.yaml` or `HERMES_INFERENCE_MODEL`.                                                 |
| Storage state rejected                | Make it owner-only (`chmod 600`) and workspace-local.                                                          |
| Live state is plausible but uncertain | `MANUAL_REVIEW` is the expected safe result.                                                                   |
| Need the cause of a failed command    | Set `QA_NATIVE_DEBUG=1` to print the full stack on stderr; without it only the failure category is shown.      |

## Safety and limits

- The CLI reads specs as source material; it does not replace deterministic Playwright CI or API contract tests.
- Live judgment is non-deterministic; unclear states resolve to `MANUAL_REVIEW`.
- Browser network access follows each scenario policy: read-only scenarios allow only `GET`/`HEAD`; click-enabled scenarios allow every HTTP method and WebSocket only on exact leased origins. Unleased origins and destructive confirmations remain blocked. File uploads run only from a declared `@qa-fixture` resolved inside the project root — the file is always author-designated, never chosen by the agent, in either mode.
- Credentials belong in environment variables, a secret manager, or a private `storageState` file — never committed config or CLI flags.
- Remediation can create private worktrees and Draft PRs only after strict verification; it has no merge or auto-merge path.
- Results are first-pass live QA evidence, not a replacement for a QA engineer.
