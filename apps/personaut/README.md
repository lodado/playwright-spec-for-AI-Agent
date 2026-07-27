<div align="center">

# Personaut

**Explore a web product as seeded personas and turn browser behavior into sealed evidence.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.60-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev)
[![npm](https://img.shields.io/npm/v/@lodado/personaut?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/@lodado/personaut)

[Quick start](#5-minute-quick-start) · [Use your site](#use-personaut-with-your-site) · [Commands](#commands) · [Troubleshooting](#troubleshooting) · [Workspace](../../README.md)

</div>

Personaut opens isolated Playwright sessions, lets deterministic persona policies choose bounded actions, seals the resulting evidence, and evaluates success after the browser closes.

```text
StudySpec → persona × task × seed sessions → sealed evidence → JSON + HTML report
```

Use Personaut when you want to learn whether different user behaviors can complete a task, where they stall, or whether a candidate release behaves differently from a baseline. Keep normal Playwright tests for deterministic regression coverage.

## 5-minute quick start

### 1. Install Personaut and Chromium

```bash
pnpm add -D @lodado/personaut
pnpm exec playwright install chromium
```

Requirements: Node.js 20 or newer and a URL the machine can reach.

### 2. Create a safe starter study

```bash
pnpm exec personaut init study.yaml
```

The generated study targets `https://example.com`, allows reading and navigation, disables clicks and mutations, and runs one `impatient_new_user` session. `init` refuses to overwrite an existing file.

### 3. Validate before opening a browser

```bash
pnpm exec personaut validate study.yaml
```

Expected output:

```text
Valid study-spec/0.1: example-page
```

### 4. Run the study

```bash
pnpm exec personaut run study.yaml --output=.personaut/example
```

Expected output:

```text
Report: <project>/.personaut/example/reports/report.html
```

Open the report and inspect the machine-readable summary:

```text
.personaut/example/
├── summary.json
├── validity.json
├── findings.json
├── reports/report.html
└── sessions/<session-id>/
```

The starter result is marked `exploration_only`. Personaut does not claim that synthetic sessions represent real-user conversion.

## How a study works

A StudySpec answers five questions:

| Field | Question |
| --- | --- |
| `environment` | Which URL and origins may the browser visit? |
| `tasks` | What goal should the persona attempt? |
| `successOracles` | What deterministic evidence counts as success? |
| `safetyPolicy` | Which browser actions are allowed? |
| `personas` + `runtime.seeds` | Which behaviors run, and how many sessions are created? |

Personaut evaluates `personas × tasks × seeds`. Two personas, two tasks, and three seeds create twelve isolated sessions.

## Use Personaut with your site

Start from the generated `study.yaml` and change these fields first:

```yaml
study:
  id: pricing-check
  name: Pricing page exploration

product:
  description: Public pricing experience

environment:
  baseUrl: https://staging.example.test
  allowedOrigins:
    - https://staging.example.test

tasks:
  - id: open-pricing
    name: Open pricing
    goal: Find and open the pricing page
    successOracles:
      - id: pricing-url
        type: url
        operation: contains
        value: /pricing
```

Keep `allowedOrigins` exact. Personaut blocks navigation outside this list unless the study explicitly permits external origins.

### Success oracles

| Type | Example use |
| --- | --- |
| `url` | The session reached `/complete`. |
| `visible_text` | The page visibly contains expected copy. |
| `element` | A visible, enabled, disabled, hidden, or checked element exists. |
| `event` | A named browser action occurred. |
| `custom` | Mark imported intent for manual review; arbitrary study code is not executed. |

Run `personaut validate` after every StudySpec edit.

## Persona presets

| Preset | Typical behavior |
| --- | --- |
| `impatient_new_user` | Explores little and abandons quickly. |
| `careful_business_buyer` | Reads deeply and retries cautiously. |
| `low_domain_knowledge_user` | Backtracks more and has weaker product expectations. |
| `exploratory_power_user` | Explores broadly and retries often. |
| `price_sensitive_user` | Reacts strongly to pricing and signup friction. |

Seeds make policy sampling repeatable. Reusing the same StudySpec and seeds makes baseline/candidate comparison meaningful.

## Commands

```text
personaut init [study.yaml]
personaut validate <study.yaml>
personaut run <study.yaml> [--output=.qa/run]
personaut compare <study.yaml> --baseline=<url> --candidate=<url> [--output=.qa/run]
personaut import-playwright --spec-dir=<dir> --base-url=<url> --output=<study.yaml>
```

### Import Playwright specs

Compile existing Playwright intent into a StudySpec:

```bash
pnpm exec personaut import-playwright \
  --spec-dir=tests/e2e \
  --base-url=https://staging.example.test \
  --output=study.yaml

pnpm exec personaut validate study.yaml
```

Review imported manual-review or blocked policies before running. Annotation details live in the [Playwright Spec Adapter reference](https://github.com/lodado/playwright-spec-for-AI-Agent/blob/main/packages/playwright-spec-adapter/README.md#playwright-annotations).

### Compare two variants

```bash
pnpm exec personaut compare study.yaml \
  --baseline=https://baseline.example.test \
  --candidate=https://candidate.example.test \
  --output=.personaut/comparison
```

Comparison uses paired policy sampling and reports relative synthetic differences. It does not predict real-user conversion.

## Read the output

| File | Purpose |
| --- | --- |
| `summary.json` | Overall run status and recommended use. |
| `validity.json` | Calibration, diversity, stability, and interpretation warnings. |
| `findings.json` | Repeated evidence-linked friction and failure signals. |
| `variant-comparison.json` | Baseline/candidate deltas from `compare`. |
| `reports/report.html` | Human-readable report. |
| `sessions/*/evidence-manifest.json` | Sealed artifact membership and hashes. |
| `sessions/*/events.jsonl` | Browser action and result stream. |
| `sessions/*/observations.jsonl` | Per-action semantic observations. |

Evidence files are verified against the sealed manifest before an outcome is reported as successful.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Executable doesn't exist` | Run `pnpm exec playwright install chromium`. |
| StudySpec validation fails | Run `personaut validate`, then compare required fields with the generated starter. |
| Navigation is blocked | Add the exact origin, including scheme and port, to `environment.allowedOrigins`. |
| Sessions never click | Check `safetyPolicy.allowClick` and make the task goal match visible button/link wording. |
| Everything becomes manual review | Prefer deterministic URL, text, or element success oracles. |
| Report says `uncalibrated` or `exploration_only` | This is expected without a human reference dataset; do not present the result as real-user behavior. |

## Safety and limits

- Browser contexts are isolated per session.
- Hidden or occluded controls are not offered to persona policy as perceived choices.
- Study safety policy gates navigation, clicking, typing, uploads, mutations, external origins, and confirmation stopping.
- Browser capability closes before browserless evaluation begins.
- Study files are trusted operator input; keep secrets in operator-controlled configuration or environment variables.
- Synthetic findings support release decisions but do not replace deterministic tests, analytics, or human research.

For the full schema and trust-boundary details, see the [StudySpec contracts reference](https://github.com/lodado/playwright-spec-for-AI-Agent/blob/main/packages/contracts/README.md).

## Workspace development

When working in this monorepo, replace `pnpm exec personaut` with `pnpm personaut` and use [`examples/hidden-cta`](../../examples/hidden-cta/README.md) for the local browser fixture.
