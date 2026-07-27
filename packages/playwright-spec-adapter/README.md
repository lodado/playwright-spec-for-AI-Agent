<div align="center">

# playwright-spec-adapter

**Turn existing Playwright QA intent into Personaut StudySpecs.**

![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/Playwright-specs-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)
![Workspace](https://img.shields.io/badge/workspace-private-0f766e?style=for-the-badge)

<br />

![Playwright](https://img.shields.io/badge/%23Playwright-2EAD33?style=flat-square)
![StudySpec](https://img.shields.io/badge/%23StudySpec-6366f1?style=flat-square)
![QA Intent](https://img.shields.io/badge/%23QAIntent-b45309?style=flat-square)

<br />

[Quick start](#quick-start) · [Annotations](#playwright-annotations) · [API](#api) · [Policy mapping](#outputs) · [Safety](#safety) · [Legacy package](../../apps/playwright-spec-for-ai-agent/README.md)

</div>

---

> [!NOTE]
> This adapter preserves the legacy annotation parser and live-policy semantics. It converts Playwright intent into `qa-ir/0.1` and `study-spec/0.1`; it does not launch browsers or weaken unsafe policies.

```text
*.spec.ts annotations → PlaywrightScenarioIR → StudySpec
```

### Input → output example

```js
import { compilePlaywrightIRToStudyResult } from "playwright-spec-adapter";

const ir = {
  schemaVersion: "qa-ir/0.1",
  sourceDirectory: "tests",
  scenarios: [
    {
      scenarioId: "PRICING",
      sourceFile: "pricing.spec.ts",
      page: "/pricing",
      tests: [
        {
          checkId: "price",
          title: "shows price",
          liveRunPolicy: "executable-readonly",
          expectations: [
            { type: "containText", expected: { kind: "literal", value: "$10" } },
          ],
        },
      ],
    },
  ],
};

const { studySpec, warnings } = compilePlaywrightIRToStudyResult(ir, {
  baseUrl: "https://staging.example.com",
});

console.log(studySpec.schemaVersion);
console.log(warnings.length);
```

```text
study-spec/0.1
0
```

---

## Table of Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [API](#api)
- [Playwright annotations](#playwright-annotations)
- [Quick start](#quick-start)
- [Outputs](#outputs)
- [Safety](#safety)
- [Test](#test)
- [Limits](#limits)

## Why this exists

Teams already encode useful QA intent in Playwright specs. The adapter lets Personaut reuse that intent without running brittle mocked selectors directly against staging.

## What it does

The package:

1. Reads Playwright spec files with legacy QA annotations.
2. Produces `qa-ir/0.1` scenario objects.
3. Adapts literal expectations into live-safe intent.
4. Maps live policies into StudySpec safety constraints.
5. Emits warnings for blocked or unsafe flows.
6. Compiles the result into a versioned StudySpec.

## API

| Export | Purpose |
| --- | --- |
| `parsePlaywrightSpecs({ specDir, page })` | Reads a spec directory and returns `qa-ir/0.1`. |
| `compilePlaywrightIRToStudy(ir, options)` | Returns only the compiled StudySpec. |
| `compilePlaywrightIRToStudyResult(ir, options)` | Returns `{ studySpec, warnings }`. |
| `parseDashboardSpecFile(fileName, source)` | Legacy single-file parser. |
| `literalExpectedForLive`, `adaptExpectationForLive` | Existing expectation abstraction helpers. |
| `filterSpecForLiveJson`, `collectLiveSkippedEntries` | Existing live-run filtering helpers. |

Subpath exports:

```js
import { parseSpecDirectory } from "playwright-spec-adapter/legacy";
import { literalExpectedForLive } from "playwright-spec-adapter/expectation";
import { filterSpecForLiveJson } from "playwright-spec-adapter/policy";
```

## Playwright annotations

These are Playwright source comments, not TypeScript decorators. They are the
shared input contract for both the legacy live-QA CLI and Personaut's
`import-playwright` command.

| Annotation | Scope | Personaut meaning |
| --- | --- | --- |
| `// @qa-page: pricing` | File | Optional page/task target metadata. |
| `// @qa-scenario: ACTIVE` | File | Required scenario identity and task intent. |
| `// @qa-live-skip: true` | File | Imports the scenario conservatively instead of scheduling live actions. |
| `// @qa-always-run: true` | File | Keeps the scenario eligible when legacy filtering would skip it. |
| `// @qa-live-policy: ...` | Test or enclosing `test.describe` | Compiles the test's browser-action safety policy. |
| `// @qa-fixture: avatar=tests/fixtures/avatar.png` | Test, describe, or file | Preserves a named fixture reference; the adapter does not upload it. |

Place file annotations before imports and action annotations immediately above
the test they control:

```ts
// @qa-page: pricing
// @qa-scenario: PRICING_VISIBLE

import { expect, test } from "@playwright/test";

// @qa-live-policy: readonly
test("shows the current price", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
});
```

Supported live policies:

| Policy | StudySpec mapping |
| --- | --- |
| `readonly` | Navigation/read checks only; click, typing, upload, and mutation stay disabled. |
| `safe-interaction` | Bounded click, typing, upload, and state mutation may be enabled. |
| `safe-interaction-no-confirm` | Interaction is allowed, but destructive confirmation remains blocked. |
| `mock-judgment` | Mock-backed expectations become conservative live intent. |
| `subscription-mutation` | Blocked from execution and marked for human review. |
| `auth-mock` | Blocked from direct live execution and marked for review. |
| `skip` | Blocked from live execution. |

`import-playwright` preserves these policies; it never upgrades a blocked policy
into an executable action. Parser syntax coverage and unsupported constructs are
listed in [PLAYWRIGHT_SYNTAX_SUPPORT.md](../../apps/playwright-spec-for-ai-agent/PLAYWRIGHT_SYNTAX_SUPPORT.md).

## Quick start

```js
import { parsePlaywrightSpecs, compilePlaywrightIRToStudy } from "playwright-spec-adapter";

const ir = await parsePlaywrightSpecs({ specDir: "tests/e2e", page: "pricing" });
const study = compilePlaywrightIRToStudy(ir, { baseUrl: "https://staging.example.com" });

console.log(study.schemaVersion);
```

## Outputs

| Input | Output |
| --- | --- |
| `// @qa-page` | Study task target metadata. |
| `// @qa-scenario` | Scenario/task identity and intent. |
| `// @qa-live-policy: readonly` | Read/navigation-only safety policy. |
| `// @qa-live-policy: safe-interaction-no-confirm` | Interaction allowed before destructive confirmation. |
| `subscription-mutation`, `auth-mock`, `skip` | Review warnings plus conservative safety metadata. |
| Playwright `expect(...)` literals | Live-safe or deterministic oracle hints when mappable. |

## Safety

- Blocked policies are not downgraded into executable browser actions.
- The adapter does not open a browser, call a model, publish reports, or mutate GitHub.
- Generated StudySpecs should be reviewed before use against live or staging systems.

## Test

```bash
pnpm --filter playwright-spec-adapter test
pnpm --filter playwright-spec-adapter typecheck
pnpm --filter playwright-spec-adapter build
```

## Limits

- The canonical parser is still `legacy-regex`; TypeScript AST parsing is not implemented here.
- Imported oracles are deterministic only when expectations can be mapped from source.
- Fixture semantics are preserved as intent; the adapter does not upload files or execute tests.
