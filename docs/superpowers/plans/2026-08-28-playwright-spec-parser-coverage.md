# Playwright Spec Parser Coverage Improvement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace silent, regex-based partial parsing with an explicit, measurable Playwright-spec extraction contract that supports the high-value locator and assertion APIs and reports every unsupported construct.

**Architecture:** Parse TypeScript/JavaScript syntax into a small project-owned intermediate representation (IR), then lower only supported Playwright semantics into the existing QA spec. Keep the product intentionally narrower than “all Playwright APIs,” but make coverage machine-readable, versioned, tested against the installed Playwright type surface, and fail-safe when source cannot be represented.

**Tech Stack:** Node.js 20+, ESM, TypeScript compiler API or `@typescript-eslint/typescript-estree`, Playwright 1.40+ peer API, Vitest 3.

**Spec:** Current behavior in `scripts/dashboard-spec-parser.mjs` and assertions in `scripts/__tests__/dashboard-spec-parser.test.ts`.

## Global Constraints

- Preserve Node.js `>=20` and the package's ESM interface.
- Preserve the existing parsed artifact fields during migration. Add fields compatibly before changing consumers.
- Never silently convert an unsupported Playwright construct into an empty expectation list.
- Do not promise all Playwright APIs. Publish a supported semantic subset and explicit unsupported diagnostics.
- Treat dynamic JavaScript, custom fixtures, helper calls, aliases, and page-object methods as unresolved unless static analysis can prove their meaning.
- Keep live-staging safety policy classification separate from syntax extraction.

---

## Verified Baseline

- Test declarations are recognized with custom regular expressions in `extractTestBlocks()`.
- Only `page.getByTestId(<string>)` and `page.getByText(<string>)` become locators.
- Only `toBeVisible()`, `not.toBeVisible()`, and string-literal `toContainText()` become expectations.
- Installed Playwright 1.60 exposes 27 `LocatorAssertions` methods. The parser directly models 2 positive methods plus one negated form, so direct matcher-name coverage is 2/27, about 7.4%. This is not semantic coverage because argument variants are also partial.
- Actions such as `click()`, `fill()`, `setInputFiles()`, navigation, dialogs, downloads, frames, network, keyboard, mouse, and assertions outside the three patterns are not extracted as structured steps.
- `getByRole`, `getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`, `locator`, chained locators, filters, nth/first/last, aliases, page objects, regex expectations, soft assertions, polling, snapshots, page assertions, response assertions, and generic value assertions are not represented.
- `countUnparsedTests()` detects some unparsed test declarations, but there is no equivalent unsupported-expectation count. A parsed test can therefore lose every assertion without warning.
- Reproduction against the current parser returned `[]` for `getByRole(...).toBeVisible()`, `toHaveText()`, `toBeHidden()`, `toHaveCount()`, regex `toContainText()`, `page.locator()`, and aliased locators.
- Existing parser suite passes: 33/33 tests.
- Public CLI acceptance path was exercised with `node bin/playwright-spec-for-ai-agent.mjs spec`. The bundled demo produced both raw and abstracted JSON, reporting 4 parsed tests, 3 live-included tests, and 2 parsed Playwright expectations.
- The same public CLI run against a spec containing `getByRole(...).toBeVisible()` and `getByTestId(...).toHaveText()` exited successfully and labeled the test `executable-readonly`, but emitted `expectations: []` with no warning. This confirms the silent-loss risk reaches the end-user artifact and is not limited to the parser helper API.

## Target Support Contract

### Tier 1: statically executable DOM intent

Locators:

- `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`, `getByTestId`, and CSS `locator`.
- Chaining through `locator`, `getBy*`, `filter`, `first`, `last`, and `nth` where every argument is a literal or regular expression.
- Direct aliases declared with `const` inside the same test body.

Assertions:

- Visibility/state: `toBeVisible`, `toBeHidden`, `toBeAttached`, `toBeEnabled`, `toBeDisabled`, `toBeEditable`, `toBeChecked`, `toBeEmpty`, `toBeFocused`, `toBeInViewport`.
- Content/value: `toHaveText`, `toContainText`, `toHaveValue`, `toHaveValues`, `toHaveCount`.
- Identity/accessibility: `toHaveAttribute`, `toHaveClass`, `toContainClass`, `toHaveId`, `toHaveRole`, `toHaveAccessibleName`, `toHaveAccessibleDescription`, `toHaveAccessibleErrorMessage`.
- Preserve `.not`, string/regex expected values, arrays where supported, and statically evaluable options.

