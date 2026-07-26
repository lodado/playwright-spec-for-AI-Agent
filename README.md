<div align="center">

# Playwright Spec for AI Agent Workspace

**Behavioral release intelligence for Playwright-era web releases — while preserving the original live staging QA package.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-10.33.0-F69220?style=for-the-badge&logo=pnpm&logoColor=white)](https://pnpm.io)
[![Playwright](https://img.shields.io/badge/Playwright-1.60-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev)
[![npm](https://img.shields.io/npm/v/playwright-spec-for-ai-agent?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/playwright-spec-for-ai-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

<br />

[![Playwright](https://img.shields.io/badge/%23Playwright-2EAD33?style=flat-square)](https://github.com/topics/playwright)
[![Behavioral Testing](https://img.shields.io/badge/%23BehavioralTesting-0A66C2?style=flat-square)](https://github.com/topics/software-testing)
[![Quality Assurance](https://img.shields.io/badge/%23QualityAssurance-2EA44F?style=flat-square)](https://github.com/topics/quality-assurance)
[![AI Agent](https://img.shields.io/badge/%23AIAgent-FF6F00?style=flat-square)](https://github.com/topics/ai-agent)
[![Release Intelligence](https://img.shields.io/badge/%23ReleaseIntelligence-6E40C9?style=flat-square)](https://github.com/topics/test-automation)

<br />

[Persona Runtime](#persona-runtime) · [End-to-end example](#end-to-end-example) · [Quick start](#quick-start) · [Commands](#commands) · [Playwright annotations](./packages/playwright-spec-adapter/README.md#playwright-annotations) · [Legacy package](./apps/playwright-spec-for-ai-agent/README.md)

</div>

---

> [!NOTE]
> This repository is now a workspace. Use **Persona Runtime** when you want sealed browser evidence, persona policies, validity reports, and baseline/candidate comparison. Use [`playwright-spec-for-ai-agent`](./apps/playwright-spec-for-ai-agent/README.md) when your existing Playwright specs should drive the original Hermes live staging QA flow.

The workspace contains two related systems:

| System | Status | What it does |
| --- | --- | --- |
| [`persona-runtime`](./apps/persona-runtime-cli/README.md) | private workspace CLI | Runs behavior-policy browser sessions, seals evidence, evaluates outcomes, and writes JSON + static HTML reports. |
| [`playwright-spec-for-ai-agent`](./apps/playwright-spec-for-ai-agent/README.md) | backwards-compatible npm package | Preserves the original `spec → abstract-ai → judge → review → slack` Hermes-based live QA flow. |

```text
StudySpec → persona browser sessions → sealed evidence → browserless evaluation → JSON + HTML report
```

## Table of Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [Persona Runtime](#persona-runtime)
- [End-to-end example](#end-to-end-example)
- [Command flow](#command-flow)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Outputs](#outputs)
- [Packages](#packages)
- [Safety](#safety)
- [Limits](#limits)
- [Legacy package](#legacy-package)

## Why this exists

Normal Playwright tests are excellent at deterministic checks: mocked states, selectors, API fixtures, and repeatable CI regressions.

Release readiness needs a different signal too. A page can pass deterministic tests and still hide the next action below the fold, make cautious buyers loop, or create ambiguous progress for a first-time user.

Persona Runtime adds that behavioral release check:

- independent browser sessions run against a real target URL
- persona policies choose only bounded, allowed actions
- every session writes sealed evidence before judgment
- the evaluator reads saved evidence after the browser closes
- findings include validity warnings instead of pretending synthetic sessions are real users

It is release decision support, not a conversion-rate oracle.

## What it does

Persona Runtime:

1. Validates a versioned `StudySpec` file.
2. Expands tasks across persona presets and seeds.
3. Opens isolated Playwright `BrowserContext` sessions.
4. Captures screenshots, observations, events, traces, and artifacts.
5. Evaluates deterministic success oracles from sealed evidence.
6. Aggregates friction findings, recurrence, validity, and variant comparison.
7. Writes canonical JSON and a static HTML report.

The legacy npm package remains unchanged for teams that want Playwright spec intent converted into Hermes live staging judgment.

## Persona Runtime

Persona Runtime follows four rules that matter for release decisions:

| Rule | Meaning |
| --- | --- |
| Evidence precedes judgment | Browser sessions write sealed manifests and artifacts before evaluation starts. |
| Code owns workflow | State transitions, budgets, safety gates, deterministic oracles, and report generation stay in code. |
| AI is bounded | Persona policy chooses from allowed browser actions; hidden DOM controls are not offered as perceived options. |
| Synthetic results stay scoped | Reports include calibration and human-validation boundaries before release claims. |

## End-to-end example

The included hidden-CTA fixture serves a page where the successful action is below the initial mobile viewport.

### ① Input excerpt — [`examples/hidden-cta/study.yaml`](./examples/hidden-cta/study.yaml)

This excerpt shows the target, oracle, personas, and seeds. The linked file is the full runnable StudySpec, including safety policy, model roles, evidence, and evaluation settings.

```yaml
schemaVersion: study-spec/0.1
study:
  id: hidden-cta
  name: Hidden below-fold CTA
environment:
  baseUrl: http://127.0.0.1:4179
  allowedOrigins:
    - http://127.0.0.1:4179
  viewport:
    width: 390
    height: 844
tasks:
  - id: open-report
    goal: Open behavioral report
    successOracles:
      - id: completed-route
        type: url
        operation: contains
        value: /complete
    maxActions: 5
    abandonmentAllowed: true
personas:
  - preset: impatient_new_user
  - preset: careful_business_buyer
  - preset: low_domain_knowledge_user
runtime:
  seeds: [101, 202, 303]
```

### ② Run — real browser sessions

Terminal 1:

```bash
pnpm fixture:hidden-cta
```

Terminal 2:

```bash
pnpm persona-runtime run examples/hidden-cta/study.yaml --output=.qa/hidden-cta
```

The study runs three persona presets across three seeds: nine isolated browser sessions.

### ③ Output — report plus machine-readable evidence

```text
.qa/hidden-cta/
├── summary.json
├── validity.json
├── findings.json
├── reports/
│   └── report.html
└── sessions/
    └── <session-id>/
        ├── evidence-manifest.json
        ├── events.jsonl
        ├── observations.jsonl
        ├── screenshots/           # when enabled
        ├── downloads/
        ├── videos/                # on failure/all, when enabled
        └── trace.zip              # when enabled
```

Example `summary.json`:

```json
{
  "status": "complete",
  "title": "Hidden below-fold CTA",
  "humanValidation": "human_review_required"
}
```

Example validity signal:

```json
{
  "calibration": {
    "level": "uncalibrated",
    "reason": "No human reference dataset was provided."
  },
  "recommendedUse": "human_review_required"
}
```

Open the HTML report:

```text
.qa/hidden-cta/reports/report.html
```

## Command flow

```text
validate
  ↓
run: StudySpec → sessions → sealed evidence → findings → report
  ↓
compare: baseline sessions + candidate sessions → variant-comparison.json
```

| Command | Purpose |
| --- | --- |
| `validate` | Validate a StudySpec before opening a browser. |
| `run` | Run persona/task/seed sessions and write evidence plus reports. |
| `compare` | Run paired baseline/candidate targets and report relative differences. |
| `import-playwright` | Convert existing Playwright spec intent into a canonical StudySpec. |

## Quick start

Install workspace dependencies:

```bash
corepack enable
pnpm install --frozen-lockfile
```

Validate the included study:

```bash
pnpm persona-runtime validate examples/hidden-cta/study.yaml
```

Run the hidden-CTA demo:

```bash
pnpm fixture:hidden-cta
```

In another terminal:

```bash
pnpm persona-runtime run examples/hidden-cta/study.yaml --output=.qa/hidden-cta
```

## Commands

The workspace script forwards to `apps/persona-runtime-cli/bin/persona-runtime.mjs`.

```text
persona-runtime validate <study.yaml>
persona-runtime run <study.yaml> [--output=.qa/run]
persona-runtime compare <study.yaml> --baseline=<url> --candidate=<url> [--output=.qa/run]
persona-runtime import-playwright --spec-dir=<dir> --base-url=<url> --output=<study.yaml>
```

Workspace examples:

```bash
pnpm persona-runtime run examples/hidden-cta/study.yaml --output=.qa/hidden-cta
```

```bash
pnpm persona-runtime compare examples/hidden-cta/study.yaml --baseline=http://127.0.0.1:4179 --candidate=http://127.0.0.1:4179 --output=.qa/hidden-cta-compare
```

```bash
pnpm persona-runtime import-playwright --spec-dir=path/to/specs --base-url=https://staging.example.com --output=.qa/imported-study.yaml
```

## Outputs

| File | Purpose |
| --- | --- |
| `summary.json` | Run status, title, and human-validation requirement. |
| `validity.json` | Calibration, diversity, stability, risks, and forbidden interpretations. |
| `findings.json` | Evidence-linked repeated friction or failure signals. |
| `variant-comparison.json` | Baseline/candidate comparison output from `compare`. |
| `reports/report.html` | Static HTML report for humans. |
| `sessions/<session-id>/evidence-manifest.json` | Sealed session evidence manifest. |
| `sessions/<session-id>/events.jsonl` | Browser action/result event stream. |
| `sessions/<session-id>/observations.jsonl` | Per-action semantic/runtime observations. |

## Packages

| Package | Role |
| --- | --- |
| [`apps/persona-runtime-cli`](./apps/persona-runtime-cli/README.md) | CLI assembly for validate/import/run/compare. |
| [`packages/contracts`](./packages/contracts/README.md) | Versioned StudySpec, evidence, evaluation, finding, and validation contracts. |
| [`packages/runtime-core`](./packages/runtime-core/README.md) | Session state machine, orchestration, budgets, and filesystem session store integration. |
| [`packages/playwright-driver`](./packages/playwright-driver/README.md) | Direct Playwright browser/context/page driver and evidence capture. |
| [`packages/persona-policy`](./packages/persona-policy/README.md) | Seeded behavior presets, attention filtering, and abandonment policy. |
| [`packages/evaluator`](./packages/evaluator/README.md) | Functional evaluation, behavioral fingerprints, findings, validity, and variant comparison. |
| [`packages/reporter-html`](./packages/reporter-html/README.md) | Static HTML report renderer. |
| [`packages/reporter-github`](./packages/reporter-github/README.md) | GitHub Check/comment formatter primitives. |
| [`packages/playwright-spec-adapter`](./packages/playwright-spec-adapter/README.md) | Legacy Playwright spec parser and StudySpec compiler. |
| [`apps/playwright-spec-for-ai-agent`](./apps/playwright-spec-for-ai-agent/README.md) | Backwards-compatible npm package and Hermes/QA Native commands. |

## Safety

- Browser contexts are isolated per session.
- Study `allowedOrigins` and safety policy gate navigation, click, typing, upload, mutation, and external-origin behavior.
- Hidden DOM controls are not exposed to persona policy as perceived options.
- Browser capability closes before browserless evaluation.
- Evidence manifests, artifact hashes, and manifest membership are verified before reporting success.
- Secret-bearing studies should keep secrets in operator-controlled config or environment variables.

## Limits

- `persona-runtime` is a private workspace app in this repository, not a separately published npm package.
- Synthetic sessions are decision support. Without real user calibration, reports stay `uncalibrated` and must not be described as actual user conversion predictions.
- Study files are trusted operator inputs. CI or hosted use should set explicit allowed origins/hosts.
- Baseline/candidate comparison reports relative differences only.
- Legacy `playwright-spec-for-ai-agent` behavior is intentionally preserved; new behavioral runtime work lives outside the old script pipeline.

## Legacy package

The original npm package keeps its command shape:

```bash
npx playwright-spec-for-ai-agent spec --page=pricing
npx playwright-spec-for-ai-agent abstract-ai --page=pricing
npx playwright-spec-for-ai-agent judge --page=pricing
npx playwright-spec-for-ai-agent review --page=pricing
npx playwright-spec-for-ai-agent slack --page=pricing
npx playwright-spec-for-ai-agent nightly --page=pricing
```

Start at [`apps/playwright-spec-for-ai-agent`](./apps/playwright-spec-for-ai-agent/README.md) when Playwright specs are your QA intent source and Hermes should judge a staging page.

## Validate the workspace

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm package:smoke
```

Playwright source annotations shared by the compatibility package and Persona Runtime are documented in the [Playwright Spec Adapter README](./packages/playwright-spec-adapter/README.md#playwright-annotations).
