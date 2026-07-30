---
"@lodado/personaut": patch
"playwright-spec-for-ai-agent": patch
---

Extract the Hermes CLI transport into a shared private package `@persona-runtime/hermes-transport` so personaut no longer deep-imports a file inside the sibling app (`../../playwright-spec-for-ai-agent/scripts/hermes-runner.mjs`) with no declared dependency edge. personaut now imports the package and bundles it. qa-native ships raw `.mjs`, so its `scripts/hermes-runner.mjs` re-exports the package in the monorepo and a `prepack` step inlines the package back into that path for publish, keeping the published artifact self-contained. No runtime behavior changes for either package.
