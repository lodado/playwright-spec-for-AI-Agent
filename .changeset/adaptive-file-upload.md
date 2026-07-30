---
"playwright-spec-for-ai-agent": minor
---

Adaptive (AI-native) execution can now perform `@qa-fixture` file uploads. An `UPLOAD` interaction
becomes an `upload_observed_element` adaptive action, offered only when the scenario declares an
upload milestone with a designated `@qa-fixture`. The agent chooses the target element; the file is
always the author-designated fixture, resolved strictly inside the project root (no symlink escape,
size cap) before `setInputFiles`. Uploads whose fixture is undeclared stay blocked. The QA IR
milestone gains an optional `fixture` field and the vocabulary gains `upload_observed_element` (both
additive).
