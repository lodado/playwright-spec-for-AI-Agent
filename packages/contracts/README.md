<div align="center">

# @persona-runtime/contracts

**Versioned JSON contracts for every Persona Runtime boundary.**

![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)
![ESM](https://img.shields.io/badge/module-ESM-4b5563?style=for-the-badge)
![Private workspace](https://img.shields.io/badge/workspace-private-0f766e?style=for-the-badge)

<br />

![StudySpec](https://img.shields.io/badge/%23StudySpec-2563eb?style=flat-square)
![Sealed Evidence](https://img.shields.io/badge/%23SealedEvidence-047857?style=flat-square)
![Contract Validation](https://img.shields.io/badge/%23ContractValidation-7c3aed?style=flat-square)
![Canonical Hash](https://img.shields.io/badge/%23CanonicalHash-b45309?style=flat-square)

<br />

[Quick start](#quick-start) · [API](#api) · [Contracts](#contracts) · [Safety](#safety) · [Test](#test)

</div>

---

> [!NOTE]
> This package is the shared contract layer. Runtime, evaluator, reporter, and adapter packages should validate data here before trusting it as session state, evidence, findings, validity, or report input.

`@persona-runtime/contracts` owns the stable JSON shapes and deterministic IDs that let the runtime seal browser evidence before any behavioral judgment leaves the system.

```text
StudySpec → SessionRecord → Observation/Event → sealed EvidenceManifest → Evaluation/Finding/Validity
```

### Boundary example

> **Untrusted object** → path-aware validation → frozen contract object → canonical hash or stable ID.

```js
import {
  STUDY_SPEC_VERSION,
  canonicalHash,
  createSessionId,
} from "@persona-runtime/contracts";

const sessionId = createSessionId({
  runId: "run-1",
  taskId: "checkout",
  personaId: "careful_business_buyer",
  seed: 101,
});

console.log(STUDY_SPEC_VERSION);
console.log(sessionId.startsWith("session_"));
console.log(canonicalHash({ b: 2, a: 1 }));
```

---

## Table of Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [API](#api)
- [Contracts](#contracts)
- [Quick start](#quick-start)
- [Outputs](#outputs)
- [Safety](#safety)
- [Test](#test)
- [Limits](#limits)

## Why this exists

Persona Runtime crosses several trust boundaries: YAML or JSON study input, browser observations, action events, evidence manifests, deterministic evaluations, findings, validity warnings, and reporters.

Those boundaries need one shared rule: validate the data before another package treats it as true. This package keeps that rule in one place instead of duplicating schema checks across runtime packages.

## What it does

`@persona-runtime/contracts` provides:

- schema version constants for StudySpec, session records, observations, interaction events, evidence manifests, evaluations, findings, validity, and variant comparison
- path-aware `ContractValidationError` failures
- deep-frozen validated objects
- canonical JSON serialization and SHA-256 hashes
- stable IDs for sessions, events, and evidence
- StudySpec secret redaction before hashing
- a small migration registry for `evidence-manifest/0.1` → `evidence-manifest/0.2`

It does not open browsers, parse YAML, evaluate oracles, render reports, or call model providers.

## API

| Export | Purpose |
| --- | --- |
| `validateStudySpec(value)` | Validates and freezes a canonical StudySpec. |
| `validateSessionRecord(value)` | Validates sealed/session-facing session records. |
| `validateObservation(value)` | Validates semantic, visual, runtime, and oracle observation shape. |
| `validateInteractionEvent(value)` | Validates action/result events and typed-input secrecy. |
| `validateEvidenceManifest(value)` | Requires EvidenceManifest 0.2 to be sealed. |
| `validateFunctionalEvaluation(value)` | Validates deterministic/browserless functional output. |
| `validateFinding(value)` | Requires findings to reference events and evidence. |
| `validateSimulationValidityReport(value)` | Validates calibration, diversity, stability, and risk output. |
| `validateVariantComparisonSpec(value)` / `validateVariantComparisonReport(value)` | Validates baseline/candidate comparison input and result. |
| `canonicalJson(value)` / `canonicalHash(value)` | Stable serialization and hashing independent of object key order. |
| `stableId(prefix, parts)` | Creates deterministic IDs from canonical parts. |
| `createSessionId`, `createEventId`, `createEvidenceId` | Stable ID helpers for runtime objects. |
| `migrateContract(value, to)` | Runs a registered migration. |
| `validators` / `validateContract(name, value)` | Named validator registry. |
| `ContractValidationError` / `ContractMigrationError` | Structured contract failures. |

## Contracts

Current schema version constants:

```text
study-spec/0.1
session/0.1
observation/0.1
interaction-event/0.1
evidence-manifest/0.2
functional-evaluation/0.1
friction-point/0.1
finding/0.1
simulation-validity/0.1
variant-comparison-report/0.1
```

Validated objects are deeply frozen. Treat validation as the handoff point: create a new object when data changes instead of mutating the validated value.

## Quick start

Run the package tests from the workspace root:

```bash
pnpm --filter @persona-runtime/contracts test
```

Use a validator at the boundary where your package receives contract-shaped data:

```js
import { validateObservation } from "@persona-runtime/contracts";

const observation = validateObservation(rawObservation);
```

## Outputs

This package returns in-memory values only:

| Output | Shape |
| --- | --- |
| Validated contracts | Deep-frozen JavaScript objects with `schemaVersion`. |
| Stable IDs | `session_*`, `event_*`, and `evidence_*` strings. |
| Canonical hashes | `sha256:<hex>` strings. |
| Errors | `ContractValidationError` or `ContractMigrationError` with `.code` and `.path`. |

## Safety

- Typed browser actions must use `valueRef`; plaintext `value` is rejected for `type` actions.
- Evidence manifests must be sealed before validation succeeds.
- Evidence entry paths must be contained relative paths, not absolute paths or `..` traversal.
- Findings and friction points need event and evidence references.
- Secret fixture values are redacted before StudySpec hashing.

## Test

```bash
pnpm --filter @persona-runtime/contracts test
pnpm --filter @persona-runtime/contracts typecheck
pnpm --filter @persona-runtime/contracts build
```

## Limits

- Contracts validate shape and invariants, not business-specific product correctness.
- YAML loading and CLI argument parsing live outside this package.
- The migration registry is intentionally small; only registered migrations run.
- Validated objects are immutable, so callers must build replacement objects for updates.
