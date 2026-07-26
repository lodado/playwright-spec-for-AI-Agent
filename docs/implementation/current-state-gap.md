# Persona Runtime Current-State Gap

Recorded after the compatibility package workspace migration and before the
canonical Persona Runtime packages were added.

## Reusable foundations

| Roadmap boundary | Existing implementation | Decision |
|---|---|---|
| QA intent | compatibility `packages/adapter-playwright` | extract legacy behavior behind a workspace adapter |
| Execution planning | compatibility `packages/core` | reuse concepts; do not change legacy adaptive outcomes |
| Evidence integrity | compatibility `packages/evidence` | reuse hashing, redaction, HMAC, and tamper verification |
| Browser safety | compatibility `packages/provider-playwright` | reuse guards; add a separate behavioral driver |
| Offline judgment | compatibility `packages/judge` | preserve browserless boundary and deterministic-first order |
| Publication | compatibility `packages/reporter-github` | reuse sanitization and stable-marker patterns |

## Contract gaps

The compatibility contract named `evidence-manifest/0.1` has a checkpoint
shape that is already consumed by `qa-native`. The Persona Runtime manifest is
therefore introduced as `evidence-manifest/0.2`; the existing version is never
silently replaced.

Missing canonical objects:

- StudySpec, TaskSpec, Oracle, PersonaSpec
- SessionRecord, Observation, PerceivedObservation, InteractionEvent
- FunctionalEvaluation and behavioral evaluation objects
- SimulationValidityReport and BehavioralFingerprint
- Finding and VariantComparisonReport

## Runtime gaps

- no study/session lifecycle matching the roadmap state machine
- no cancellation-aware multi-session orchestrator
- no full semantic/runtime/visual observation contract
- current visibility filtering does not exclude below-fold or occluded elements
- no trace/screenshot/runtime monitor evidence graph for behavioral sessions
- no normal `partial` or `abandoned` terminal outcome
- current deterministic judge does not evaluate network/event/download oracles

## Behavioral and release-intelligence gaps

- no seeded behavior policy or full/perceived observation split
- no abandonment/non-action policy
- no fingerprint, diversity, stability, or calibration report
- no evidence-linked behavioral finding or static HTML report
- no paired/counterbalanced variant comparison
- no GitHub Check or marker-updated PR summary

## Go/no-go order

1. Preserve compatibility package and release tarball.
2. Add canonical contracts without changing legacy schemas.
3. Seal evidence after browser closure and support deterministic evaluation.
4. Only then add persona behavior and validity.
5. Only repeated, stable findings may influence a release gate.
