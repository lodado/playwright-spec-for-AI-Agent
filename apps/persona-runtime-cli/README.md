# Persona Runtime CLI

**Behavioral release intelligence from StudySpec files.**

`persona-runtime` runs real Playwright browser sessions, stores sealed evidence, closes the browser, then evaluates functional and behavioral outcomes from the saved evidence.

## What it runs

```text
StudySpec
→ persona × task × seed browser sessions
→ sealed session evidence
→ deterministic functional evaluation
→ validity + finding aggregation
→ JSON + static HTML report
```

The CLI is intentionally small. Workflow, safety gates, budgets, and deterministic oracles live in code; persona policy only chooses bounded browser actions.

## Commands

```text
persona-runtime validate <study.yaml>
persona-runtime run <study.yaml> [--output=.qa/run]
persona-runtime compare <study.yaml> --baseline=<url> --candidate=<url> [--output=.qa/run]
persona-runtime import-playwright --spec-dir=<dir> --base-url=<url> --output=<study.yaml>
```

From the workspace root, use the package script:

```bash
pnpm persona-runtime validate examples/hidden-cta/study.yaml
```

```bash
pnpm persona-runtime run examples/hidden-cta/study.yaml --output=.qa/hidden-cta
```

## Hidden CTA demo

Terminal 1:

```bash
pnpm fixture:hidden-cta
```

Terminal 2:

```bash
pnpm persona-runtime run examples/hidden-cta/study.yaml --output=.qa/hidden-cta
```

Open:

```text
.qa/hidden-cta/reports/report.html
```

The study uses three persona presets and three seeds against independent browser contexts. Sessions may succeed or abandon; abandonment is a valid behavioral outcome, not a runtime failure.

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

## Safety notes

- Browser contexts are isolated per session.
- Hidden DOM controls are not exposed to persona policy as perceived options.
- Browser capability closes before browserless evaluation.
- Secret-bearing studies should keep secrets in operator-controlled config/env and restrict allowed origins.
- Uncalibrated synthetic findings require human review before user-impact claims.
