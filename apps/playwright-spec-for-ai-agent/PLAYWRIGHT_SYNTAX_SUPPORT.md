# Playwright Syntax Support Matrix

The CLI parses TypeScript source with the TypeScript compiler AST. It does not
execute spec modules or run Playwright during `spec` extraction.

## Test and suite declarations

| Syntax | Status | Notes |
| --- | --- | --- |
| `test("title", callback)` | Supported | Arrow and function callbacks, async or synchronous, with any fixture parameter shape. |
| Imported aliases | Supported | For example `import { test as pwTest, expect as assert }`. |
| `base.extend()` test bindings | Supported | Locally declared bindings derived from an imported test binding are followed. |
| `test.only` / `test.describe.only` | Supported with warning | Tests are imported without filtering siblings. |
| `test.skip` / `test.fixme` | Supported | Imported with a blocked live policy. Enclosing skipped/fixme suites apply to their children. |
| `test.fail` / `test.slow` | Supported as metadata | The modifier is preserved on the parsed test. |
| `test.describe`, `.serial`, `.parallel` | Supported | Nested suites are used for annotation and fixture inheritance. |
| `test.describe.configure` | Ignored | Runtime scheduling does not change QA intent extraction. |
| Hooks (`beforeEach`, `afterEach`, etc.) | Not compiled | Put required live steps in the test or keep them in a named helper that receives manual review. |
| Dynamically generated titles/tests | Diagnostic | Static string and no-substitution template titles are supported; unresolved runtime generation fails closed. |

## QA annotations

| Annotation | Location | Effect |
| --- | --- | --- |
| `// @qa-page: billing` | File | Overrides the page id. |
| `// @qa-scenario: ACTIVE` | File | Required scenario identity. The full line value is preserved. |
| `// @qa-scenario-label: "Active account"` | File | Human-readable scenario label. |
| `// @qa-live-skip: true` | File | Blocks the complete file from live QA. |
| `// @qa-always-run: true` | File | Keeps the scenario eligible during filtering. |
| `// @qa-live-policy: ...` | Test or enclosing suite | Required unless the test/file is skipped. Nearest declaration wins. |
| `// @qa-fixture: name=path` | File, suite, or test | Merged from outer to inner scope; the closest value wins. |

Supported live policies remain `readonly`, `safe-interaction`,
`safe-interaction-no-confirm`, `mock-judgment`, `subscription-mutation`,
`auth-mock`, and `skip`.

## Locators

The parser preserves static locator identity and chains for:

- `locator`, `frameLocator`
- `getByAltText`, `getByLabel`, `getByPlaceholder`, `getByRole`
- `getByTestId`, `getByText`, `getByTitle`
- `filter`, `and`, `or`, `first`, `last`, `nth`
- local `const` locator aliases

Literal, numeric, boolean, regular-expression, array, object, and statically
resolvable template arguments are preserved. Dynamic arguments are retained as
source text and produce a diagnostic when they are required for execution.

## Assertions

The following Playwright web-first matchers are parsed, including `.not` and
`expect.soft`:

- state: `toBeAttached`, `toBeChecked`, `toBeDisabled`, `toBeEditable`,
  `toBeEmpty`, `toBeEnabled`, `toBeFocused`, `toBeHidden`, `toBeInViewport`,
  `toBeVisible`
- text/value: `toContainText`, `toHaveText`, `toHaveValue`, `toHaveValues`
- semantics: `toHaveAccessibleDescription`, `toHaveAccessibleErrorMessage`,
  `toHaveAccessibleName`, `toHaveRole`
- properties: `toHaveAttribute`, `toHaveClass`, `toHaveCSS`, `toHaveId`,
  `toHaveJSProperty`
- page/collection: `toHaveCount`, `toHaveTitle`, `toHaveURL`

Unknown matchers and unresolved expected values are errors rather than silently
dropped expectations.

### Hermes adaptive execution

Adaptive execution is deliberately narrower than source parsing. It supports
`toBeVisible`, `.not.toBeVisible`, `toBeDisabled`, `toContainText`, and the role/name/presence
forms represented as `VISIBLE`, `NOT_VISIBLE`, `CONTAINS_TEXT`, `ROLE`, `NAME`,
or `PRESENT` in QA IR. The Playwright gateway evaluates these predicates from
trusted compiled targets and sealed DOM/ARIA evidence; Hermes only proposes a
leased observation action. Other parsed matchers fail closed when adaptive input
is created rather than being silently weakened.

## Actions

The live spec preserves these statically targeted actions:

- navigation: `goto`, `goBack`, `goForward`, `reload`
- pointer/focus: `click`, `dblclick`, `hover`, `tap`, `focus`, `blur`,
  `dragTo`, `dispatchEvent`
- form/input: `fill`, `clear`, `type`, `pressSequentially`, `press`, `check`,
  `uncheck`, `setChecked`, `selectOption`, `setInputFiles`

Execution authority still comes only from `@qa-live-policy`. A `readonly` test
containing an action is rejected. An opaque helper or control-flow step inside
`safe-interaction` is rejected atomically so a supported subset is never run by
itself.

## Diagnostics and limits

The parser fails closed for syntax errors, missing/unknown live policy, unknown
matchers, dynamic expected values, unresolved assertion/action targets, policy
conflicts, and opaque executable interaction steps. Diagnostics include source
path, line, and column.

Static analysis cannot safely infer arbitrary Page Object helpers, imported
function bodies, network-derived parameterized tests, or runtime branches. Such
code is preserved as source/diagnostics instead of being executed during parse.
