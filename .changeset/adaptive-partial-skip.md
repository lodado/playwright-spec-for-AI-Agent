---
"playwright-spec-for-ai-agent": patch
---

Under `--allow-partial`, adaptive execution now skips scenarios that compile cleanly but use an
expectation or step kind the adaptive runtime cannot build (instead of failing the whole run), emits
a `SCENARIO_UNRUNNABLE` diagnostic, and narrows the written QA IR to the scenarios that actually ran.
Also hardens the Playwright AST parser against a variable declaration with no initializer.
