# Run against an agent backend that is not built in

This page is for a team that already runs its own agent CLI or SDK and wants the
QA pipeline to call that instead of `hermes` or `aside`. When you finish, every
stage that calls a model (`abstract-ai`, `judge`, `review`) goes through your
backend, and the judgment records it in `agentMeta`.

Two routes. Take the first one that fits:

1. **Your backend is a CLI that reads a prompt on stdin and prints JSON.** Set
   two environment variables. No code.
2. **Anything else** — an SDK, an HTTP API, a CLI with a different I/O shape.
   Write a module that exports `run`.

The four built-in adapters and what they declare are in
[Adapters](../reference/adapters.md). Read that first if you are not sure your
backend needs a new adapter at all.

## Route 1: point `exec` at your CLI

Use this when your CLI can be invoked as `<command> <args>` with the prompt on
stdin and one JSON object on stdout.

1. Select the adapter and name the command:

   ```bash
   QA_AI_ADAPTER=exec QA_AGENT_CMD="claude -p --output-format json" \
     npx playwright-spec-for-ai-agent judge --page=pricing
   ```

   The command line is split on whitespace, honouring single and double quotes.
   The prompt goes on **stdin**, never argv — argv is world-readable in `ps`,
   and in credentials-in-prompt mode the prompt carries secrets.

2. If your CLI's browser tools honour `BROWSER_CDP_URL`, opt in to the
   harness-owned browser so credentials stay out of the prompt:

   ```bash
   QA_AGENT_AUTH=cdp-attach
   ```

   That switches the adapter's `auth` to `cdp-attach` and turns `supportsVideo`
   on. Set it only when the CLI actually reads the variable; otherwise the run
   hands the agent a browser it ignores and judges signed out.

3. Raise the wall clock if ten minutes is not enough:

   ```bash
   QA_AGENT_TIMEOUT_MS=1200000
   ```

   A timeout surfaces as an environment error naming the variable to raise, and
   the partial output is still written to the raw artifact.

### Confirm it worked

```
$ QA_AI_ADAPTER=exec QA_AGENT_CMD="my-agent --json" npx playwright-spec-for-ai-agent doctor
PASS  adapter          exec (auth=credentials-in-prompt maxTurns=false video=false blocksEventLoop=true)
PASS  adapter binary   QA_AGENT_CMD=my-agent --json
```

A missing `QA_AGENT_CMD` is an environment error with the fix in the message.

## Route 2: write a module adapter

Use this when route 1 does not fit. `QA_AI_ADAPTER` also accepts a **module
specifier** — anything containing `/` or `.`, or starting with `@`. It is
resolved from the directory the command was run in (your project root), so both
a path and an installed package work:

```bash
QA_AI_ADAPTER=./qa-adapters/my-agent.mjs npx playwright-spec-for-ai-agent judge --page=pricing
QA_AI_ADAPTER=@acme/qa-adapter          npx playwright-spec-for-ai-agent judge --page=pricing
```

### 1. Export `run`

The full contract is in [Adapters](../reference/adapters.md). The minimum is one
function:

```js
// qa-adapters/my-agent.mjs
export function run(query, maxTurns, options = {}) {
  // ... call your backend with `query` ...
  return { status: "pass", summary: "…" }; // parsed JSON, not a Promise
}
```

`run` must return a plain object synchronously. `runAgent` is synchronous for
its three call sites, so a Promise is not awaited.

`options` carries `{ paths, secrets, requiredKeys, requiredKeyGroups, mode }`.
`mode` is `"browse"` for `judge` and `"text-only"` for `abstract-ai` and
`review`. `requiredKeys` differs per stage (`["status"]`, `["livePlan"]`,
`["criteria", "overallReview"]`), which is how one `run` serves all three.

### 2. Reuse the shared tail

Your `run` owns the tail every built-in adapter performs: write the prompt and
the raw output as artifacts with `secrets` redacted, then extract and key-check
the JSON. Import it rather than reimplementing it:

```js
import {
  finalizeAgentRun,
  writeAgentQueryArtifact,
} from "playwright-spec-for-ai-agent/scripts/agent-output.mjs";
```

