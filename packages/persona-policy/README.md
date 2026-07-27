<div align="center">

# @persona-runtime/persona-policy

**Seeded behavior policies for synthetic browser sessions.**

![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?style=for-the-badge&logo=typescript&logoColor=white)
![Private workspace](https://img.shields.io/badge/workspace-private-0f766e?style=for-the-badge)

<br />

![Persona Policy](https://img.shields.io/badge/%23PersonaPolicy-f97316?style=flat-square)
![Seeded Sampling](https://img.shields.io/badge/%23SeededSampling-2563eb?style=flat-square)
![Abandonment](https://img.shields.io/badge/%23Abandonment-b91c1c?style=flat-square)
![Attention Model](https://img.shields.io/badge/%23AttentionModel-047857?style=flat-square)

<br />

[Quick start](#quick-start) · [Policy model](#policy-model) · [API](#api) · [Safety](#safety) · [Test](#test)

</div>

---

> [!NOTE]
> Persona policies are behavior parameters, not demographic truth. They create reproducible variation for synthetic browser sessions and must not be reported as real user preference or conversion prediction.

`@persona-runtime/persona-policy` samples retry, backtrack, abandonment, signup resistance, reading depth, attention, and recovery behavior from a seed, then updates runtime persona state from observed session signals.

```text
study seed + task + persona + variant → sampled behavior policy → perceived elements → action bias / abandonment
```

### Policy flow example

> **One session identity** → deterministic sampled policy → attention-filtered controls → abandonment can be a valid terminal outcome.

<table>
<tr>
  <td align="center"><strong>① derive</strong><br/><code>session seed</code></td>
  <td align="center">→</td>
  <td align="center"><strong>② sample</strong><br/><code>policy values</code></td>
  <td align="center">→</td>
  <td align="center"><strong>③ reduce</strong><br/><code>progress / trust / frustration</code></td>
</tr>
</table>

---

## Table of Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [Policy model](#policy-model)
- [API](#api)
- [Quick start](#quick-start)
- [Outputs](#outputs)
- [Safety](#safety)
- [Test](#test)
- [Limits](#limits)

## Why this exists

Personaut needs repeatable behavioral variation without pretending that prose personas are real people. This package turns persona presets and seeds into concrete policy values that runtime code can serialize, replay, and audit.

## What it does

`@persona-runtime/persona-policy` owns:

- behavior policy distributions and preset definitions
- deterministic random sampling from a session seed
- runtime persona state reduction
- perceived element filtering for attention policy
- abandonment decisions as normal behavioral outcomes

It does not launch browsers, validate StudySpecs, call models, create findings, render reports, or make demographic predictions.

## Policy model

Built-in presets:

```text
impatient_new_user
careful_business_buyer
low_domain_knowledge_user
exploratory_power_user
price_sensitive_user
```

Each preset is a `BehaviorPolicyDefinition` with distributions for retry, backtrack, abandonment, signup resistance, price sensitivity, exploration, reading depth, error recovery, and no-action propensity.

## API

| Export | Purpose |
| --- | --- |
| `PRESETS` | Built-in behavior policy definitions. |
| `deriveSessionSeed(studySeed, taskId, personaId, variant, repetitionIndex)` | Deterministic seed derivation for one session. |
| `createRandom(seed)` | Reproducible pseudo-random number generator. |
| `sampleDistribution(distribution, random)` | Samples fixed, categorical, beta, normal, or empirical distributions. |
| `sampleBehaviorPolicy(definition, seed)` | Samples and serializes a behavior policy. |
| `createPersonaState()` | Creates initial progress/frustration/trust state. |
| `reducePersonaState(state, signals)` | Updates state from runtime signals. |
| `filterPerceivedElements(elements, attention, seed)` | Keeps only behaviorally perceived candidates. |
| `evaluateAbandonment(input)` | Returns whether the session should abandon and why. |

## Quick start

Build the TypeScript package, then sample a deterministic policy:

```bash
pnpm --filter @persona-runtime/persona-policy build
```

```js
import {
  PRESETS,
  deriveSessionSeed,
  sampleBehaviorPolicy,
} from "@persona-runtime/persona-policy";

const seed = deriveSessionSeed(101, "upload-task", "impatient_new_user");
const sampled = sampleBehaviorPolicy(PRESETS.impatient_new_user, seed);

console.log(sampled.seed);
console.log(sampled.values.abandonmentPropensity >= 0);
```

## Outputs

| Output/type | Shape |
| --- | --- |
| `SampledBehaviorPolicy` | `{ seed, values }`, where `values` is keyed by `BehaviorPolicyDefinition` fields. |
| `PersonaRuntimeState` | `perceivedProgress`, `frustration`, `trust`, `perceivedValue`, `confidence`, `noProgressCount`, `recoveryAttempts`, `backtrackCount`, `knownFacts`, and `uncertainties`. |
| Filtered elements | Visible, unoccluded observed elements after viewport, secondary-navigation, score, and max-candidate filtering. |
| `evaluateAbandonment(...)` result | `{ shouldAbandon, reasonCode?, deterministicSignals, sampledProbability? }`. |

## Safety

- Behavior is encoded as policy values, not only narrative text.
- Sampling is deterministic for the same seed and session identity.
- Hidden and occluded controls are filtered out of perceived elements.
- Abandonment is allowed to be a terminal outcome; success is not forced.
- This package does not claim actual user conversion or preference prediction.

## Test

```bash
pnpm --filter @persona-runtime/persona-policy test
pnpm --filter @persona-runtime/persona-policy typecheck
pnpm --filter @persona-runtime/persona-policy build
```

## Limits

- Presets are synthetic policy curves, not validated market segments.
- The package does not decide the final browser action by itself; runtime policy code applies these sampled values to observations.
- The package does not evaluate product success or generate findings.
- Human validation is required before user-impact claims.
