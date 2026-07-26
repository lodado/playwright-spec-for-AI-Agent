# Playwright Spec for AI Agent Workspace

This repository contains the backwards-compatible
[`playwright-spec-for-ai-agent`](packages/playwright-spec-for-ai-agent/README.md)
package and the Persona Runtime packages described in [`docs/`](docs/README.md).

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
```

The legacy npm package and commands remain supported while the behavioral
runtime is developed as independent workspace packages.
