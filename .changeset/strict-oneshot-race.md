---
"playwright-spec-for-ai-agent": minor
---

Fix the strict one-shot race, surface failure detail, and stop deleting failed-run evidence.

- Strict element observation no longer races the node timeout: visibility waits apply only to VISIBLE/CONTAINS_TEXT expectations under a bounded shared budget, NOT_VISIBLE/PRESENT targets snapshot `isVisible()` immediately, and an element detached mid-observation records a MISSING fact. Consumer reproduction: strict one-shot 0/4 → 5/5 consecutive no-DEBUG runs.
- Execution failures now print the runtime outcome (`type=… code=… message=… bundles=N`) instead of an opaque "QA execution failed", and every failed run — strict or adaptive — is quarantined as `<run-dir>.invalid` with its sealed partial evidence instead of being deleted (POLICY_VIOLATION evidence stays withheld).
- `qa-native report` prints a one-line summary and treats an all-pass run as success (exit 0) instead of erroring with "no failing judgments".
- Failure diagnosis classifies judge-flagged context/auth mismatches as ENVIRONMENT (manual review, never the patch pipeline), and code location ranks the executed spec file first among pure route matches.
- `QA_NATIVE_TRACE_TIMING=1` prints one start/done line per strict node to locate hangs.
- Strict runs now allow page-initiated same-site (registrable domain) GET/HEAD requests before any interaction, so apps serving their API from a sibling origin render fully; mutations, foreign-site reads, and the stricter post-interaction same-origin rule are unchanged.
- Observation waits for VISIBLE/CONTAINS_TEXT targets still rendering (mirrors Playwright's retrying assertions), and NAVIGATE retries once when the landing bounces off the target path.
- The judge skips empty evidence items (a page observed before render sealed an empty VISIBLE_TEXT artifact and made the run unjudgeable), resamples the model once when a decision violates the SemanticJudgeDecision contract, names the failing scenario and outcome code in errors, and surfaces the underlying error with `QA_NATIVE_DEBUG`.
