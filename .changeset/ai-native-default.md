---
"playwright-spec-for-ai-agent": minor
---

`qa-native execute` now defaults to AI-native execution (`--provider=hermes --mode=adaptive`).
Passing `--mode=strict` (or `--provider=playwright`) still selects the deterministic read-only
provider; either flag alone infers the matching pair. Runs that previously relied on the implicit
strict default now run adaptively unless they pass `--mode=strict`.
