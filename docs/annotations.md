# Annotations

QA intent lives in the Playwright specs you already have, as `//` comments. The
`spec` command parses them; nothing else in the pipeline reads your test code.

## The whole-comment-line rule

An annotation is recognised **only when it is the entire comment line**. Every
pattern is anchored to the start of the line (leading spaces and tabs allowed)
and to the `//` that opens the comment. Prose that merely mentions an
annotation is documentation, not an annotation:

```ts
// @qa-live-skip: true          ← activates
// `@qa-live-skip: true` means the file is skipped   ← does not activate
```

`@qa-live-skip` and `@qa-always-run` additionally require the line to *end*
after `true`, so `// @qa-live-skip: true // temporarily` does not activate
either. `@qa-live-policy` is the one exception: a trailing `// note` after the
value is tolerated.

## File-level annotations

Put them at the top of the spec file, before the imports.

| Annotation                 | Required | Meaning                                                                  |
| -------------------------- | -------- | ------------------------------------------------------------------------ |
| `// @qa-scenario: ACTIVE`  | yes      | Scenario id. A file without it is invisible to `spec`.                   |
| `// @qa-page: billing`     | no       | Page id override, when the file lives outside the page's spec dir.       |
| `// @qa-live-skip: true`   | no       | Exclude this file from live QA; every test in it becomes `skip`.         |
| `// @qa-always-run: true`  | no       | Judge this scenario even when another scenario was selected for the run. |

`@qa-scenario` captures **one whitespace-delimited token** — `ACTIVE`,
`CANCEL_PENDING`, `billing-inactive`. Anything after the first token is ignored,
so a prose sentence becomes the scenario id `A`. The human-readable label comes
from the file's first `test.describe("…")` title instead (falling back to the
file name).

`judge` picks one scenario matching the live account, plus every `@qa-always-run`
scenario.

## Test-level annotations

| Annotation                                            | Required | Scope                |
| ----------------------------------------------------- | -------- | -------------------- |
| `// @qa-live-policy: readonly`                        | **yes**  | `test` or `describe` |
| `// @qa-fixture: avatar=tests/fixtures/qa-avatar.png` | no       | file, `describe`, or `test` |

`@qa-live-policy` is mandatory for every parsed test. Without one — on the test
or on an enclosing `test.describe` — `spec` fails with
`Missing // @qa-live-policy on test "<title>" (<file>:<line>)`. A test-level
annotation wins over the innermost enclosing `describe`.

`@qa-fixture` names an upload file for live file-input replay. Paths are
repo-relative and may be quoted. Resolution is closest-wins per fixture name:
test comment > enclosing `describe` > file header > `pages.{page}.fixtures` >
`staging.fixtures` > `fixtures`. `spec` fails if a named fixture file is missing;
`--allow-missing-fixtures` downgrades that to a warning.

## Live policies

`@qa-live-policy` tells the judge how far it may go on a live site. Each name
maps to a `liveRunPolicy` verb (what the judge is allowed to execute) and a
staging mode.

| Annotation                    | `liveRunPolicy`                   | Staging mode | Judge behaviour                                                                    |
| ----------------------------- | --------------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| `readonly`                    | `executable-readonly`             | read-only    | Inspect the page; no mutating clicks.                                              |
| `safe-interaction`            | `executable-interaction`          | interaction  | Follow the Playwright steps quoted in the plan; dismiss risky dialogs with Esc. Mandatory to execute — not skippable for caution alone. |
| `safe-interaction-no-confirm` | `judgment-interaction-no-confirm` | interaction  | Open the flow, stop before the confirm/destructive submit, Esc out.                |
| `mock-judgment`               | `judgment-mock-api`               | read-only    | The CI test relied on `page.route` mocks that cannot be replayed. Judge by intent, not by mock literals. |
| `subscription-mutation`       | `blocked-subscription-mutation`   | interaction  | Blocked on live: reported as `skip`.                                               |
| `auth-mock`                   | `blocked-auth-mock`               | auth         | Blocked on live: reported as `skip`.                                               |
| `skip`                        | `blocked-live-skip`               | live-skip    | Blocked on live: reported as `skip`.                                               |

The two `executable-*` verbs are the ones the harness treats as *mutating*: a
plan containing either is not a read-only plan, which turns off the read-only
mutation guard for that run. See [verdicts.md](./verdicts.md).

### Custom policy names

The `livePolicies` config block adds annotation names, or redefines built-in
ones — it is consulted first. Each entry must reuse one of the seven
`liveRunPolicy` verbs above:

```js
// playwright-spec-for-ai-agent.config.mjs
livePolicies: {
  "cancel-subscription": { liveRunPolicy: "blocked-subscription-mutation" },
  "readonly": { liveRunPolicy: "judgment-mock-api" }, // redefines a built-in
},
```

```ts
// @qa-live-policy: cancel-subscription
test("cancels the plan", async ({ page }) => { /* ... */ });
```

`stagingMode` is optional and defaults to the mode of the built-in policy with
the same verb. An unknown annotation name fails with
`Unknown @qa-live-policy: <name>. Use one of: …` — and the message lists your
configured custom names too.

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

## What `spec` discovers

`listAnnotatedSpecFiles` walks the resolved spec directory, keeps files ending
in `.spec.ts` that carry a `@qa-scenario` line, and drops files carrying
`@qa-live-skip: true`. Tests the parser could not extract are counted and
reported as `[qa-spec] <file>: N test(s) could not be parsed`; they are absent
from the QA spec rather than silently assumed to pass.
