<div align="center">

# @persona-runtime/evaluator

**Browserless judgment for sealed Persona Runtime evidence.**

![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)
![ESM](https://img.shields.io/badge/module-ESM-4b5563?style=for-the-badge)
![Evidence](https://img.shields.io/badge/evidence-sealed_first-2563eb?style=for-the-badge)

<br />

![Functional Evaluation](https://img.shields.io/badge/%23FunctionalEvaluation-0f766e?style=flat-square)
![Behavioral Findings](https://img.shields.io/badge/%23BehavioralFindings-7c3aed?style=flat-square)
![Release Gates](https://img.shields.io/badge/%23ReleaseGates-b45309?style=flat-square)

<br />

[Quick start](#quick-start) · [API](#api) · [Outputs](#outputs) · [Safety](#safety) · [Workspace](../../README.md)

</div>

---

> [!NOTE]
> The evaluator never opens a browser. It reads sealed session evidence and returns functional results, behavioral fingerprints, validity warnings, findings, variant deltas, and release-gate conclusions.

```text
EvidenceManifest 0.2 + session events → evaluator → functional result + findings + release gate
```

### Input → output example

```js
import { createBehavioralFingerprint } from "@persona-runtime/evaluator";

const fingerprint = createBehavioralFingerprint({
  session: {
    sessionId: "s1",
    status: "abandoned",
    terminalReason: { code: "no_progress" },
  },
  events: [
    {
      id: "e1",
      action: { type: "idle" },
      urlBefore: "https://app.test/start",
      urlAfter: "https://app.test/start",
      result: { status: "success" },
      derivedSignals: { noProgress: true, progressChanged: false },
    },
  ],
});

console.log(fingerprint.schemaVersion);
console.log(fingerprint.abandonmentOccurred);
```

```text
behavioral-fingerprint/0.1
true
```

---

## Table of Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [API](#api)
- [Quick start](#quick-start)
- [Outputs](#outputs)
- [Safety](#safety)
- [Test](#test)
- [Limits](#limits)

## Why this exists

Browser sessions are expensive, stateful, and permissioned. Release judgment should happen after evidence is captured and sealed so conclusions can be reproduced without reopening the site.

## What it does

The package:

1. Validates sealed evidence links before trusting outputs.
2. Evaluates deterministic or custom task oracles.
3. Creates behavioral fingerprints from session trajectories.
4. Extracts and clusters friction points.
5. Produces evidence-linked findings.
6. Evaluates simulation validity and release gates.
7. Compares baseline and candidate session sets.

## API

| Export | Purpose |
| --- | --- |
| `evaluateFunctionalSession(input)` | Validates evidence links and evaluates task oracles. |
| `evaluateOracle(oracle, context, customEvaluators)` | Evaluates one deterministic or custom oracle. |
| `createBehavioralFingerprint(input)` | Converts a session trajectory into route/action/error metrics. |
| `evaluateSimulationValidity(input)` | Reports calibration, diversity, stability, and synthetic-risk warnings. |
| `extractFrictionPoints(input)` | Creates evidence-linked friction points from failed or no-progress events. |
| `clusterFrictionPoints(points)` | Groups repeated friction deterministically. |
| `createFindings(input)` | Produces findings with maturity and confidence. |
| `compareVariants(input)` | Computes relative baseline/candidate metrics. |
| `evaluateReleaseGate(input)` | Maps findings and comparison status to release conclusions. |

## Quick start

```js
import { createBehavioralFingerprint } from "@persona-runtime/evaluator";

const result = createBehavioralFingerprint({
  session: { sessionId: "s1", status: "success" },
  events: [],
});

console.log(result.schemaVersion);
```

## Outputs

The evaluator returns plain JSON-compatible objects such as:

```text
functional-evaluation/0.1
behavioral-fingerprint/0.1
friction-point/0.1
finding/0.1
simulation-validity/0.1
variant-comparison-report/0.1
```

It writes no files by itself; the CLI or reporters persist outputs.

## Safety

- Requires sealed `evidence-manifest/0.2` for functional evaluation.
- Checks session, observation, event, and manifest links before trusting oracle results.
- Does not read credentials, inspect hidden DOM state, or call Playwright.
- Rejects unsafe regex-like oracles.
- Keeps uncalibrated validity reports scoped to human review, not conversion claims.

## Test

```bash
pnpm --filter @persona-runtime/evaluator test
pnpm --filter @persona-runtime/evaluator typecheck
pnpm --filter @persona-runtime/evaluator build
```

## Limits

- Browserless evaluation can only judge evidence that the runtime captured.
- Variant comparison reports relative deltas; it does not predict actual user conversion.
- Custom oracles must be explicitly provided by the caller.