### Tier 2: structured interaction intent

- `click`, `dblclick`, `check`, `uncheck`, `fill`, `press`, `selectOption`, `setInputFiles`, `hover`, `focus`, `blur`, `dragTo`.
- `page.goto`, `goBack`, `goForward`, `reload` when targets/options are static.
- Emit actions into an ordered `steps` IR instead of inferring interaction from body-wide regexes.

### Explicitly diagnostic, not statically executed

- Network interception, WebSocket, worker, browser/context lifecycle, tracing, HAR, video, downloads, popups, multi-page flows, arbitrary `evaluate`, custom matcher implementations, loops/branches dependent on runtime values, page objects/helpers that are not inlined, and non-literal dynamic selectors.
- These constructs must produce `unsupportedConstructs` with source location, API name, reason, and severity.

---

### Task 1: Freeze the supported API manifest and coverage metric

**Files:**
- Create: `scripts/playwright-api-manifest.mjs`
- Create: `scripts/__tests__/playwright-api-manifest.test.ts`
- Modify: `docs/annotations.md`

**Interfaces:**
- Produces: `SUPPORTED_LOCATOR_METHODS`, `SUPPORTED_ASSERTION_METHODS`, `SUPPORTED_ACTION_METHODS`, and `computeApiCoverage(playwrightMethods)`.
- Consumes: Installed `node_modules/playwright/types/test.d.ts` only in tests, not at package runtime.

- [ ] **Step 1: Write a failing manifest test**

Assert that every Tier 1/Tier 2 name above is present once, and extract `LocatorAssertions` methods from the installed Playwright type definition to generate `{ supported, total, missing }`.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `rtk npm test -- --run scripts/__tests__/playwright-api-manifest.test.ts`

Expected: FAIL because the manifest module does not exist.

- [ ] **Step 3: Implement the immutable manifest and metric**

Export frozen arrays/sets and a pure coverage function. Do not couple parser behavior to Playwright internals.

- [ ] **Step 4: Document the support contract**

Add a table to `docs/annotations.md` with Supported, Diagnostic-only, and Dynamic/unresolved categories. State that full Playwright API coverage is not a goal.

- [ ] **Step 5: Run tests and commit**

Run: `rtk npm test -- --run scripts/__tests__/playwright-api-manifest.test.ts`

Commit: `git commit -m "docs: define playwright parser support contract"`

---

### Task 2: Introduce a source-located parser IR

**Files:**
- Create: `scripts/spec-parser-ir.mjs`
- Create: `scripts/__tests__/spec-parser-ir.test.ts`
- Modify: `scripts/artifact-schema.mjs`

**Interfaces:**
- Produces: `ParsedTestIR` with `title`, `location`, `steps`, `expectations`, and `unsupportedConstructs`.
- Diagnostic shape: `{ api, category, reason, severity, location: { file, line, column } }`.

- [ ] **Step 1: Write schema tests for source locations and diagnostics**

Cover one supported assertion and one unsupported dynamic selector in the same test. Assert neither disappears.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `rtk npm test -- --run scripts/__tests__/spec-parser-ir.test.ts`

- [ ] **Step 3: Implement IR constructors and artifact validation**

Use explicit discriminated objects such as `{ type: "assertion", matcher: "toHaveText", locator, expected, negated }` and `{ type: "action", method: "click", locator, options }`.

- [ ] **Step 4: Run artifact and IR tests**

Run: `rtk npm test -- --run scripts/__tests__/spec-parser-ir.test.ts scripts/__tests__/qa-foundations.test.ts`

- [ ] **Step 5: Commit**

Commit: `git commit -m "feat: add source-located spec parser IR"`

---

### Task 3: Replace test-block regex parsing with a TypeScript AST

**Files:**
- Create: `scripts/typescript-spec-parser.mjs`
- Create: `scripts/__tests__/typescript-spec-parser.test.ts`
- Modify: `package.json`
- Modify: `scripts/dashboard-spec-parser.mjs`

**Interfaces:**
- Produces: `parseTestDeclarations(fileName, source): { tests, diagnostics }`.
- Each test contains its callback AST/body range and supports `test`, `test.only`, `test.skip`, `test.fixme`, test details objects, async/function callbacks, and nested `test.describe`.

- [ ] **Step 1: Add failing declaration fixtures**

