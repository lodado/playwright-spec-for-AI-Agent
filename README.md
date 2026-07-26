# Playwright Spec for AI Agent Workspace

This repository contains the backwards-compatible
[`playwright-spec-for-ai-agent`](packages/playwright-spec-for-ai-agent/README.md)
package and the Persona Runtime packages described in [`docs/`](docs/README.md).

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
```

Run the Behavioral MVP against the included hidden-CTA fixture:

```bash
# terminal 1
pnpm fixture:hidden-cta

# terminal 2
pnpm persona-runtime run examples/hidden-cta/study.yaml --output=.qa/hidden-cta
```

The command writes sealed session evidence, canonical JSON, and a static HTML
report under `.qa/hidden-cta`. The legacy npm package commands remain supported
unchanged.
