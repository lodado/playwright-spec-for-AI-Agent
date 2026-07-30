---
"playwright-spec-for-ai-agent": minor
---

`qa-native execute` now takes a spec source that is either an explicit `--spec=<file>` or a
`--page=<name>`. Page mode resolves the page's designated `__tests__` directory and base URL from
the project config (`hermes-qa.config.mjs` / `playwright-spec-for-ai-agent.config.mjs`), compiles
and merges every `*.spec.ts` under it into one run, and skips the scenarios that cannot run against
the live target — so a run stays tied to the specs you defined for a page instead of an ad-hoc plan.
An explicit `--spec` always wins; giving both or neither is an error.
