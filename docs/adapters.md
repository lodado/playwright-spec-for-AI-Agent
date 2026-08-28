# Agent adapters

Every stage that calls a model (`abstract-ai`, `judge`, `review`) goes through
one seam:

```
run(query, maxTurns, options) -> parsed JSON
```

Select the backend with `QA_AI_ADAPTER`. The default is `hermes`.

```bash
QA_AI_ADAPTER=aside npx playwright-spec-for-ai-agent judge --page=dashboard
```

Whichever backend ran is stamped onto the judgment as
`agentMeta: { adapter, model, durationMs }` — taken from the adapter, not from
the agent's self-reported `source`, which comes from a prompt template and lies
when the backend is swapped.

## Built-in adapters

| Name      | Backend                                      | `auth`                  | maxTurns | toolset disable | video |
| --------- | -------------------------------------------- | ----------------------- | -------- | --------------- | ----- |
| `hermes`  | Hermes Agent (`hermes-agent`)                | `cdp-attach`            | yes      | yes             | yes   |
| `aside`   | Aside Browser CLI (`aside exec`)             | `self-prelogin`         | no       | no              | no    |
| `exec`    | any CLI named by `QA_AGENT_CMD`              | `credentials-in-prompt`¹| no       | no              | no¹   |
| `fixture` | canned offline output; no model, no network  | `credentials-in-prompt` | no       | no              | no    |

¹ `QA_AGENT_AUTH=cdp-attach` switches the `exec` adapter to `cdp-attach` and
turns video on — set it only when your CLI's browser tools honour
`BROWSER_CDP_URL`.