Include current supported signatures plus test details `{ tag, annotation }`, named functions, nested describe blocks, braces in template interpolations, comments, regexes, and malformed source.

- [ ] **Step 2: Run and confirm current regex limitations**

Run: `rtk npm test -- --run scripts/__tests__/typescript-spec-parser.test.ts`

- [ ] **Step 3: Add one parser dependency**

Prefer the TypeScript compiler API if TypeScript is already transitively available and can be declared directly. Otherwise add `@typescript-eslint/typescript-estree`. Record the choice in the package lock.

- [ ] **Step 4: Implement AST declaration extraction**

Identify Playwright test calls structurally. Preserve source locations and report malformed/unsupported declarations as errors, not warnings that allow silent omission.

- [ ] **Step 5: Adapt `parseDashboardSpecFile()` behind a compatibility boundary**

Keep the returned scenario/test fields stable while sourcing test bodies and locations from the AST parser.

- [ ] **Step 6: Run parser and full tests**

Run: `rtk npm test -- --run scripts/__tests__/typescript-spec-parser.test.ts scripts/__tests__/dashboard-spec-parser.test.ts`

Run: `rtk npm test`

- [ ] **Step 7: Commit**

Commit: `git commit -m "refactor: parse playwright tests with typescript AST"`

---

### Task 4: Parse locator expressions and local aliases

**Files:**
- Create: `scripts/playwright-locator-parser.mjs`
- Create: `scripts/__tests__/playwright-locator-parser.test.ts`
- Modify: `scripts/dashboard-spec-parser.mjs`

**Interfaces:**
- Produces: `parseLocator(node, bindings): LocatorIR | UnsupportedDiagnostic`.
- `LocatorIR` is an ordered chain whose root is `page` or a resolved local locator alias.

- [ ] **Step 1: Add table-driven failing tests for Tier 1 locators**

Cover every `getBy*`, CSS `locator`, regex/string arguments, literal options, chained `filter`, `first`, `last`, `nth`, and a same-body `const save = page.getByRole(...)` alias.

- [ ] **Step 2: Add rejection tests**

Cover computed selector variables, mutable aliases, helper-returned locators, page-object members, spread options, and function calls in selector arguments. Assert a diagnostic with source location.

- [ ] **Step 3: Implement literal/regex/options decoding and locator chains**

Do not evaluate JavaScript. Accept only syntax proven static.

- [ ] **Step 4: Run focused tests**

Run: `rtk npm test -- --run scripts/__tests__/playwright-locator-parser.test.ts`

- [ ] **Step 5: Commit**

Commit: `git commit -m "feat: parse playwright locator chains"`

---

### Task 5: Parse Tier 1 locator assertions without silent loss

**Files:**
- Create: `scripts/playwright-assertion-parser.mjs`
- Create: `scripts/__tests__/playwright-assertion-parser.test.ts`
- Modify: `scripts/dashboard-spec-parser.mjs`
- Modify: `scripts/expectation-abstractor.mjs`

**Interfaces:**
- Produces: `parseAssertion(expectCall, bindings): AssertionIR | UnsupportedDiagnostic`.
- Preserves matcher, `.not`, expected values, supported options, and source location.

- [ ] **Step 1: Add generated matrix tests from the assertion manifest**

Each supported matcher must have at least one positive case. Add explicit string, regex, array, numeric, boolean-state, and negated cases.

- [ ] **Step 2: Add unsupported assertion tests**

Cover `expect.soft`, custom matchers, `expect.poll`, `toPass`, page/response assertions, dynamic expected values, and unsupported options. Assert diagnostics, not empty output.

- [ ] **Step 3: Implement assertion parsing**

Map compatible existing output to `visible`, `notVisible`, and `containText` during migration. Add new IR types without forcing all downstream evaluators to support them immediately.

- [ ] **Step 4: Update live abstraction**

Define which expected values may be generalized for live data. Never generalize accessibility, state, or identity assertions into weaker visibility checks.

- [ ] **Step 5: Run focused and regression tests**

Run: `rtk npm test -- --run scripts/__tests__/playwright-assertion-parser.test.ts scripts/__tests__/dashboard-spec-parser.test.ts scripts/__tests__/expectation-abstractor.test.ts`

- [ ] **Step 6: Commit**

Commit: `git commit -m "feat: parse supported playwright locator assertions"`

---

### Task 6: Parse safe interaction steps and replace body regex classification

