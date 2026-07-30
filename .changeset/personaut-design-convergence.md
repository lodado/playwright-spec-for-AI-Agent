---
"@lodado/personaut": minor
---

Realign the deferred fail-loud design decisions per the maintainer's plan: budget exhaustion (action/time/no-progress) now terminates as a clean ABANDONED with the budget code preserved instead of runtime_error, so it counts toward abandonment and is no longer excluded from variant comparison as infrastructure; one session's evidence-seal failure no longer aborts the whole run (the in-memory manifest is returned and that session degrades to runtime_error while siblings still complete and report); variant comparison reports insufficient_evidence below 5 comparable pairs per arm rather than declaring a winner off a single flipped session; and the hyperactivity heuristic only applies when the action budget is large enough for its ">=80%" ratio to be meaningful.
