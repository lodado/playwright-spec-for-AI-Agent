<div align="center">

# Persona Runtime CLI

**Run behavior-policy browser sessions from StudySpec files, then judge sealed evidence without a browser.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.60-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev)
[![Workspace](https://img.shields.io/badge/workspace-private-0f766e?style=for-the-badge)](../../README.md)
[![StudySpec](https://img.shields.io/badge/StudySpec-0.1-6E40C9?style=for-the-badge)](../../packages/contracts/README.md)

<br />

[![Behavioral Testing](https://img.shields.io/badge/%23BehavioralTesting-0A66C2?style=flat-square)](https://github.com/topics/software-testing)
[![Evidence](https://img.shields.io/badge/%23Evidence-4b5563?style=flat-square)](../../packages/contracts/README.md)
[![Quality Assurance](https://img.shields.io/badge/%23QualityAssurance-2EA44F?style=flat-square)](https://github.com/topics/quality-assurance)
[![AI Agent](https://img.shields.io/badge/%23AIAgent-FF6F00?style=flat-square)](https://github.com/topics/ai-agent)

<br />

[Quick start](#quick-start) · [Commands](#commands) · [End-to-end example](#end-to-end-example) · [Outputs](#outputs) · [Safety](#safety) · [Workspace](../../README.md)

</div>

---

> [!NOTE]
> `persona-runtime` is a private workspace CLI. It is separate from the published [`playwright-spec-for-ai-agent`](../../apps/playwright-spec-for-ai-agent/README.md) package, which keeps the original Hermes live staging QA commands.

`persona-runtime` runs real Playwright browser sessions, stores sealed evidence, closes the browser, then evaluates functional and behavioral outcomes from saved evidence.

```text
StudySpec
→ persona × task × seed browser sessions
→ sealed session evidence
→ deterministic functional evaluation
→ validity + finding aggregation
→ JSON + static HTML report
```

## Table of Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [Command flow](#command-flow)
- [Quick start](#quick-start)
- [Commands](#commands)
- [End-to-end example](#end-to-end-example)
- [Import Playwright specs](#import-playwright-specs)
- [Compare variants](#compare-variants)
- [Outputs](#outputs)
- [Safety](#safety)
- [Limits](#limits)

## Why this exists

A deterministic Playwright test can prove a selector works under known fixture state. It does not show whether a first-time user misses a below-fold action, whether careful users loop, or whether a release creates repeated no-progress behavior.

This CLI gives release teams an evidence-first behavioral check without replacing normal tests.

## What it does

The CLI:

1. Reads a versioned StudySpec YAML file.
2. Validates environment, persona, task, oracle, safety, and evidence shape.
3. Runs each persona/task/seed in an isolated Playwright context.
4. Saves screenshots, observations, events, traces, and artifacts.
5. Seals the evidence manifest.
6. Evaluates deterministic success oracles after browser execution.
7. Writes validity, findings, optional variant comparison, and a static HTML report.

Workflow, safety gates, budgets, and deterministic oracles live in code; persona policy only chooses bounded browser actions.

## Command flow

```text
validate → run → reports
             └─ compare baseline/candidate

import-playwright → StudySpec → validate/run
```

| Command | Purpose |
| --- | --- |
| `validate` | Check a StudySpec without opening a browser. |
| `run` | Execute persona browser sessions and write evidence-backed reports. |
| `compare` | Run paired baseline/candidate targets and write relative comparison output. |
| `import-playwright` | Compile existing Playwright spec intent into a StudySpec. |

## Quick start

From the workspace root:

```bash
corepack enable
pnpm install --frozen-lockfile
```

Validate the included hidden-CTA study:

```bash
pnpm persona-runtime validate examples/hidden-cta/study.yaml
```

Run it against the fixture:

```bash
pnpm fixture:hidden-cta
```

In another terminal:

```bash
pnpm persona-runtime run examples/hidden-cta/study.yaml --output=.qa/hidden-cta
```

Open:

```text
.qa/hidden-cta/reports/report.html
```

## Commands

```text
persona-runtime validate <study.yaml>
persona-runtime run <study.yaml> [--output=.qa/run]
persona-runtime compare <study.yaml> --baseline=<url> --candidate=<url> [--output=.qa/run]
persona-runtime import-playwright --spec-dir=<dir> --base-url=<url> --output=<study.yaml>
```

Workspace script examples:

```bash
pnpm persona-runtime validate examples/hidden-cta/study.yaml
```

```bash
pnpm persona-runtime run examples/hidden-cta/study.yaml --output=.qa/hidden-cta
```

```bash
pnpm persona-runtime compare examples/hidden-cta/study.yaml --baseline=http://127.0.0.1:4179 --candidate=http://127.0.0.1:4179 --output=.qa/hidden-cta-compare
```

## End-to-end example

> **One StudySpec** → nine isolated browser sessions → sealed evidence → HTML and JSON reports.

<table>
<tr>
  <td align="center"><strong>① validate</strong><br/><code>study.yaml</code></td>
  <td align="center">→</td>
  <td align="center"><strong>② run</strong><br/><code>sessions/&lt;id&gt;</code></td>
  <td align="center">→</td>
  <td align="center"><strong>③ evaluate</strong><br/><code>findings.json</code></td>
  <td align="center">→</td>
  <td align="center"><strong>④ report</strong><br/><code>report.html</code></td>
</tr>
</table>

Input excerpt:

```yaml
tasks:
  - id: open-report
    goal: Open behavioral report
    successOracles:
      - type: url
        operation: contains
        value: /complete
personas:
  - preset: impatient_new_user
  - preset: careful_business_buyer
  - preset: low_domain_knowledge_user
runtime:
  seeds: [101, 202, 303]
```

Run:

```bash
pnpm persona-runtime run examples/hidden-cta/study.yaml --output=.qa/hidden-cta
```

Output excerpt:

```json
{
  "status": "complete",
  "title": "Hidden below-fold CTA",
  "humanValidation": "human_review_required"
}
```

The validity report marks the run as uncalibrated unless a human reference dataset is provided.

## Import Playwright specs

Use the adapter when existing Playwright specs are the source of QA intent:

```bash
pnpm persona-runtime import-playwright --spec-dir=path/to/specs --base-url=https://staging.example.com --output=.qa/imported-study.yaml
```

The adapter preserves legacy annotation/live-policy semantics, then writes a canonical StudySpec.

## Compare variants

```bash
pnpm persona-runtime compare examples/hidden-cta/study.yaml --baseline=http://127.0.0.1:4179 --candidate=http://127.0.0.1:4179 --output=.qa/hidden-cta-compare
```

Comparison uses paired policy sampling when available. The report shows relative differences only. It does not claim actual user conversion impact.

## Outputs

A run directory contains:

```text
<run-dir>/
├── summary.json
├── validity.json
├── findings.json
├── variant-comparison.json      # compare only
├── reports/
│   └── report.html
└── sessions/
    └── <session-id>/
        ├── evidence-manifest.json
        ├── events.jsonl
        ├── observations.jsonl
        └── artifacts/...
```

The evaluator verifies manifest membership, hashes, and artifact bytes before reporting success.

## Safety

- Browser contexts are isolated per session.
- Hidden DOM controls are not exposed to persona policy as perceived options.
- Browser capability closes before browserless evaluation.
- Study safety policy gates read, navigation, click, typing, upload, mutation, external-origin behavior, and confirmation stopping.
- Secret-bearing studies should keep secrets in operator-controlled config or environment variables.
- Uncalibrated synthetic findings require human review before user-impact claims.

## Limits

- The CLI is private to this workspace; publishable compatibility remains in `playwright-spec-for-ai-agent`.
- Study files are trusted operator inputs.
- Variant comparison is relative and synthetic.
- Reports support release decisions; they are not a replacement for deterministic tests or real-user analytics.