**Files:**
- Create: `scripts/playwright-action-parser.mjs`
- Create: `scripts/__tests__/playwright-action-parser.test.ts`
- Modify: `scripts/dashboard-spec-parser.mjs`
- Modify: `scripts/qa-spec-judge-document.mjs`

**Interfaces:**
- Produces ordered ActionIR entries for the Tier 2 methods.
- Policy classifier consumes structured actions plus diagnostics, not raw body regexes.

- [ ] **Step 1: Add action ordering and option tests**

Cover `fill -> click -> assertion`, file fixtures, navigation, keyboard input, check/uncheck, and drag operations.

- [ ] **Step 2: Add safety boundary tests**

Assert that confirm clicks, checkout/subscription targets, network mocks, arbitrary evaluate calls, popups, and downloads become blocked or manual-review diagnostics.

- [ ] **Step 3: Implement action extraction**

Preserve action order. Resolve static locator aliases. Link `setInputFiles` arguments to `@qa-fixture` declarations and reject undeclared live upload paths.

- [ ] **Step 4: Replace broad regex classification incrementally**

Use structured actions first. Keep existing regex detection temporarily as a downgrade-only fallback and emit a deprecation diagnostic when it is used.

- [ ] **Step 5: Run tests**

Run: `rtk npm test -- --run scripts/__tests__/playwright-action-parser.test.ts scripts/__tests__/qa-spec-judge-document.test.ts scripts/__tests__/dashboard-spec-parser.test.ts`

- [ ] **Step 6: Commit**

Commit: `git commit -m "feat: extract safe playwright interaction steps"`

---

### Task 7: Add parser integrity gates and user-visible coverage

**Files:**
- Modify: `scripts/dashboard-spec-parser.mjs`
- Modify: `scripts/extract-page-e2e-spec.mjs`
- Modify: `scripts/run-qa-doctor.mjs`
- Modify: `scripts/qa-spec-judge-document.mjs`
- Modify: `scripts/__tests__/run-qa-doctor.test.ts`
- Create: `scripts/__tests__/parser-integrity.test.ts`

**Interfaces:**
- Scenario output adds `parserCoverage: { testsFound, testsParsed, assertionsFound, assertionsParsed, actionsFound, actionsParsed, unsupportedCount }`.
- CLI supports strict failure when unsupported constructs would weaken a verdict.

- [ ] **Step 1: Write failing integrity tests**

Assert that a test containing one supported and one unsupported assertion reports 2 found, 1 parsed, 1 unsupported. Assert zero parsed assertions cannot be presented as full coverage.

- [ ] **Step 2: Implement AST-node accounting**

Count candidate Playwright calls independently from successful lowering. Ensure every candidate ends as parsed or diagnostic.

- [ ] **Step 3: Add `doctor` and `spec` reporting**

Print coverage percentages and top unsupported APIs by file/line. Make unsupported assertion loss a non-zero strict-mode exit.

- [ ] **Step 4: Protect verdict integrity**

If unsupported constructs affect a check, downgrade the result ceiling to `manual_review`. Never allow a partial parse to produce an unqualified pass.

- [ ] **Step 5: Run focused and full tests**

Run: `rtk npm test -- --run scripts/__tests__/parser-integrity.test.ts scripts/__tests__/run-qa-doctor.test.ts`

Run: `rtk npm test`

- [ ] **Step 6: Commit**

Commit: `git commit -m "feat: enforce playwright parser integrity coverage"`

---

### Task 8: Add a versioned Playwright API drift check

**Files:**
- Create: `scripts/check-playwright-api-drift.mjs`
- Create: `scripts/__tests__/playwright-api-drift.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml` if present, otherwise the repository's active CI workflow

**Interfaces:**
- Produces a deterministic report when installed Playwright adds/removes assertion methods relative to the checked-in manifest.

- [ ] **Step 1: Write a fixture-based drift test**

Use a small synthetic type-definition fixture with one added matcher and assert the report names it.

- [ ] **Step 2: Implement the drift checker**

Parse method names from the installed Playwright `LocatorAssertions` interface. Do not fail because an API is unsupported. Fail only when the checked-in review snapshot is stale, forcing an explicit classify-as-supported-or-diagnostic decision.

- [ ] **Step 3: Add package and CI commands**

Add `test:api-drift` and run it in CI after dependency installation.

- [ ] **Step 4: Run all verification**

Run: `rtk npm test`

Run: `rtk npm run test:api-drift`

Run: `rtk npm pack --dry-run`

- [ ] **Step 5: Commit**

