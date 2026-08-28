# Get started

This tutorial takes a developer who has Playwright specs and a staging deploy, and
ends with an AI-judged verdict on one live page. You will run the whole pipeline
twice: first offline against a bundled demo app, so you see the shape of a run
before configuring anything, then against a page of your own.

When you finish you will have:

- a `playwright-spec-for-ai-agent.config.mjs` pointing at your specs and your staging origin;
- one spec file carrying `@qa-scenario` and `@qa-live-policy` annotations;
- an output directory holding the plan, the judgment, and the evidence for one page;
- a verdict on screen: `pass`, `fail`, `manual_review`, or `skip`.

## Prerequisites

- Node.js 20 or newer (`node --version`).
- A repository with Playwright specs in `*.spec.ts` files.
- A staging deploy of that app, reachable from your machine.
- For part 2 only: an agent backend on `PATH`. The default is `hermes-agent`; see
  [reference/adapters.md](./reference/adapters.md) for the alternatives.

Part 1 needs none of the above except Node.

## Part 1 — see a full run, offline

Run the demo. It serves a bundled demo app on a local port and drives the whole
pipeline with the `fixture` adapter, which returns canned output instead of calling
a model.

```bash
npx playwright-spec-for-ai-agent demo --keep
```

The command prints one section per stage. Abbreviated below, with `<out>` standing
in for the throwaway project directory named on the `Throwaway project:` line:

```text
Demo app served at http://127.0.0.1:64234 (spec: …/examples/demo-app)
Throwaway project: <out>
Adapter: fixture (offline; no model, no credentials, no network)

--- spec ---
Demo QA spec written: <out>/__QA__/demo-qa-spec.json
  Live QA tests in JSON: 3 included, 1 excluded (4 parsed total)
  - ACTIVE: 3 test(s), playwright: 2 expectation(s), executable-interaction: 1

--- abstract-ai ---
Live plan (GWT): <out>/__QA__/demo-qa-spec-live.md
Coverage: 3/3 planned tests addressed

--- judge ---
Preflight http://127.0.0.1:64234/dashboard -> HTTP 200
Hermes demo QA judgment (browse): manual_review [HARNESS_DEFECT] — 3/3 planned
checks addressed (run run-ded21971)

--- review ---
Judge review: flagged
```

Three facts to take from this run:

- **The fourth test was excluded, and the run says so.** `demo.spec.ts` marks it
  `// @qa-live-policy: auth-mock`, which is blocked on a live site, so it becomes
  `skip` and appears in a "Skipped from live QA JSON" table instead of vanishing.
- **The offline verdict is `manual_review`, never `pass`.** The `fixture` adapter
  browsed nothing, so a green result would be a lie. An offline demo cannot look green.
- **`review` exits 1 here, and the demo explains why.** The fixture reviewer marks
  every rubric criterion `concern` because it read nothing. The `demo` command
  itself still exits 0.

Read the plan the second stage wrote:

```bash
cat <out>/__QA__/demo-qa-spec-live.md
```

Each annotated test became one Given/When/Then block:

```markdown
### ACTIVE — shows an account health score
Given: the demo dashboard is open and the account health widget is present
When: the widget has finished loading and its value is read
Then: a numeric health score is shown together with its meter
Never: the score area stays empty, shows a spinner, or renders an error after load; mutations: 0
```

That document — not your spec file — is what the judge is handed. Everything after
this point is about producing one of these for your own page and having an agent
answer it against live staging.

## Part 2 — judge one of your own pages

Run every command below from your app repository, where the specs live.

### 1. Install the CLI

```bash
npm install -D playwright-spec-for-ai-agent
```

Install the optional peer too if you want the runner to own the browser, and with it
the trace, HAR, and screenshot evidence:

```bash
npm i -D @playwright/test && npx playwright install chromium
```

### 2. Write the config

Copy the shipped example and edit it:

```bash
cp node_modules/playwright-spec-for-ai-agent/playwright-spec-for-ai-agent.config.example.mjs \
   playwright-spec-for-ai-agent.config.mjs
```

Three blocks are enough to start. Point `specDir` at where your specs already are,
and name one page:

```js
import { defineConfig } from "playwright-spec-for-ai-agent/config";

export default defineConfig({
  paths: {
    specDir: "e2e/{page}",
    outputDir: "qa-output/{page}",
  },
  staging: {
    baseUrl: "https://staging.acme.dev",
    loginPath: "/login",
  },
  pages: {
    pricing: { targetPath: "/pricing", authRequired: false },
  },
});
```

Start with a page that needs no login (`authRequired: false`). It removes the
session step from your first run, and you can add an authenticated page once the
pipeline works. Every other key is in
[reference/configuration.md](./reference/configuration.md).

### 3. Annotate one spec file

