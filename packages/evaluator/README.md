# Persona Runtime Evaluator

<p align="center">
  <strong>Evaluate sealed browser evidence before any behavioral claim leaves the runtime.</strong><br>
  Deterministic oracles, friction extraction, validity checks, findings, variant deltas, and release gates live here.
</p>

<p align="center">
  <img alt="Node 20 or newer" src="https://img.shields.io/badge/node-%3E%3D20-111827?style=flat-square">
  <img alt="Evidence first" src="https://img.shields.io/badge/evidence-sealed_first-2563eb?style=flat-square">
  <img alt="Model free path" src="https://img.shields.io/badge/oracles-model_free-047857?style=flat-square">
</p>

## Where it fits

```text
Sealed EvidenceManifest 0.2
  ├─ Functional evaluation
  ├─ Behavioral fingerprints
  ├─ Simulation validity
  ├─ Evidence-linked findings
  └─ Variant comparison / release gate
```

The evaluator is browserless. It reads session records, observations, events, and sealed manifests produced by runtime packages.

## Public surface

| Export | Purpose |
|---|---|
| `evaluateFunctionalSession(input)` | Validates sealed evidence links and evaluates task oracles. |
| `evaluateOracle(oracle, context, customEvaluators)` | Evaluates one deterministic or custom oracle. |
| `createBehavioralFingerprint(input)` | Converts a session trajectory into route/action/error metrics. |
| `evaluateSimulationValidity(input)` | Reports calibration, diversity, stability, and synthetic-risk warnings. |
| `extractFrictionPoints(input)` | Creates evidence-linked friction points from failed/no-progress events. |
| `clusterFrictionPoints(points)` | Groups repeated friction deterministically. |
| `createFindings(input)` | Produces evidence-backed findings with maturity and confidence. |
| `compareVariants(input)` | Computes relative baseline/candidate metrics. |
| `evaluateReleaseGate(input)` | Maps findings and comparison status to release conclusions. |

## Minimal example

```js
import { createBehavioralFingerprint } from "@persona-runtime/evaluator";

const fingerprint = createBehavioralFingerprint({
  session: { sessionId: "s1", status: "abandoned", terminalReason: { code: "no_progress" } },
  events: [{
    id: "e1",
    action: { type: "idle" },
    urlBefore: "https://app.test/start",
    urlAfter: "https://app.test/start",
    result: { status: "success" },
    derivedSignals: { noProgress: true, progressChanged: false },
  }],
});

console.log(fingerprint.schemaVersion); // behavioral-fingerprint/0.1
console.log(fingerprint.abandonmentOccurred); // true
```

## Oracle support

| Oracle type | Evidence source |
|---|---|
| `url` | Latest observation URL. |
| `visible_text` | Visible semantic text. |
| `element` | Visible semantic element inventory. |
| `network` | Manifest metadata for network evidence. |
| `event` | Manifest metadata for action-result evidence. |
| `download` | Manifest metadata for download evidence. |
| `custom` | Explicit custom evaluator allowlist. |

Unsafe regex-like oracles are rejected before evaluation.

## Safety and validity boundaries

- Functional evaluation requires a sealed `evidence-manifest/0.2` with a matching manifest hash.
- Session, observation, event, and manifest links are checked before oracle results are trusted.
- The evaluator does not open a browser, read private credentials, or infer hidden DOM state.
- Uncalibrated validity reports include forbidden interpretations such as real conversion claims.
- Variant comparison reports relative deltas only; it does not predict actual user conversion.

## Workspace commands

```bash
pnpm --filter @persona-runtime/evaluator test
pnpm --filter @persona-runtime/evaluator typecheck
pnpm --filter @persona-runtime/evaluator build
```
