<div align="center">

# Design Convergence

**Evidence-driven Figma ↔ browser convergence: bind a design node to a rendered element, diff the real computed style, and accept only verified CSS-centric patches.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-alpha%20·%20Phase%204-orange?style=for-the-badge)](../../docs/design-convergence/ROADMAP.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

[What it does](#what-it-does) · [Status](#status) · [Quick start](#quick-start) · [Concepts](#concepts) · [Command tiers](#command-risk-tiers) · [Safety](#safety-and-limits) · [Roadmap](../../docs/design-convergence/ROADMAP.md) · [Workspace](../../README.md)

</div>

Design Convergence binds a Figma node to a React render boundary, compares the
normalized design against the browser's final computed style and layout box, and
accepts only verified, CSS-centric patches. It is **property-level and
evidence-driven** — not a pixel screenshot diff. A mismatch is reported as
"`padding-top` is 8px short," attributable to a source declaration, never as a
red blob.

```text
Figma node → canonical style node ─┐
                                   ├─→ deterministic property diff → evidence report → verified CSS patch
test-only DOM binding → browser render → canonical style node ─┘
```

Use it to catch design drift your Playwright/visual tests don't express as a
declaration-level fact. It does not replace deterministic CI, accessibility, or
product-behavior tests.

## Status

Alpha, built phase by phase against
[`docs/design-convergence/`](../../docs/design-convergence/). What runs today:

| Area                                                                                      | State                    |
| ----------------------------------------------------------------------------------------- | ------------------------ |
| Config / schema / error & path & secret boundaries                                        | ✅ shipped               |
| Figma fixture → canonical normalization                                                   | ✅ shipped               |
| Test-only Babel instrumentation (`data-design-node` injection)                            | ✅ shipped               |
| Next.js example (`/pricing`) with enabled/disabled build proof                            | ✅ shipped               |
| `run --case` config + case + static instrumentation preflight                             | ✅ shipped               |
| Deterministic property diff (ΔE, severity, fidelity, metrics)                             | ✅ shipped               |
| Browser rendered-style → canonical normalization                                          | ✅ shipped               |
| Live Playwright render + capture, runtime binding validation, artifacts, end-to-end `run` | ⏳ in progress (Phase 4) |
| AI binding, source attribution, patch policy, isolated verification, GitHub PR            | 📋 planned (Phases 5–9)  |

No live browser is started yet — `run --case` validates and preflights only. See
the [roadmap](../../docs/design-convergence/ROADMAP.md).

## Quick start

### Install

This is a private pnpm/turbo workspace. From the repo root:

```bash
pnpm install
pnpm -F @design-convergence/shared -F @design-convergence/config build
```

The Next.js example additionally needs `@babel/core`, which the workspace's
supply-chain policy holds back. Install it behind an install-time override — the
committed policy that protects the published packages stays strict:

```bash
pnpm install \
  --config.trustPolicy=allow-downgrade \
  --config.minimumReleaseAgeExclude=turbo \
  --config.minimumReleaseAgeExclude='@turbo/*'
```

### Author a config

`design-convergence.config.json` at your project root:

```json
{
  "figma": { "fileKey": "YOUR_FILE_KEY" },
  "execution": { "allowProjectCode": true },
  "bindings": "design-bindings.json",
  "cases": [
    {
      "id": "pricing-desktop",
      "route": "/pricing",
      "viewport": { "width": 1440, "height": 900 },
      "figmaRootNodeId": "1:2",
      "readySelector": "[data-page-ready=\"true\"]"
    }
  ]
}
```

`allowProjectCode` has no default — you must consciously opt in before any app
command, prepare module, or build runs. Secrets are authored as environment
references (`{ "env": "FIGMA_ACCESS_TOKEN" }`), never literals.

### Bind a design node to an element

`design-bindings.json` maps one Figma node to exactly one JSX element. Identity
is `elementName` + `occurrence`; `sourceRange` and `sourceHash` are stale guards
so a moved or edited target is caught, never silently re-bound:

```json
{
  "schemaVersion": 1,
  "bindings": [
    {
      "id": "pricing-card-root",
      "caseIds": ["pricing-desktop"],
      "figma": { "fileKey": "YOUR_FILE_KEY", "nodeId": "1:2" },
      "target": {
        "kind": "intrinsic-jsx-element",
        "filePath": "components/PricingCard.tsx",
        "elementName": "section",
        "occurrence": 0,
        "sourceRange": {
          "startLine": 10,
          "startColumn": 4,
          "endLine": 13,
          "endColumn": 5
        },
        "sourceHash": "sha256:…"
      },
      "runtime": {
        "attributeName": "data-design-node",
        "attributeValue": "1:2"
      },
      "status": "proposed"
    }
  ]
}
```

A binding is never `validated` on authorship — it is promoted only after static
and (in Phase 4) runtime validation both pass.

### Run the preflight

```bash
pnpm design-convergence run --case pricing-desktop
```

Today this validates the config, selects the case, and statically preflights the
bindings (resolving each against its source; a stale or ambiguous mapping exits
`2` with kind `instrumentation`), then prints the eligible binding count. Live
render and diff arrive with Phase 4.

Exit codes: `0` success · `1` deterministic product mismatch (Phase 4+) · `2`
configuration / usage / instrumentation / infrastructure failure.

### Instrument the example build

The example wires the plugin into Babel only when `DESIGN_CONVERGENCE=true`:

```bash
# instrumented: prerenders <section … data-design-node="1:2">
DESIGN_CONVERGENCE=true pnpm -F design-convergence-example-next-tailwind build
grep -o 'data-design-node="[^"]*"' .next/server/app/pricing.html

# default build: no design-node attribute
rm -rf examples/design-convergence-next-tailwind/.next
pnpm -F design-convergence-example-next-tailwind build
```

## Concepts

**Rendered Style Tree** — computed style + layout box + pseudo-element style,
captured from the browser and normalized outside the page context. Not a pure
CSSOM read.

**Canonical style node** — the framework-neutral shape both a Figma node and a
browser element normalize into (colors as 0–1 RGBA, lengths as CSS px). A value
that can't be represented is recorded in `unsupported`, never coerced to a
default and treated as equal.

**Deterministic diff** — a fixed property registry (size, padding, background,
radius, borders, opacity, typography, text color) is walked with per-property
comparators: finite numeric deltas for geometry/spacing/typography and CIEDE2000
ΔE for colors. Each record carries a status (`match` / `mismatch` /
`unsupported` / `missing-*`), a severity, and a tolerance.

**Fidelity score** — `max(0, 100 − 100 × Σ severityWeight / (comparedCount ×
criticalWeight))`. A project-relative QA metric, **not** a universal
visual-quality score. Pass/fail is decided from configured blocking severities,
never from the score, and the absolute high/critical count is always printed
next to it so a rising score can't hide unresolved records.

## Command risk tiers

| Tier                 | Examples                                                                                                                                       | Policy                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Data-only            | config parse, schema validation, fixture normalization, diff from saved artifacts                                                              | Runs by default. No network, app command, or Git write.                                                    |
| Operator-approved    | app start command, live Playwright render, Figma REST fetch, patch verification, Git worktree/branch/PR                                        | Requires explicit config + operator approval. Tokens/cookies/env are redacted from logs and any AI prompt. |
| Forbidden by default | AI-generated shell commands, destructive Git, raising tolerance to hide a failure, editing Figma artifacts, deleting a binding to force a pass | Not implemented.                                                                                           |

## Safety and limits

- Property-level and evidence-driven — **not** a pixel screenshot comparison.
  Complex blend/mask/mesh/SVG/canvas/video are recorded as `unsupported`
  evidence, never silently equated.
- Instrumentation is test-build only; production output stays uninstrumented and
  that is verified by build output, not assumed.
- No code from the target repository runs unless `execution.allowProjectCode` is
  explicitly `true`; the only command form is `spawn(executable, args, { shell:
false })` from config — AI output can never alter executable, args, cwd, or env.
- Infrastructure failures (app startup, page setup, style extraction) are kept
  distinct from product mismatches; a failed startup is never a style mismatch.
- Secrets are environment references resolved only at the REST/provider/GitHub
  boundary and redacted everywhere else. Nothing is written to shared state
  without explicit configuration.