Two annotations are mandatory: `@qa-scenario` at the top of the file, and
`@qa-live-policy` on every test (or on an enclosing `test.describe`).

```ts
// @qa-scenario: ACTIVE

import { expect, test } from "@playwright/test";

test.describe("Pricing page", () => {
  // @qa-live-policy: readonly
  test("shows the three plan tiers", async ({ page }) => {
    await expect(page.getByTestId("plan-tier")).toHaveCount(3);
  });
});
```

`readonly` tells the judge to inspect the page and click nothing that mutates state.
The other six policies — including the ones that block a test from live QA
entirely — are in [reference/annotations.md](./reference/annotations.md).

An annotation only counts when it is the entire comment line, so
`// @qa-live-skip: true // temporarily` does not activate. `@qa-live-policy` is the
one exception: a trailing `// note` after its value is tolerated.

### 4. Check the setup before spending a model call

```bash
npx playwright-spec-for-ai-agent doctor
```

`doctor` resolves the config, counts the annotated specs it found, checks the agent
backend and its model, and reports whether a session exists. It exits 0 when every
required check passes and 3 otherwise. Run against the config above, it prints:

```text
playwright-spec-for-ai-agent doctor

  PASS  config                  playwright-spec-for-ai-agent.config.mjs
  PASS  pricing · spec dir      e2e/pricing — 1 annotated, 0 @qa-live-skip, 1 runnable
  PASS  pricing · target        https://staging.acme.dev/pricing
  SKIP  pricing · last verdict  not judged yet
  PASS  adapter                 hermes (auth=cdp-attach maxTurns=true video=true blocksEventLoop=true)
  PASS  adapter binary          /Users/you/.hermes/hermes-agent/venv/bin/python
  PASS  adapter model           gpt-5.4-mini
  FAIL  adapter provider        openai-codex configured but OPENAI-CODEX_API_KEY is unset — hermes-agent will refuse to start
                                 → Export OPENAI-CODEX_API_KEY, put it in ~/.hermes/.env, or switch provider with `hermes model`.
  SKIP  session profile         none — judge would need credentials in the prompt
                                 → Run `npx playwright-spec-for-ai-agent login` to create one.
  SKIP  credentials             no configured page requires login
  PASS  @playwright/test        importable
  SKIP  SLACK_WEBHOOK_URL       unset — `slack` would refuse to post

1 failed, 0 warning, 7 passed, 4 skipped.
```

Fix every `FAIL` before continuing; each one prints a `→` hint naming the command
that resolves it. The `SKIP` rows above are expected on a first run against a page
with `authRequired: false` — nothing has been judged yet, no session is needed, and
Slack is not configured.

### 5. Parse the annotations

```bash
npx playwright-spec-for-ai-agent spec --page=pricing
```

This writes two JSON artifacts and prints how many tests it kept:

```text
Pricing QA spec written: …/qa-output/pricing/pricing-qa-spec.json
Pricing rule-abstracted spec: …/qa-output/pricing/pricing-qa-spec-abstracted.json
  Live QA tests in JSON: 1 included, 0 excluded (1 parsed total)
  Excluded tests recorded in artifact: 0
  Spec sources hash: sha256:c63c98043372b3d558485faa0f3cc7ae9d244112dbb1d6506f472b8d525b5f38
  (run abstract-ai --page=pricing for qa-spec-live.json + .md)
  - ACTIVE: 1 test(s)
```

An `excluded` count above zero is normal — it is your `blocked-*` policies doing
their job, and each excluded test is listed with its reason. A
`N test(s) could not be parsed` line means the parser skipped a test rather than
assuming it passes; look at that test's shape before trusting the coverage number.

The spec sources hash is stamped onto every later artifact. It is what makes `judge`
refuse a plan built from a spec revision that no longer exists.

### 6. Turn the spec into a live plan

```bash
npx playwright-spec-for-ai-agent abstract-ai --page=pricing
```

An agent rewrites each parsed test as Given/When/Then, replacing CI-only literals
(mocked API values, seeded fixtures) with the intent behind them, because those
cannot be replayed against a live deploy. Open the result and read it — this is the
one artifact worth reviewing by hand before every judge run:

```bash
cat qa-output/pricing/pricing-qa-spec-live.md
```

The command prints `Coverage: N/N planned tests addressed`. Anything less than full
coverage means the plan dropped a test, and the judge will floor the verdict at
`manual_review` later for the same reason.

To see the prompt and its size before spending a model call, pass `--dry-run`. It
writes `pricing-hermes-abstract-query.txt` and stops:

```text
Dry run — query written: …/qa-output/pricing/pricing-hermes-abstract-query.txt
Query size: ~607 tokens (est.)
```

### 7. Judge the live page

