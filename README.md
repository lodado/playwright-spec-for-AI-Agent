<div align="center">

# Playwright Spec for AI Agent Monorepo

**Use Playwright specs as intent, let an AI agent inspect the real product, and turn failures into evidence-backed engineering work.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-10.33.0-F69220?style=for-the-badge&logo=pnpm&logoColor=white)](https://pnpm.io)
[![Playwright](https://img.shields.io/badge/Playwright-1.60-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

[Why this exists](#why-this-exists) · [Applications](#applications) · [Real run → GitHub Issue](#from-a-real-browser-run-to-a-code-backed-github-issue)

</div>

## Why this exists

Playwright is excellent at the problem it was designed to solve: deterministic browser automation. In CI, a known fixture, a known account state, a controlled network response, and an exact assertion make regressions fast to reproduce and safe to block. We should keep those tests.

The real product is not deterministic in the same way. Production-like data changes, feature flags drift, copy and DOM structure evolve, backend latency varies, accounts accumulate state, third-party services fail, and deployments can create combinations that no mocked fixture anticipated. A Playwright test can prove that the behavior we encoded still works under its controlled conditions; it cannot by itself prove that every user-facing production state still makes sense.

That gap is why **Playwright Spec for AI Agent** was created as open source. It treats existing Playwright specs as a durable description of QA intent, then gives an AI agent the first pass over a real staging or production-like experience. Instead of blindly replaying brittle selectors and mock literals, the agent asks the higher-level question: **does the visible product still satisfy the scenario the test was written to protect?**

```text
deterministic Playwright CI
          ↓ supplies intent
AI first-pass live inspection
          ↓ seals browser evidence
FAIL / MANUAL_REVIEW
          ↓ pins the finding to repository code
reviewable report or GitHub Issue
          ↓
human ownership and final judgment
```

The project follows a few boundaries:

- **Complement Playwright; do not replace it.** Deterministic tests and API contract tests remain the primary regression gates.
- **Judge intent, not incidental mock values.** A mocked `98 pts` assertion may become a live check that a meaningful score and status are present, rather than requiring production to contain the fixture literal.
- **Preserve uncertainty.** Plausible but unproven behavior becomes `MANUAL_REVIEW`, not a fabricated pass or fail.
- **Evidence before remediation.** Browser observations are authenticated and saved before diagnosis, repository search, reporting, or publication.
- **Pin claims to code.** Code-backed reports resolve a Git revision to an exact commit and record candidate files, line ranges, and file hashes from that commit.
- **Keep live execution bounded.** Start with read-only or no-confirmation flows. Billing, destructive mutations, and mock-only authentication must not be replayed against a real environment.
- **Keep humans accountable.** The agent performs first-pass inspection and triage. It does not merge code, make production changes, or replace a QA engineer's final decision.

The monorepo also contains **Personaut**, which applies the same evidence-first philosophy to persona-driven product exploration. The workspace packages below support these two public applications.

This repository contains two public applications and the private workspace packages that support them. This README is the workspace map; open each linked directory for commands, architecture, examples, safety boundaries, and output formats.

## Applications

| Application | Package | What it does | Documentation |
| --- | --- | --- | --- |
| **Playwright Spec for AI Agent** | `playwright-spec-for-ai-agent` | Turns Playwright QA intent into AI-assisted staging execution, judgment, review, remediation, and reporting workflows. | [`apps/playwright-spec-for-ai-agent`](./apps/playwright-spec-for-ai-agent/README.md) |
| **Personaut** | `@lodado/personaut` | Explores a web product as seeded personas, seals browser evidence, evaluates deterministic outcomes, and compares variants. | [`apps/personaut`](./apps/personaut/README.md) |

### Choose an application

```text
Need existing Playwright specs to drive AI QA?   → Playwright Spec for AI Agent
Need persona-based UX exploration and evidence?  → Personaut
```

## Workspace packages

These packages are private implementation modules. Personaut bundles the modules it needs into its published package.

| Workspace | Responsibility | Documentation |
| --- | --- | --- |
| `@persona-runtime/contracts` | StudySpec, evidence, evaluation, finding, and validation contracts. | [`packages/contracts`](./packages/contracts/README.md) |
| `@persona-runtime/runtime-core` | Session state machine, orchestration, budgets, and filesystem storage. | [`packages/runtime-core`](./packages/runtime-core/README.md) |
| `playwright-driver` | Isolated Playwright sessions, safe actions, and browser evidence capture. | [`packages/playwright-driver`](./packages/playwright-driver/README.md) |
| `@persona-runtime/persona-policy` | Seeded persona presets, attention filtering, and abandonment behavior. | [`packages/persona-policy`](./packages/persona-policy/README.md) |
| `@persona-runtime/evaluator` | Browserless outcome evaluation, findings, validity, and variant comparison. | [`packages/evaluator`](./packages/evaluator/README.md) |
| `@persona-runtime/reporter-html` | Static behavioral HTML report rendering. | [`packages/reporter-html`](./packages/reporter-html/README.md) |
| `@persona-runtime/reporter-github` | GitHub Check and pull-request comment formatting primitives. | [`packages/reporter-github`](./packages/reporter-github/README.md) |
| `playwright-spec-adapter` | Playwright spec parsing and StudySpec compilation. | [`packages/playwright-spec-adapter`](./packages/playwright-spec-adapter/README.md) |

## Examples

| Example | Purpose | Documentation |
| --- | --- | --- |
| Hidden CTA | Runs Personaut against a page whose successful action begins below the mobile viewport. | [`examples/hidden-cta`](./examples/hidden-cta/README.md) |
| Compatibility examples | Demonstrates the Playwright Spec for AI Agent command and annotation formats. | [`apps/playwright-spec-for-ai-agent/examples`](./apps/playwright-spec-for-ai-agent/examples/README.md) |

## Quick start

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Run Personaut from the workspace:

```bash
pnpm personaut --help
```

Install the published CLI:

```bash
pnpm add -D @lodado/personaut
pnpm exec personaut --help
```

## From a real browser run to a code-backed GitHub Issue

`qa-native` is the evidence-driven runtime shipped by `playwright-spec-for-ai-agent`. The following path runs a bounded Playwright scenario against a real target, judges the saved evidence, connects a failure to the repository revision that produced it, and publishes one evidence-backed GitHub Issue.

> QA Native currently supports macOS and Linux. Keep `.qa/` private: it can contain screenshots, traces, paths, and staging observations. This repository already ignores `.qa/`.

### 1. Install the runtime and authenticate GitHub

Run these commands from the application repository that contains both the Playwright spec and the product code to diagnose:

```bash
npm install -D playwright-spec-for-ai-agent @playwright/test
npx playwright install chromium

gh auth login
gh auth status
```

The GitHub identity used by `gh` needs permission to read the target commit and files, search Issues and Draft PRs, create Issues, and create Issue comments. The publisher adds these labels, so they must already exist in the target repository:

```text
qa-runtime
auto-generated
origin:<diagnosed-origin>
severity:<diagnosed-severity>
scenario:<scenario-id>
```

For example, create the labels expected by one scenario before publishing:

```bash
gh label create qa-runtime --repo owner/repository --color 1D76DB
gh label create auto-generated --repo owner/repository --color D4C5F9
gh label create origin:product-code --repo owner/repository --color D93F0B
gh label create severity:medium --repo owner/repository --color FBCA04
gh label create scenario:pricing --repo owner/repository --color C5DEF5
```

Use the origin, severity, and scenario values shown by your generated report; the values above are examples. Existing labels do not need to be recreated.

### 2. Create stable authentication keys

Generate each key once, store it as a CI secret, and reuse it. `QA_NATIVE_INTEGRITY_KEY` authenticates the run archive throughout execute/judge/report. `QA_NATIVE_PUBLICATION_KEY` authenticates publication and recurrence state across nightly runs.

```bash
export QA_NATIVE_INTEGRITY_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"
export QA_NATIVE_PUBLICATION_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"
```

Changing either key makes previously authenticated state unverifiable. The CLI removes both values before invoking browser, model, Git, or GitHub subprocesses and does not persist the raw keys.

### 3. Run the real browser check

Start with an annotated, read-only Playwright spec and a new run directory. A run directory is immutable and must not already exist.

```bash
npx qa-native execute \
  --spec=tests/e2e/pricing/pricing.spec.ts \
  --base-url=https://staging.example.com \
  --run-dir=.qa/runs/pricing-2026-07-28
```

The default `--provider=playwright --mode=strict` compiles the supported Playwright subset into QA IR, creates a deterministic execution plan, opens Chromium, and saves an authenticated evidence archive. It does not publish anything.

Use a staging or production-like account that cannot perform destructive actions. See the [Playwright syntax reference](./apps/playwright-spec-for-ai-agent/PLAYWRIGHT_SYNTAX_SUPPORT.md) for the supported spec subset.

### 4. Judge the sealed evidence

```bash
npx qa-native judge --run-dir=.qa/runs/pricing-2026-07-28
```

Deterministic expectations are evaluated first. Only unresolved semantic expectations are sent to Hermes in text-only mode; the browser is not reopened. Results are written under:

```text
.qa/runs/pricing-2026-07-28/judgments/judge-<hash>/
└── judge-result-<hash>.json
```

Only `FAIL` and `MANUAL_REVIEW` results can continue to a code-backed report or Issue. `PASS` is intentionally rejected.

### 5. Generate and inspect the code-backed report

Commit the source revision you want to investigate first. Uncommitted working-tree changes are not searched: `report` resolves `--revision` to an exact commit, searches tracked source blobs from that commit, and records content hashes for the suspected files.

```bash
npx qa-native report \
  --run-dir=.qa/runs/pricing-2026-07-28 \
  --repository-root=. \
  --revision=HEAD
```

The report contains the evidence-derived diagnosis, likely code files and line ranges, and a bounded repair recommendation:

```text
.qa/runs/pricing-2026-07-28/reports/report-<hash>/
├── diagnosis-<hash>.json
├── code-context-<hash>.json
├── repair-recommendation-<hash>.json
└── report-<hash>.md
```

Review `report-<hash>.md` before publication. Code lookup uses fixed-string evidence such as test IDs, visible text, routes, and network endpoints; generated files, dependencies, secrets, lockfiles, and oversized files are excluded. A candidate is a bounded lead, not proof of root cause.

If the run contains more than one completed judgment set, or if you want to publish one result from a multi-failure run, select the result explicitly with a path relative to the run directory:

```bash
--judgment=judgments/judge-<hash>/judge-result-<hash>.json
```

### 6. Publish exactly one failure

```bash
npx qa-native publish-issue \
  --run-dir=.qa/runs/pricing-2026-07-28 \
  --repository-root=. \
  --repository=owner/repository \
  --revision=HEAD \
  --judgment=judgments/judge-<hash>/judge-result-<hash>.json
```

Immediately before publication, QA Native verifies that the pinned commit exists in `owner/repository` and that every selected file still has the recorded SHA-256 content hash. It then creates an Issue containing:

- scenario, verdict, diagnosed origin, confidence, and pinned repository revision
- expected versus observed behavior and authenticated evidence references
- suspected files and line ranges, without publishing source snippets
- uncertainty/manual-review reasons and a local replay command
- a hidden canonical fingerprint and HMAC-authenticated occurrence state

The command is deliberately an upsert, not an Issue generator that can spam the repository:

| Existing open match | Result |
| --- | --- |
| None | Create one Issue and record the occurrence. |
| Exactly one, new source run | Add one authenticated occurrence comment. |
| Exactly one, same source run | No-op. |
| More than one | Stop as ambiguous without choosing a target. |

The fingerprint excludes run IDs, evidence IDs, query strings, raw path segments, and model wording. Repeated executions therefore converge on the same open Issue when they describe the same scenario, failed expectations, normalized symptom, route shape, diagnosed origin, and leading code location.

Publication state is saved privately under `.qa/runs/<run-id>/publications/`. `publish-issue` cannot create branches, patches, pull requests, or merges. The broader `qa-native remediate --publish=auto` workflow may create a **Draft** PR only after deterministic verification, live comparison, expectation-integrity checks, and independent review; it still has no merge path. See the full [QA Native guide](./apps/playwright-spec-for-ai-agent/docs/qa-native.md).

## Workspace validation

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm package:smoke
```

## Publishing

Changesets versions and publishes the two public applications. Private workspace packages are never published; Personaut bundles its internal runtime modules before packing.

See the application READMEs for release-specific usage and limitations.
