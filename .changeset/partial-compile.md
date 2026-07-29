---
"playwright-spec-for-ai-agent": minor
---

Compile Playwright specs per scenario instead of failing the whole file closed. Opaque/dynamic steps now block only the scenario that owns them; the adapter records blocked scenario ids in `qaIr.extensions.blockedScenarioIds`, and `qa-native execute --allow-partial` runs the statically compilable scenarios while printing skipped-scenario diagnostics to stderr.
