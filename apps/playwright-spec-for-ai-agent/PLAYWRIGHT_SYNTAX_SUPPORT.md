# Playwright Syntax Support Matrix

This matrix documents what the current parser accepts. It is based on `scripts/dashboard-spec-parser.mjs`; the CLI reads specs as source text and does not run Playwright.

## CI and release compatibility

| Workflow | Trigger | Node | Commands | Notes |
| --- | --- | --- | --- | --- |
| PR regression CI | `pull_request`, `push` to `main` | 20 | `npm ci`, `npm test` | Keeps parser compatibility checks green before merge and after main updates. |
| Release | `push` to `main` | 20 | release-please, `npm ci`, `npm test`, `npm publish` | Existing publish path; requires `NPM_TOKEN` for npm publish. |

## Spec shape

| Syntax | Status | Notes |
| --- | --- | --- |
| `test("title", async ({ page }) => { ... })` | Supported | Single parser target for executable test blocks. Single, double, and template-quoted titles are accepted. |
| `test.describe("group", () => { ... })` | Partially supported | Used only to inherit `@qa-live-policy` and `@qa-fixture` comments into child `test(...)` blocks. |
| `test.skip`, `test.only`, `test.fixme`, `test.describe.configure` | Unsupported | They are not extracted as test blocks. Use `@qa-live-skip: true` or `@qa-live-policy: skip` for live QA skipping. |
| Non-async tests, `async page =>`, `function` callbacks, tests without destructured fixtures | Unsupported | The extractor expects `async ({ ... }) => { ... }`. |
| TypeScript syntax inside a supported test body | Best effort | Bodies are scanned as text; only the patterns below affect QA output. |

## QA annotations

| Annotation | Location | Status | Effect |
| --- | --- | --- | --- |
| `// @qa-page: billing` | File | Supported | Overrides the page id. |
| `// @qa-scenario: ACTIVE` | File | Supported, required | Creates the scenario id. |
| `// @qa-scenario-label: "Active account"` | File | Unsupported | Ignored by `parseDashboardSpecFile`; labels come from the first `test.describe(...)` title, or fall back to the file name. |
| `// @qa-live-skip: true` | File | Supported | Blocks all tests in the file from live QA. |
| `// @qa-always-run: true` | File | Supported | Keeps the scenario eligible during live filtering. |
| `// @qa-live-policy: readonly` | `test` or enclosing `test.describe` | Supported | Required unless the file has `@qa-live-skip: true`. |
| `// @qa-fixture: avatar=tests/fixtures/avatar.png` | File, `test.describe`, or `test` | Supported | Merged into parsed fixture metadata; later/narrower comments override earlier values. |

## `@qa-live-policy` values

| Value | Live run policy | Status |
| --- | --- | --- |
| `readonly` | `executable-readonly` | Supported |
| `safe-interaction` | `executable-interaction` | Supported |
| `safe-interaction-no-confirm` | `judgment-interaction-no-confirm` | Supported |
| `mock-judgment` | `judgment-mock-api` | Supported |
| `subscription-mutation` | `blocked-subscription-mutation` | Supported |
| `auth-mock` | `blocked-auth-mock` | Supported |
| `skip` | `blocked-live-skip` | Supported |

## Parsed read-only expectations

| Playwright assertion | Locator support | Status |
| --- | --- | --- |
| `await expect(page.getByTestId("id")).toBeVisible()` | `getByTestId` | Supported |
| `await expect(page.getByText("copy")).toBeVisible()` | `getByText` | Supported |
| `await expect(page.getByTestId("id")).not.toBeVisible()` | `getByTestId` | Supported |
| `await expect(page.getByText("copy")).not.toBeVisible()` | `getByText` | Supported |
| `await expect(page.getByTestId("id")).toContainText("copy")` | `getByTestId` | Supported |
| `await expect(page.getByText("copy")).toContainText("copy")` | `getByText` | Supported |
| `toHaveText`, `toHaveURL`, `toHaveCount`, `toBeEnabled`, `toBeDisabled` | Any | Unsupported for extracted read-only expectations. |
| `page.getByRole(...)`, `page.locator(...)`, chained locators | Any | Unsupported for extracted read-only expectations. |

## Classification hints

`parseDashboardSpecFile` does not infer policy from test bodies. The helpers below are exported for standalone use only; parsed output follows the declared `@qa-live-policy` (or file-level `@qa-live-skip`).

| Pattern | Status | Result |
| --- | --- | --- |
| `page.getByTestId("id").click()` | Executable | With `safe-interaction`, compiles to `INTERACT/CLICK` and produces `ACTION_LOG` evidence. Links, forms, editable targets, and any post-click network request are blocked. |
| `page.getByText("text").click()` | Executable | Static single- or double-quoted text only. |
| `page.getByRole("role", { name: "name" }).click()` | Executable | Requires a static accessible name. |
| CSS/XPath, aliased or chained locators, click options, and non-click actions | Unsupported | The whole `safe-interaction` test fails compilation; supported actions are never executed as a partial subset. |
| Any click under `safe-interaction-no-confirm` | Deferred | The runtime does not guess which click is the destructive confirmation. |
| `page.route(...)` / mocked API fulfillment | Helper only | `detectApiMock` and `classifyLiveRunPolicy` can detect this; annotate `mock-judgment` when that is the intended parsed policy. |
| Login URL assertion such as `toHaveURL(/\/login/)` | Helper only | `classifyStagingTest` can detect this, but `parseDashboardSpecFile` does not call it; use `@qa-live-policy: auth-mock` for parsed output. |
| Subscription/billing mutation keywords and routes | Helper only | `detectSubscriptionMutation` and `classifyLiveRunPolicy` can detect this; annotate `subscription-mutation` to produce `blocked-subscription-mutation`. |