`writeAgentQueryArtifact(paths, query, secrets)` and `finalizeAgentRun(result,
options)` resolve the right artifact path for whichever stage called you —
`paths` uses different keys per stage — and `finalizeAgentRun` writes the raw
output **before** it throws, so a run that ends in a timeout still leaves the
operator everything the agent printed.

### 3. Declare only what differs

`capabilities` is merged over the defaults, so export the fields you change:

```js
export const capabilities = { auth: "cdp-attach", supportsMaxTurns: true };
```

The defaults are `auth: "credentials-in-prompt"`, `supportsMaxTurns: false`,
`supportsToolsetDisable: false`, `supportsVideo: false`, `blocksEventLoop: true`.
What each field changes is in
[Adapters](../reference/adapters.md). Two are easy to get wrong:

- Declare `blocksEventLoop: false` only if your `run` leaves this process's
  event loop free while the agent browses. It is what enables live request
  interception; a blocking adapter that claims it deadlocks the browser.
- Declare `auth: "self-prelogin"` only if your adapter drives its own persistent
  browser, and export `prelogin({ loginUrl, email, password })` alongside it.

Export `resolveModel()` to have the model recorded as `agentMeta.model`:

```js
export function resolveModel() {
  return process.env.MY_AGENT_MODEL?.trim() || null;
}
```

### 4. Load it before use

A module adapter must be imported before `runAgent` can reach it. Every entry
script already does this, so nothing is needed for normal CLI use. If you call
`runAgent` yourself, `await prepareAdapter()` first:

```js
import { prepareAdapter, runAgent } from "playwright-spec-for-ai-agent/adapter";

await prepareAdapter();
const result = runAgent(query, maxTurns, options);
```

Skipping it gives:

```
QA_AI_ADAPTER module "./qa-adapters/my-agent.mjs" was never loaded: call prepareAdapter() first.
```

A module that exports no `run` function fails at `prepareAdapter()` with a usage
error naming the specifier.

### Confirm it worked

Run one stage. The judgment carries the adapter and model it actually used,
taken from the adapter rather than the agent's self-reported `source`:

```bash
QA_AI_ADAPTER=./qa-adapters/my-agent.mjs npx playwright-spec-for-ai-agent judge --page=pricing
```

```json
"agentMeta": { "adapter": "./qa-adapters/my-agent.mjs", "model": "stub/model-1", "durationMs": 0 }
```

`doctor` is not a check for this route: it calls `describeAdapter()` without
`prepareAdapter()`, so a module specifier fails its `adapter` check with the
"was never loaded" message above even when the pipeline runs fine. Verify with a
real stage instead.

## Run the contract suite against your adapter

The suite the four built-ins pass is exported from the published package. Point
it at your `run` from your own vitest file:

```ts
// my-adapter.contract.test.ts
import { runAdapterContractSuite } from "playwright-spec-for-ai-agent/scripts/__tests__/agent-runner-contract.test.ts";
import { run } from "./qa-adapters/my-agent.mjs";

runAdapterContractSuite("my-agent", run);
// adapters that never spawn a process:
// runAdapterContractSuite("my-agent", run, { spawns: false });
```

It asserts that the adapter returns parsed JSON when the required keys are
present, throws when they are missing, and writes both the query artifact and
the raw output artifact with `secrets` replaced by `[redacted]`. With
`spawns: true` (the default) it also asserts the process-failure cases: a
non-zero exit throws without leaking secrets, a timeout still leaves the
captured output on disk, and a missing binary is named instead of surfacing a
bare `ENOENT`. Pass `{ setup }` to stub the environment your `run` reads:

```ts
runAdapterContractSuite("my-agent", run, {
  setup: () => vi.stubEnv("MY_AGENT_CMD", "my-agent --json"),
});
```

The suite mocks `node:child_process` `spawnSync`, so the process-failure cases
only apply to adapters that spawn one.

## Undo

Unset `QA_AI_ADAPTER` to fall back to `hermes`, the default. Nothing about a
module adapter is written to the project — it is one environment variable and
one file you own.

## Related

- [Adapters](../reference/adapters.md) — the built-in table, the capability descriptor, and the module contract.
- [Give the judge a signed-in session](./authentication.md) — what `auth` decides for a judge run.
- [Configuration](../reference/configuration.md) — where `QA_AI_ADAPTER` and the other environment variables are read.
