---
"playwright-spec-for-ai-agent": patch
---

Collapse duplicated adaptive-protocol rules into single sources. The action vocabulary is now
defined once as `ACTION_SPECS` in contracts — lease building, safe-recovery, milestone semantics,
the gateway guard, parameter-key validation, element-bound actions, the audit artifact shape, and
the Hermes execution prompt version all derive from it instead of keeping their own copies. Audit
artifact shape ("five snapshots plus report_blocked's VISIBLE_TEXT") is defined once as
`auditArtifactShape` and consumed by both the provider seal and the evidence validator. The
observation-settle wait is defined once as `observationSettleBudget` in core and shared by strict
observation and adaptive snapshot capture. Behaviour-invariant: the sealed lease order and
completion semantics are unchanged (equivalence tests lock them); the Hermes execution prompt
version string changes because it now hashes `ACTION_SPECS`.