Commit: `git commit -m "test: detect playwright API parser drift"`

---

## Acceptance Criteria

- Every statically recognizable Playwright test declaration is parsed or has a source-located diagnostic.
- Every candidate `expect` and supported action call is parsed or has a source-located diagnostic.
- Tier 1 locator/assertion and Tier 2 action manifests have generated contract tests.
- Partial parsing cannot yield an unqualified `pass`.
- CLI output reports declaration, assertion, and action coverage separately.
- Playwright version upgrades trigger an explicit API drift review.
- Existing artifact consumers continue working during migration.
- Full Vitest suite and package dry-run pass.

## Recommended Delivery Order

1. Tasks 1, 2, 7 first to stop silent loss and protect verdict integrity.
2. Task 3 to remove declaration-regex fragility.
3. Tasks 4 and 5 for high-value read-only semantic coverage.
4. Task 6 for interactions.
5. Task 8 to prevent future drift.

This order prioritizes trustworthy verdicts over maximizing the raw number of recognized APIs.

## TDD Execution Contract (`/test` aligned)

Every implementation slice follows this sequence. Production parser code must not change before a valid RED is observed.

1. **Contract row:** Write one observable input/output row with Then, Never, and exact counts.
2. **RED test:** Add the narrowest test at the owning module. Test names use `describe('<target> as <situation>')` and `it('to be <observable result>')`.
3. **Run RED:** Execute the focused Vitest command. Accept RED only when the fixture parsed normally and the failure is the intended missing behavior, not import, syntax, or harness failure.
4. **Minimal GREEN:** Implement only enough production behavior to satisfy that row.
5. **Run GREEN:** Execute the focused test, adjacent parser tests, then the public `spec` CLI acceptance path.
6. **Never assertion:** For every supported construct, assert exact parsed counts and `unsupportedConstructs.length === 0`. For unsupported constructs, assert no expectation disappears and the exact diagnostic count is `1`.
7. **Regression boundary:** Run the full suite before commit. Do not weaken an assertion, add `skip`, or convert exact equality to truthiness to obtain GREEN.
8. **Commit:** One independently reviewable behavior slice per commit.

### Contract Matrix

| ID | Input boundary | Then | Never | Acceptance observation |
|---|---|---|---|---|
| O1 | Existing `getByTestId(...).toBeVisible()` | One locator assertion is emitted | No diagnostic | CLI JSON contains exactly one expectation |
| O2 | `getByRole(...).toBeVisible()` | One role locator assertion is emitted | `expectations: []` is forbidden | CLI summary reports 1/1 assertion parsed |
| O3 | `toHaveText("x")` and `toContainText(/x/i)` | Expected value shape and matcher are preserved | Regex is not converted to a string | Raw artifact contains exact string/regex IR |
| O4 | Unsupported dynamic selector | One source-located diagnostic is emitted | Silent omission and executable pass are forbidden | CLI exits non-zero in strict mode or caps verdict at `manual_review` |
| O5 | Test details object `{ tag: "@slow" }` | Declaration and body are parsed | Test count cannot decrease | CLI reports 1 found and 1 parsed |
| O6 | `fill -> click -> assertion` | Three ordered steps are emitted | Reordering and body-regex-only classification are forbidden | Raw artifact preserves the source order |
| O7 | Mixed supported and unsupported assertions | Found=2, parsed=1, unsupported=1 | Coverage cannot be reported as 100% | `doctor` names the unsupported API and file:line |
| O8 | Playwright type surface adds a matcher | Drift report names the method | Upgrade cannot silently change the reviewed manifest | CI drift command fails with the added method |

### First Implementation Iteration

Start with verdict integrity before broad API support:

- [ ] Add O7 failing test to `scripts/__tests__/parser-integrity.test.ts`.
- [ ] Run it and retain the valid RED showing the missing `parserCoverage` contract.
- [ ] Add candidate assertion accounting and source-located unsupported diagnostics.
- [ ] Run O7 GREEN plus `dashboard-spec-parser.test.ts`.
- [ ] Add the public CLI O4 acceptance test through `bin/playwright-spec-for-ai-agent.mjs spec`.
- [ ] Implement strict-mode failure and `manual_review` verdict ceiling.
- [ ] Run the focused tests, all 33 existing parser tests, full Vitest, and `npm pack --dry-run`.
- [ ] Commit as `feat: prevent silent playwright assertion loss`.

Only after this iteration is GREEN should AST migration and broader locator/assertion support begin.
