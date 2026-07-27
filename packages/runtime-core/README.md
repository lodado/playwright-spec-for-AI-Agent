<div align="center">

# @persona-runtime/runtime-core

**Session orchestration for evidence-first behavioral browser runs.**

![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Evidence first](https://img.shields.io/badge/evidence-before_judgment-6366f1?style=for-the-badge)
![Private workspace](https://img.shields.io/badge/workspace-private-0f766e?style=for-the-badge)

<br />

![State Machine](https://img.shields.io/badge/%23StateMachine-4f46e5?style=flat-square)
![Browser Runtime](https://img.shields.io/badge/%23BrowserRuntime-2EAD33?style=flat-square)
![Evidence Sealing](https://img.shields.io/badge/%23EvidenceSealing-047857?style=flat-square)
![Behavioral QA](https://img.shields.io/badge/%23BehavioralQA-b45309?style=flat-square)

<br />

[Quick start](#quick-start) · [Workflow](#workflow) · [API](#api) · [Safety](#safety) · [Test](#test)

</div>

---

> [!NOTE]
> This package owns the runtime state machine and orchestration gates. Browser details belong in the driver, behavior decisions belong in persona policy, and reporting belongs in reporter packages.

`@persona-runtime/runtime-core` runs the task × persona × seed matrix, enforces action/time/no-progress budgets, closes the browser driver, seals evidence, and only then allows browserless evaluation.

```text
StudySpec → session matrix → browser loop → driver.close → EvidenceManifest 0.2 → evaluate → report phase
```

### Runtime flow example

> **One StudySpec** → bounded browser sessions → sealed evidence → post-seal evaluation.

<table>
<tr>
  <td align="center"><strong>① matrix</strong><br/><code>task × persona × seed</code></td>
  <td align="center">→</td>
  <td align="center"><strong>② loop</strong><br/><code>observe → decide → execute</code></td>
  <td align="center">→</td>
  <td align="center"><strong>③ seal</strong><br/><code>evidence-manifest/0.3</code></td>
</tr>
</table>

---

## Table of Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [Workflow](#workflow)
- [API](#api)
- [Quick start](#quick-start)
- [Outputs](#outputs)
- [Safety](#safety)
- [Test](#test)
- [Limits](#limits)

## Why this exists

Behavioral QA needs a deterministic core around non-deterministic browser sessions. The runtime must know which sessions should run, when a session has exceeded a budget, when evidence is sealed, and when evaluation is allowed.

Keeping that lifecycle in code prevents persona policy, browser drivers, or reporters from inventing their own state transitions.

## What it does

`@persona-runtime/runtime-core` owns:

- session state transitions from `CREATED` through `REPORTED`
- task × persona × seed × optional variant matrix expansion
- bounded concurrency and cancellation checks
- action, duration, and no-progress budgets
- observation/action loops through injected driver, policy, oracle, and store boundaries
- per-session file store helpers for JSONL evidence artifacts
- EvidenceManifest sealing through `@persona-runtime/contracts`
- post-seal evaluation and reported phase gates

It does not launch Playwright directly, sample personas, call model providers, render HTML, publish GitHub reports, or mutate repositories.

## Workflow

```text
runStudy
  └─ buildSessionMatrix
       └─ runSession
            ├─ driver.start
            ├─ observe → oracle.evaluate → policy.decide → driver.execute
            ├─ driver.close
            ├─ seal EvidenceManifest 0.2
            └─ evaluateSealedSession → markSessionReported
```

The browser driver closes before the session reaches `EVIDENCE_SEALED`. Evaluation helpers reject unsealed session results.

## API

| Export | Purpose |
| --- | --- |
| `runStudy(options)` | Runs the task/persona/seed/variant matrix with bounded concurrency. |
| `runSession(options)` | Runs one browser-policy-oracle loop and seals evidence. |
| `buildSessionMatrix({ study, runId })` | Expands StudySpec runtime dimensions into session entries. |
| `createSessionRecord(...)` | Creates a frozen runtime session object. |
| `transitionSession(session, phase, details)` | Applies legal state transitions only. |
| `toSessionRecord(session)` | Converts runtime session state to contract `session/0.1`. |
| `evaluateSealedSession(...)` | Runs a browserless evaluator only after evidence is sealed. |
| `markSessionReported(...)` | Advances an evaluated session to reported. |
| `createFileSessionStore({ rootDir, sessionId })` | Writes `session.json`, observations JSONL, events JSONL, and manifest. |
| `deriveInteractionEvent(...)` | Converts one action result into an interaction event. |
| `RuntimeCoreError` / `RUNTIME_ERROR_CODES` | Structured runtime failures. |

## Quick start

Build a deterministic session matrix:

```js
import { buildSessionMatrix } from "@persona-runtime/runtime-core";

const matrix = buildSessionMatrix({
  runId: "run-1",
  study: {
    study: { id: "demo" },
    environment: { baseUrl: "http://127.0.0.1:4173" },
    tasks: [{
      id: "checkout",
      maxActions: 3,
      maxDurationMs: 1000,
      maxConsecutiveNoProgressActions: 1,
    }],
    personas: [{ id: "careful_business_buyer" }],
    runtime: { seeds: [101], concurrency: 1 },
  },
});

console.log(matrix[0].sessionId.startsWith("session-"));
```

Run the full runtime through the workspace CLI when you want browser evidence and reports:

```bash
pnpm personaut run examples/hidden-cta/study.yaml --output=.qa/hidden-cta
```

## Outputs

A `runStudy()` call returns a frozen object with:

| Output | Purpose |
| --- | --- |
| `runId` | Runtime run identifier. |
| `sessionCount` | Number of matrix entries executed. |
| `results[]` | Per-session state, observations, events, sealed manifest, and close evidence. |

`createFileSessionStore()` writes per-session artifacts under the run directory selected by the caller.

## Safety

- Invalid transitions throw instead of silently rewriting status.
- Actions can reference only elements in the current perceived observation.
- Evidence seal failure becomes `EVIDENCE_SEAL_FAILED`; it cannot become a false pass.
- `semanticSnapshot: "off"` omits semantic evidence and leaves judgment to components that can handle missing evidence.
- Post-terminal phases preserve the terminal status while adding sealed/evaluated/reported state.

## Test

```bash
pnpm --filter @persona-runtime/runtime-core test
pnpm --filter @persona-runtime/runtime-core typecheck
pnpm --filter @persona-runtime/runtime-core build
```

## Limits

- The driver, policy, oracle, and store are injected; this package does not decide their implementation.
- Runtime concurrency is bounded but not a distributed scheduler.
- Browserless evaluation is allowed only after evidence is sealed.
- This package does not claim user conversion impact or render human-facing reports.
