# Annotation reference

The `@qa-*` comment vocabulary the `spec` command reads out of your Playwright
specs, with each annotation's scope, syntax, whether it is required, and its
effect. Written for someone annotating a spec file or debugging why `spec`
ignored one.

QA intent lives in the specs you already have, as `//` comments. `spec` parses
them; nothing else in the pipeline reads your test code, and no command runs
Playwright against staging.

## Parsing rules

Three rules account for most annotations that "did not work".

1. **An annotation must occupy a whole comment line.** Every pattern is anchored
   to the start of the line — leading spaces and tabs are allowed — and to the
   `//` that opens the comment. Prose that quotes an annotation is
   documentation, not an annotation.

   ```ts
   // @qa-live-skip: true                              ← activates
   // `@qa-live-skip: true` means the file is skipped  ← does not activate
   ```

2. **`@qa-live-skip` and `@qa-live-policy` differ on trailing text.**
   `@qa-live-skip` and `@qa-always-run` require the line to end after `true`, so
   `// @qa-live-skip: true // temporarily` does not activate.
   `@qa-live-policy` tolerates a trailing `// note` after the value.
   `@qa-fixture` tolerates neither: a trailing comment becomes part of the path.

3. **`@qa-live-policy` is mandatory on every parsed test.** Without one on the
   test or on an enclosing `test.describe`, `spec` exits 2.

## File-level annotations

Put these at the top of the spec file, before the imports.

| Annotation                | Syntax                    | Required | Effect                                                                    |
| ------------------------- | ------------------------- | -------- | --------------------------------------------------------------------------- |
| `// @qa-scenario: ACTIVE` | one whitespace-delimited token | yes  | Scenario id. A file without it is invisible to `spec`.                    |
| `// @qa-page: billing`    | one whitespace-delimited token | no   | Page id override, for a file that lives outside the page's spec dir.      |
| `// @qa-live-skip: true`  | exactly `true`, nothing after | no    | Exclude this file from live QA; every test in it becomes `skip`.          |
| `// @qa-always-run: true` | exactly `true`, nothing after | no    | Judge this scenario even when another scenario was selected for the run.  |

`@qa-scenario` captures **one token** — `ACTIVE`, `CANCEL_PENDING`,
`billing-inactive`. Anything after the first token is ignored, so a prose
sentence becomes the scenario id `A`. The human-readable label comes from the
file's first `test.describe("…")` title instead, falling back to the file name.

`judge` runs one scenario matching the live account, plus every
`@qa-always-run` scenario.

## Test-level annotations

| Annotation                                            | Scope                        | Required | Effect                                              |
| ----------------------------------------------------- | ---------------------------- | -------- | ----------------------------------------------------- |
| `// @qa-live-policy: readonly`                        | `test` or `test.describe`    | **yes**  | How far the judge may go on the live site.          |
| `// @qa-fixture: avatar=tests/fixtures/qa-avatar.png` | file, `test.describe`, or `test` | no   | Upload file for live file-input replay.             |

### `@qa-live-policy` resolution

A test-level annotation wins over the innermost enclosing `test.describe`, which
wins over an outer one. The parser walks up from the test through blank lines
and other `//` comment lines, and stops at the first line that is neither.

A test with no policy anywhere fails the whole `spec` run with:

```
Missing // @qa-live-policy on test "<title>" (<file>:<line>).
```

### `@qa-fixture` resolution

Paths are repo-relative and may be single- or double-quoted. Fixture names match
`[A-Za-z0-9_-]+`. Resolution is closest-wins **per fixture name**:

```
test comment > enclosing describe (innermost first) > file header
  > pages.{page}.fixtures > staging.fixtures > fixtures
```

`spec` warns `QA fixture missing on disk: <path>` for each missing file, then
fails with `N upload fixture(s) referenced by the QA spec do not exist:` and the
list. `--allow-missing-fixtures` downgrades that to the warnings alone.

