<div align="center">

# Playwright Spec for AI Agent

**Turn existing Playwright specs into evidence-driven live staging QA.**

[![npm version](https://img.shields.io/npm/v/playwright-spec-for-ai-agent?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/playwright-spec-for-ai-agent)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-%3E%3D1.48-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

[Quick start](#quick-start) · [Authenticated pages](#authenticated-pages) · [Annotations](#annotations) · [Code-backed Issues](#publish-a-code-backed-github-issue) · [Safety](#safety-and-limits) · [Workspace](../../README.md)

</div>

`qa-native` reads your Playwright specs as QA intent, compiles the annotated
scenarios into a static QA IR, runs them against live staging under a bounded
read-only browser policy, seals the browser evidence, and judges the result as
`PASS`, `FAIL`, `MANUAL_REVIEW`, or `SKIP` — without replaying brittle mocked
flows or mutating staging state.

```text
Playwright spec → QA IR → sealed browser evidence → browserless judgment → code-backed report
```

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

### 3. Execute → judge → report

```bash
export QA_NATIVE_INTEGRITY_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"

npx qa-native execute \
  --spec=tests/e2e/pricing/pricing.spec.ts \
  --base-url=https://staging.example.com \
  --run-dir=.qa/runs/pricing-1 \
  --provider=hermes \
  --mode=adaptive
npx qa-native judge --run-dir=.qa/runs/pricing-1
npx qa-native report --run-dir=.qa/runs/pricing-1 --repository-root=. --revision=HEAD
```

`execute` runs every declared scenario of the spec sequentially into one sealed
evidence manifest. Unclear live states become `MANUAL_REVIEW`; they are not
forced into pass or fail. A strict read-only provider (`--provider=playwright
--mode=strict`) is available for evidence capture without an inference model.

See the [QA Native guide](docs/qa-native.md) and the
[one-shot runbook](docs/qa-native-one-shot-runbook.md) for the full flow,
operator setup, and verdict handling.

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
SSO/session-refresh page with explicit origin and endpoint allowlists;
bootstrap-only mutations are blocked again before the QA spec runs. See the
[QA Native guide](docs/qa-native.md#authenticated-pages) for its JSON format and
secret-handling constraints.

## Annotations

File annotations belong before imports; live policy belongs above each test or a
shared `describe`.

| Annotation        | Required | Purpose                                                     |
| ----------------- | -------- | ----------------------------------------------------------- |
| `@qa-page`        | No       | Page id; the target path resolves relative to `--base-url`. |
| `@qa-scenario`    | Yes      | Name the scenario or account state.                         |
| `@qa-live-policy` | Yes      | Declare what live interaction is safe.                      |

Supported live policies:

| Policy                                       | Meaning                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `readonly`                                   | Inspect without interaction.                                                                                      |
| `safe-interaction`                           | Allow bounded, non-destructive interaction (same-origin reads after a click are allowed and logged).              |
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

## Troubleshooting

| Symptom                               | Fix                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| No scenarios compiled                 | Put `@qa-scenario` before imports and add a supported `@qa-live-policy`.                                       |
| Browser executable is missing         | Run `npx playwright install chromium`.                                                                         |
| `hermes-agent` protocol error         | Install a Hermes Agent whose CLI supports `--query`/`--max_turns`; run `node scripts/hermes-runner-smoke.mjs`. |
| Model configuration is missing        | Configure `~/.hermes/config.yaml` or `HERMES_INFERENCE_MODEL`.                                                 |
| Storage state rejected                | Make it owner-only (`chmod 600`) and workspace-local.                                                          |
| Live state is plausible but uncertain | `MANUAL_REVIEW` is the expected safe result.                                                                   |

## Safety and limits

- The CLI reads specs as source material; it does not replace deterministic Playwright CI or API contract tests.
- Live judgment is non-deterministic; unclear states resolve to `MANUAL_REVIEW`.
- The browser policy allows only same-origin `GET`/`HEAD` reads after a safe interaction; mutations, cross-origin requests, uploads, and destructive confirmations are blocked.
- Credentials belong in environment variables, a secret manager, or a private `storageState` file — never committed config or CLI flags.
- Remediation can create private worktrees and Draft PRs only after strict verification; it has no merge or auto-merge path.
- Results are first-pass live QA evidence, not a replacement for a QA engineer.
