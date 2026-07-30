---
"playwright-spec-for-ai-agent": minor
---

Strict execution now performs `@qa-fixture` file uploads. An `UPLOAD` interaction (a
`setInputFiles("name")` call) replays the file declared by `// @qa-fixture: name=path` into the
target input via Playwright's `setInputFiles`. The fixture path is repo-relative and resolved
strictly inside the project root (no symlink escape, 32 MB cap) before the browser touches it; an
upload whose argument names no declared fixture is blocked (`UPLOAD_FIXTURE_UNRESOLVED`) rather than
run. Upload stays a strict-mode-only exception — the adaptive/AI provider never uploads. The QA IR
scenario gains an optional `fixtures` map and execution-plan interaction nodes an optional `value`
(both additive; no schemaVersion bump).
