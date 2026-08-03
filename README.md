<div align="center">

# Playwright Spec for AI Agent Monorepo

**AI-native QA and persona-driven browser exploration built on Playwright.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-10.33.0-F69220?style=for-the-badge&logo=pnpm&logoColor=white)](https://pnpm.io)
[![Playwright](https://img.shields.io/badge/Playwright-1.60-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

</div>

Playwright asserts deterministic outcomes; live products are not deterministic. This project delegates the reasoning Playwright cannot do — account-dependent text, animation timing, mock-authored expectations against live data — to an AI agent that performs first-pass QA judgment over sealed browser evidence.

This repository contains two public applications and the private workspace packages that support them. This README is the workspace map; open each linked directory for commands, architecture, examples, safety boundaries, and output formats.

## Applications

| Application                      | Package                        | What it does                                                                                                                | Documentation                                                                        |
| -------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Personaut**                    | `@lodado/personaut`            | Explores a web product as seeded personas, seals browser evidence, evaluates deterministic outcomes, and compares variants. | [`apps/personaut`](./apps/personaut/README.md)                                       |
| **Playwright Spec for AI Agent** | `playwright-spec-for-ai-agent` | Turns Playwright QA intent into AI-assisted staging execution, judgment, review, remediation, and reporting workflows.      | [`apps/playwright-spec-for-ai-agent`](./apps/playwright-spec-for-ai-agent/README.md) |

### Choose an application

```text
Need persona-based UX exploration and evidence?  → Personaut
Need existing Playwright specs to drive AI QA?   → Playwright Spec for AI Agent
```

## Workspace packages

Personaut keeps its contracts, runtime, browser driver, evaluator, reporter, and
Playwright StudySpec compiler in `apps/personaut/src`. The remaining workspace
packages are shared implementation modules.

| Workspace                          | Responsibility                                                              | Documentation                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `@persona-runtime/persona-policy`  | Seeded persona presets, attention filtering, and abandonment behavior.      | [`packages/persona-policy`](./packages/persona-policy/README.md)                   |
| `@persona-runtime/reporter-github` | GitHub Check and pull-request comment formatting primitives.                | [`packages/reporter-github`](./packages/reporter-github/README.md)                 |
| `@persona-runtime/hermes-transport`| Shared Hermes process transport.                                             | [`packages/hermes-transport`](./packages/hermes-transport/README.md)               |
| `playwright-spec-extract`          | Shared Playwright source-to-IR extraction.                                   | [`packages/playwright-spec-extract`](./packages/playwright-spec-extract)           |

## Examples

| Example                | Purpose                                                                                 | Documentation                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Hidden CTA             | Runs Personaut against a page whose successful action begins below the mobile viewport. | [`examples/hidden-cta`](./examples/hidden-cta/README.md)                                               |
| Compatibility examples | Demonstrates the Playwright Spec for AI Agent command and annotation formats.           | [`apps/playwright-spec-for-ai-agent/examples`](./apps/playwright-spec-for-ai-agent/examples/README.md) |

## Quick start

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Run Personaut from the workspace:

```bash
pnpm personaut --help
```

Install the published CLI:

```bash
pnpm add -D @lodado/personaut
pnpm exec personaut --help
```

## Workspace validation

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm package:smoke
```

## Publishing

Changesets versions and publishes the two public applications. Private workspace packages are never published; Personaut bundles its internal runtime modules before packing.

See the application READMEs for release-specific usage and limitations.