The three config-level blocks are documented in
[Configuration](./configuration.md#staging-and-pagespage).

## Live-policy values

`@qa-live-policy` maps to a `liveRunPolicy` verb — what the judge is allowed to
execute — and a staging mode.

| Annotation                    | `liveRunPolicy`                   | Staging mode | Judge behaviour                                                                                  |
| ----------------------------- | --------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `readonly`                    | `executable-readonly`             | read-only    | Inspect the page; no mutating clicks.                                                            |
| `safe-interaction`            | `executable-interaction`          | interaction  | Follow the Playwright steps quoted in the plan; dismiss risky dialogs with Esc. Mandatory to execute — not skippable for caution alone. |
| `safe-interaction-no-confirm` | `judgment-interaction-no-confirm` | interaction  | Open the flow, stop before the confirm or destructive submit, Esc out.                           |
| `mock-judgment`               | `judgment-mock-api`               | read-only    | The CI test relied on `page.route` mocks that cannot be replayed. Judge by intent, not by mock literals. |
| `subscription-mutation`       | `blocked-subscription-mutation`   | interaction  | Blocked on live: reported as `skip`.                                                             |
| `auth-mock`                   | `blocked-auth-mock`               | auth         | Blocked on live: reported as `skip`.                                                             |
| `skip`                        | `blocked-live-skip`               | live-skip    | Blocked on live: reported as `skip`.                                                              |

There is one more verb no annotation produces. When a read-only test's Playwright
assertions cannot be fully parsed, the parser assigns `judgment-parser-gap`
itself and lists the unreadable API calls in the plan. The judge may inspect the
page but may not pass the check: the result is capped at `manual_review` with
cause `SPEC_GAP` until the parser gap is closed. Because it is derived rather
than declared, `judgment-parser-gap` is not accepted in a `livePolicies` entry.


The two `executable-*` verbs are the ones the harness treats as **mutating**: a
plan containing either is not a read-only plan, which turns off the read-only
mutation guard for that run. See
[How verdicts are decided](../explanation/how-verdicts-are-decided.md).

### Project-specific policy names

The `livePolicies` config block adds annotation names, or redefines built-in
ones — it is consulted before the built-in table. Each entry must reuse one of
the seven verbs above.

```js
// playwright-spec-for-ai-agent.config.mjs
livePolicies: {
  "cancel-subscription": { liveRunPolicy: "blocked-subscription-mutation" },
  readonly: { liveRunPolicy: "judgment-mock-api" }, // redefines a built-in
},
```

```ts
// @qa-live-policy: cancel-subscription
test("cancels the plan", async ({ page }) => { /* ... */ });
```

`stagingMode` is optional and defaults to the mode of the built-in policy that
shares the same verb. Key details and validation messages are in
[Configuration](./configuration.md#livepolicies).

## Errors

| Message                                                                     | Exit | Cause                                                                    |
| --------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------- |
| `Missing // @qa-live-policy on test "<title>" (<file>:<line>).`             | 2    | No policy on the test or an enclosing `describe`.                        |
| `Unknown @qa-live-policy: <name>. Use one of: …`                            | 2    | Annotation name is neither built in nor configured. The message lists your configured custom names too. |
| `Configured @qa-live-policy "<name>" maps to unknown liveRunPolicy "<verb>".` | 2  | A `livePolicies` entry names a verb that is not one of the seven.        |
| `N upload fixture(s) referenced by the QA spec do not exist:`               | 2    | A `@qa-fixture` path does not resolve to a file. Use `--allow-missing-fixtures` to downgrade. |
| `[qa-spec] <file>: N test(s) could not be parsed and are missing from the QA spec.` | — | Warning, not an error. See [Unparsed tests](#unparsed-tests).       |

## What `spec` discovers

`spec` reads every `*.spec.ts` in the resolved spec directory, keeps the files
that carry a `@qa-scenario` line, and drops the files that carry
`@qa-live-skip: true`.

It recognises `test`, `test.only`, `test.skip`, and `test.fixme` declarations,
with any quote style and any argument list.

### Unparsed tests

A test declaration the parser could not extract is counted, warned about, and
recorded in the artifact as `unparsedTestCount`. It is **absent** from the QA
spec rather than silently assumed to pass. Hooks such as `test.beforeEach` and
in-body modifiers such as `test.skip(condition)` are not counted.

## A complete file

```ts
// @qa-page: billing
// @qa-scenario: INACTIVE
// @qa-fixture: avatar=tests/fixtures/qa-avatar.png

import { expect, test } from "@playwright/test";

test.describe("Billing — inactive subscription", () => {
  // @qa-live-policy: readonly
  test("shows inactive billing state", async ({ page }) => {
    await page.goto("/settings/billing");
    await expect(page.getByText("Inactive subscription")).toBeVisible();
  });

  // @qa-live-policy: safe-interaction-no-confirm
  test("opens the cancellation dialog", async ({ page }) => {
    await page.getByRole("button", { name: "Cancel subscription" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
```

`spec` reads this file as source material. It never runs Playwright against
staging.

## Limits and cautions

- Only `.spec.ts` files are read. Other extensions are ignored.
- Static expectations are extracted only for `read-only` tests. Tests in an
  `interaction`, `auth`, or `live-skip` staging mode contribute no parsed
  expectations; the judge works from the plan text instead.
- A file-level `@qa-live-skip: true` overrides every test-level policy in that
  file: all of its tests become `blocked-live-skip`.
- If one comment block above a test contains two `@qa-live-policy` lines, the
  line furthest from the test wins. Write one.
- The spec hash that gates `abstract-ai` and `judge` covers **every** `.spec.ts`
  in the directory, not only the annotated ones — adding an annotation is itself
  a change.

## Related

- [CLI reference](./cli.md#spec) — the `spec` command's flags and exit codes
- [Configuration](./configuration.md#livepolicies) — `livePolicies` and fixture defaults
- [Artifacts](./artifacts.md) — what `spec` writes
- [The pipeline](../explanation/pipeline.md) — where annotations enter the flow
- [Troubleshooting](../troubleshooting.md) — symptom-indexed fixes
