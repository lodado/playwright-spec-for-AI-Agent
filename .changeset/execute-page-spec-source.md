---
"playwright-spec-for-ai-agent": minor
---

`qa-native execute` now takes a spec source that is either an explicit `--spec=<file>` or a
`--page=<name>`. Page mode reads the project config (`hermes-qa.config.mjs` /
`playwright-spec-for-ai-agent.config.mjs`) and runs only the specs it designates for the page: from
the page's `__tests__` directory, the specs whose `@qa-scenario` matches the page's
`expectedSubscriptionStatus` (case-insensitive; page config, then the `staging` default), plus any
`// @qa-always-run: true`, minus any `// @qa-live-skip: true`. When no status is configured the whole
directory is designated. Navigation uses the config's per-page `targetPath`, and `--base-url`
defaults to `batch.defaultBaseUrl`. An explicit `--spec` always wins; giving both or neither is an
error. This keeps a run tied to the specs designated for a page's state instead of an ad-hoc plan.