All four run their CLI with `spawnSync`, so all four take the descriptor default
`blocksEventLoop: true`. That is the field that decides whether the run gets
live request interception or post-run HAR inspection — see
[Capability descriptors](#capability-descriptors).

### `hermes`

Requires the `hermes-agent` binary on `PATH` (or under `~/.hermes/hermes-agent`)
and a model from `HERMES_INFERENCE_MODEL` or `~/.hermes/config.yaml`.
`HERMES_INFERENCE_BASE_URL` points at a self-hosted or proxy endpoint. Every run
boots stateless: a throwaway `HERMES_HOME` with empty `memories/` and
`sessions/`, torn down when the process exits, plus the `memory` toolset
disabled. Text-only stages additionally disable browser/terminal toolsets
(`HERMES_QA_DISABLED_TOOLSETS` overrides that list). `HERMES_QA_COMMAND` is
reserved — any value other than `hermes-agent` aborts the run.

### `aside`

Requires the `aside` CLI. Model and effort come from Aside's own user settings
unless `ASIDE_QA_MODEL` / `ASIDE_QA_EFFORT` are set. It drives its own persistent
browser, so `judge` has to authenticate that browser before the run — one of two
ways, and **a configured `storageState` wins**:

- With `staging.storageState` (or `pages.{page}.storageState`) set, the stored
  cookies and `localStorage` are seeded into Aside's browser and `prelogin` is
  not called at all. No credentials are needed or read.
- Otherwise the adapter's `prelogin` pipes a login script to `aside repl` on
  stdin — credentials stay out of the prompt, out of argv, and out of session
  logs.

`ASIDE_QA_COMMAND` is reserved the same way `HERMES_QA_COMMAND` is.

### `exec`

The escape hatch for whichever agent CLI a team already runs. The stage prompt
goes on **stdin**, never argv (argv is world-readable in `ps`, and in
credentials-in-prompt mode the prompt carries secrets).

```bash
QA_AI_ADAPTER=exec QA_AGENT_CMD="claude -p --output-format json" \
  npx playwright-spec-for-ai-agent judge --page=pricing
```

The command line is split on whitespace, honouring single and double quotes.
A missing `QA_AGENT_CMD` is an environment error with the fix in the message.

### `fixture`

Offline, deterministic, shape-correct stage output. This is what `demo` and the
pipeline tests run on. The built-in judge fixture always returns
`manual_review` with cause `HARNESS_DEFECT` and the summary "Fixture adapter
output — nothing was browsed or verified. Not a real verdict.", so an offline run
can never be mistaken for a green verdict.

The built-in fixtures read the prompt they were handed, which is what lets
`QA_AI_ADAPTER=fixture` drive **any** project's pipeline rather than only the
bundled demo:

- **judge** echoes the plan's real check titles, parsed from the
  `### <scenario> — <test title>` headings in the prompt, one check per title.
  An invented title would fail the coverage gate the run is meant to exercise.
- **review** echoes the `packetSha256` digest found in the prompt, so the
  packet-digest gate sees the packet it actually reviewed.
- **abstract** builds its `livePlan` from the spec payload in the prompt — one
  block per real scenario/test. A plan that invents titles is rejected by the
  abstract stage's validator, which is exactly what used to make this adapter
  unusable outside the demo. With no parseable payload it falls back to a
  single block that names no test.

Point `QA_FIXTURE_DIR` at a directory of `<stage>.json` files (`abstract.json`,
`judge.json`, `review.json`) to replay your own recorded responses. The stage is
inferred from the required keys the caller asked for: `livePlan` → abstract,
`criteria`/`overallReview` → review, otherwise judge. The directory is
**per-stage**: a missing `<stage>.json` falls back to that stage's built-in
fixture, so you can pin only the stage you care about. A `QA_FIXTURE_DIR` that
does not exist at all is still an error.

## What `auth` means for the judge's session

`auth` is the only thing that decides where a judge run's session comes from.
`--credentials-in-prompt` forces the last mode whatever the adapter declares.

### `cdp-attach` — the harness owns the browser

The runner launches or attaches to a browser, then hands the agent
`BROWSER_CDP_URL` for the duration of the run. Two sources, and **the attached
browser outranks the profile when both exist**:

| Source                                     | Comes from                                                 |
| ------------------------------------------ | ----------------------------------------------------------- |
| `judge --cdp-url=<url>` / `QA_BROWSER_CDP_URL` | a browser you already run and already signed into        |
| the private profile `.private/qa-browser-profile` | `login`, where you signed in by hand once            |

Attaching is the answer for an identity provider that refuses
automation-controlled browsers (Google and most SSO portals): you log in as a
human, the tool only borrows the session. `login --attach` prints the recipe.
Three things to know before you use it:

- **Start that browser with a dedicated `--user-data-dir`.** Attaching to your
  everyday Chrome profile hands the agent every site you are signed into. The
  printed recipe uses `/tmp/qa-chrome` and says so.
- **Evidence is narrower on an attached browser.** Tracing and the per-page
  settled screenshot / aria snapshot work; HAR does not, because `recordHar` is
  a launch-time option and the context already exists. The run records a
  `capture-unavailable` violation rather than implying a HAR was captured. No
  video either — `QA_RECORD_VIDEO` applies only to a runner-launched browser.
- **Closing disconnects.** `close()` detaches the client; it never closes the
  browser you started.

`login --channel=<name>` launches real Chrome/Edge instead of bundled Chromium,
which some identity providers accept where they reject the bundled build.

### `self-prelogin` — the adapter owns the browser

The adapter drives its own persistent browser, so the harness authenticates it
before the run and never sets `BROWSER_CDP_URL`. With `staging.storageState`
configured, the stored cookies and `localStorage` are seeded into that browser
and `prelogin()` is not called; without one, `prelogin()` runs. Seeding goes
through `document.cookie`, so an **httpOnly cookie cannot be replayed this
way** — the run fails with an environment error naming the blocked cookies and
pointing at the `cdp-attach` path, instead of quietly judging as an anonymous
visitor.

### `credentials-in-prompt` — the fallback

No session to hand over, so the staging credentials go into the prompt itself
(and therefore into the agent's session logs). `judge` prints a `[security]`
warning and recommends `login`. This is where an adapter lands when it declares
nothing, and where any adapter lands under `--credentials-in-prompt`.

## Timeouts

Every CLI adapter is wall-clock bounded at 10 minutes by default:
`HERMES_QA_TIMEOUT_MS`, `ASIDE_QA_TIMEOUT_MS`, `QA_AGENT_TIMEOUT_MS`. A timeout
surfaces as an environment error naming the variable to raise.

## Capability descriptors

Callers branch on what a backend can do, never on its name.

```js
{
  auth: "cdp-attach" | "self-prelogin" | "credentials-in-prompt",
  supportsMaxTurns: boolean,
  supportsToolsetDisable: boolean,
  supportsVideo: boolean,
  blocksEventLoop: boolean,   // default true
}
```

What each field changes:

- **`auth`** decides the judge's credential path — `cdp-attach`,
  `self-prelogin`, or credentials in the prompt. See
  [What `auth` means for the judge's session](#what-auth-means-for-the-judges-session).
- **`supportsMaxTurns: false`** makes the judge skip its computed turn budget
  entirely — the adapter is bounded by wall clock instead.
- **`supportsVideo`** says whether `QA_RECORD_VIDEO` can apply at all: the
  recording is made by the browser the runner launches, which only a
  `cdp-attach` adapter gets. `doctor` reports it.
- **`blocksEventLoop`** is load-bearing, not informational. Every built-in
  adapter runs its CLI with `spawnSync`, which freezes this process for the whole
  agent run — so a Playwright `context.route` handler could never be serviced.
  Live request interception (origin pinning, mutation blocking) is therefore
  enabled **only** for an adapter declaring `blocksEventLoop: false`. Blocking
  adapters get the same coverage from post-run HAR inspection.

Run `doctor` to see the resolved descriptor:

```
PASS  adapter   hermes (auth=cdp-attach maxTurns=true video=true blocksEventLoop=true)
```

## Third-party adapters

`QA_AI_ADAPTER` also accepts a **module specifier** — anything containing `/`,
`.`, or starting with `@`. It is resolved from the directory the command was run
in (your project root), so both a path and an installed package work:

```bash
QA_AI_ADAPTER=./qa-adapters/my-agent.mjs npx playwright-spec-for-ai-agent judge --page=pricing
QA_AI_ADAPTER=@acme/qa-adapter          npx playwright-spec-for-ai-agent judge --page=pricing
```

The module contract:

| Export         | Required | Shape                                                              |
| -------------- | -------- | ------------------------------------------------------------------ |
| `run`          | yes      | `(query, maxTurns, options) => object` (parsed JSON, not a Promise)|
| `capabilities` | no       | Partial descriptor, merged over the defaults above                 |
| `prelogin`     | no       | `({ loginUrl, email, password }) => void`, used when `auth: "self-prelogin"` |
| `resolveModel` | no       | `() => string｜null`, recorded as `agentMeta.model`                |

`options` carries `{ paths, secrets, requiredKeys, requiredKeyGroups, mode }`.
`mode` is `"browse"` for `judge` and `"text-only"` for `abstract-ai` / `review`.

Your `run` is responsible for the shared tail every built-in adapter uses:
write the prompt and the raw output as artifacts with `secrets` redacted, then
extract and key-check the JSON. Reuse it rather than reimplementing:

```js
import {
  finalizeAgentRun,
  writeAgentQueryArtifact,
} from "playwright-spec-for-ai-agent/scripts/agent-output.mjs";
```

A module adapter must be imported before use. Entry scripts already
`await prepareAdapter()`; if you call `runAgent` yourself, do the same first or
you get `QA_AI_ADAPTER module "…" was never loaded: call prepareAdapter() first.`

### Running the contract suite against your adapter

The suite that the four built-ins pass is exported from the published package.
Point it at your `run` in your own vitest file:

```ts
// my-adapter.contract.test.ts
import { runAdapterContractSuite } from "playwright-spec-for-ai-agent/scripts/__tests__/agent-runner-contract.test.ts";
import { run } from "./qa-adapters/my-agent.mjs";

runAdapterContractSuite("my-agent", run);
// adapters that never spawn a process:
// runAdapterContractSuite("my-agent", run, { spawns: false });
```

It asserts, among other things, that the adapter returns parsed JSON when the
required keys are present, and that both the query artifact and the raw output
artifact are written with `secrets` replaced by `[redacted]`.
