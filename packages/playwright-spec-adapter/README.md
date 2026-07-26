# Playwright Spec Adapter

<p align="center">
  <strong>Turn existing Playwright intent into Persona Runtime studies.</strong><br>
  Legacy QA annotations, live policies, fixtures, and expectations become versioned `qa-ir/0.1` and `study-spec/0.1` inputs.
</p>

<p align="center">
  <img alt="Node 20 or newer" src="https://img.shields.io/badge/node-%3E%3D20-111827?style=flat-square">
  <img alt="ESM" src="https://img.shields.io/badge/modules-ESM-111827?style=flat-square">
  <img alt="Package status" src="https://img.shields.io/badge/status-private_workspace-6b7280?style=flat-square">
</p>

## Where it fits

```text
Playwright spec files
  └─ @qa-page / @qa-scenario / @qa-live-policy / @qa-fixture
      └─ PlaywrightScenarioIR (qa-ir/0.1)
          └─ StudySpec (study-spec/0.1)
```

This package preserves the current parser behavior while making it usable as an input adapter for the new Behavioral Runtime.

## Use it when

- You already have Playwright tests with QA annotations.
- You need a compatibility-preserving parser before adopting the Persona Runtime.
- You want blocked live policies to become reviewable StudySpec tasks instead of unsafe browser actions.

## Public surface

| Export | Purpose |
|---|---|
| `parsePlaywrightSpecs({ specDir, page })` | Reads a spec directory and returns `qa-ir/0.1`. |
| `compilePlaywrightIRToStudy(ir, options)` | Returns only the compiled `StudySpec`. |
| `compilePlaywrightIRToStudyResult(ir, options)` | Returns `{ studySpec, warnings }`. |
| `parseDashboardSpecFile(fileName, source)` | Legacy single-file parser. |
| `literalExpectedForLive`, `adaptExpectationForLive` | Existing expectation abstraction helpers. |
| `filterSpecForLiveJson`, `collectLiveSkippedEntries` | Existing live-run filtering helpers. |

Subpath exports are also available inside the workspace:

```js
import { parseSpecDirectory } from "playwright-spec-adapter/legacy";
import { literalExpectedForLive } from "playwright-spec-adapter/expectation";
import { filterSpecForLiveJson } from "playwright-spec-adapter/policy";
```

## Minimal example

```js
import { compilePlaywrightIRToStudyResult } from "playwright-spec-adapter";

const ir = {
  schemaVersion: "qa-ir/0.1",
  sourceDirectory: "tests",
  scenarios: [{
    scenarioId: "PRICING",
    sourceFile: "pricing.spec.ts",
    page: "/pricing",
    tests: [{
      checkId: "price",
      title: "shows price",
      liveRunPolicy: "executable-readonly",
      expectations: [{ type: "containText", expected: { kind: "literal", value: "$10" } }],
    }],
  }],
};

const { studySpec, warnings } = compilePlaywrightIRToStudyResult(ir, {
  baseUrl: "https://staging.example.com",
});

console.log(studySpec.schemaVersion); // study-spec/0.1
console.log(warnings.length); // 0
```

## Policy mapping

| Legacy policy | StudySpec behavior |
|---|---|
| `readonly` | Read/navigation only. |
| `safe-interaction` | Allows click, typing, upload, and state mutation. |
| `safe-interaction-no-confirm` | Keeps confirmation boundaries blocked. |
| `subscription-mutation`, `auth-mock`, `skip` | Emits review warnings and disables unsafe actions. |

Blocked policies are not weakened during import. They become tasks with conservative safety policy and human validation metadata.

## Boundaries

- The canonical parser is still `legacy-regex`; TypeScript AST parsing is not implemented here.
- Imported oracles are deterministic only when expectations can be mapped from the Playwright source.
- The adapter does not launch a browser, call a model, publish reports, or mutate GitHub.
- Generated StudySpecs should be reviewed before use against live or staging systems.

## Workspace commands

```bash
pnpm --filter playwright-spec-adapter test
pnpm --filter playwright-spec-adapter typecheck
pnpm --filter playwright-spec-adapter build
```