```bash
npx playwright-spec-for-ai-agent judge --page=pricing
```

The agent opens `https://staging.acme.dev/pricing`, works through the plan, and
reports one check per planned block. The harness then scores that report — it can
lower the agent's verdict but never raise it. One summary line comes back, in this
shape:

```text
Hermes pricing QA judgment (browse): pass [NONE] — 1/1 planned checks addressed (run run-4f2a91c0)
```

`pass` is the harness's verdict after scoring, `NONE` is its cause, and `1/1` is the
coverage. A verdict of `manual_review` here is a result, not a failure — read
[explanation/how-verdicts-are-decided.md](./explanation/how-verdicts-are-decided.md)
for which floor produced it.

If your page needs a login, this is the step that fails without a session. Stop
here and set one up: [how-to/authentication.md](./how-to/authentication.md) covers
the three paths and which one your app forces on you.

### 8. Read the verdict

```bash
npx playwright-spec-for-ai-agent show --page=pricing
```

`show` prints the verdict and its cause, the run id and target, a per-check table
with each check's cause and confidence, the coverage count, the review result, and
every artifact path. Here it is against the demo project from part 1, where the
offline adapter judged nothing:

```text
Page QA — demo

  Verdict: MANUAL_REVIEW (HARNESS_DEFECT)
  Summary: Fixture adapter output — nothing was browsed or verified. Not a real verdict.
  Action:  Set QA_AI_ADAPTER to a real backend (hermes, aside, exec) before trusting a verdict.

  Run:       run-ded21971  2026-08-28T02:28:28.842Z
  Agent:     fixture, 0s
  Target:    http://127.0.0.1:64234/dashboard
  Plan:      spec-live.md
  Spec hash: current (sha256:95ae1c48…)

Checks:
  RESULT         ITEM                               CAUSE           CONF  DETAIL
  -------------  ---------------------------------  --------------  ----  ------
  manual_review  shows the plan name in the header  HARNESS_DEFECT  low   Fixture adapter ran in browse mode…
  manual_review  shows an account health score      HARNESS_DEFECT  low   Fixture adapter ran in browse mode…
  manual_review  opens the plan details panel       HARNESS_DEFECT  low   Fixture adapter ran in browse mode…

Coverage:
  3/3 planned checks addressed.
```

Narrow the output when you only want part of it: `--failed` drops the passing
checks, `--evidence` prints artifact paths only, and `--json` emits the whole report
for a script.

## Verify you are done

You have a working setup when all four hold:

1. `doctor` exits 0.
2. `qa-output/pricing/` contains `pricing-qa-spec-live.md` and `pricing-hermes-judgment.json`.
3. `show --page=pricing` prints a verdict and a per-check table with no missing rows.
4. `judge` exits 0 on a `pass`, and 1 on a `fail`.

Check the exit code directly:

```bash
npx playwright-spec-for-ai-agent judge --page=pricing; echo "exit=$?"
```

Exit 2 is a usage or stale-artifact problem, 3 is the environment, and 4 means the
adapter returned output the harness cannot use. The full table is in
[how-to/ci.md](./how-to/ci.md).

## Common stumbles

| Symptom                                                       | Cause                                                                    | Fix                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `spec` finds nothing                                          | No file in the resolved `specDir` carries a `@qa-scenario` line.         | Check the resolved path in `doctor`'s `spec dir` row, then add the annotation. |
| `Missing // @qa-live-policy on test "…"`                      | A parsed test has no policy, on itself or an enclosing `describe`.       | Add one. See [reference/annotations.md](./reference/annotations.md).       |
| `judge` refuses the plan as stale                             | The spec changed after `abstract-ai` ran; the stamped hashes disagree.   | Re-run `spec` and `abstract-ai`, then judge.                               |
| Every check comes back `manual_review`                        | The agent passed without citing evidence, or coverage was incomplete.    | Read [explanation/how-verdicts-are-decided.md](./explanation/how-verdicts-are-decided.md). |
| The verdict is a `pass` you do not believe                    | One run is a sample, not proof.                                          | Re-run, or use `review --samples=`.                                        |

Any error string not listed here is in
[troubleshooting.md](./troubleshooting.md), indexed by the message the CLI printed.

## Where to go next

- Add the second agent pass: `review --page=pricing` re-checks the judgment against a
  pinned evidence packet and exits non-zero when the review is `flagged` or
  `unstable`, or when any rubric criterion comes back `concern` or `fail`.
- Chain the whole pipeline: `nightly --all --with-slack --non-interactive`.
- Put it in CI: [how-to/ci.md](./how-to/ci.md).
- Understand what each stage is for: [explanation/pipeline.md](./explanation/pipeline.md).
- Look up a term you hit along the way: [glossary.md](./glossary.md).
