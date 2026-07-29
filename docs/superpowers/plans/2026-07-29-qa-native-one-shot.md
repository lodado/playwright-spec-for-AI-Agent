# QA Native One-Shot (multi-scenario adaptive + read-after-click) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `qa-native execute → judge → report` complete in one shot for a 3-scenario dashboard spec, by (1) allowing same-origin GET/HEAD after a safe interaction in the strict provider, (2) supporting multi-scenario adaptive execution with one sealed manifest, and (3) failing fast with a clear message when the installed Hermes Agent CLI does not speak the required protocol.

**Architecture:** All code changes live in `apps/playwright-spec-for-ai-agent`. The strict provider's route handler gains a read-only allowance after `interactionStarted`. The adaptive path gains a suite runner that loops scenarios over one shared evidence store (checkpoints chain per `runId`, so one sealed manifest). The CLI, run envelope, and judge switch adaptive agent input/outcome from singular to arrays. The Hermes runner gains a protocol probe and a secret-free smoke script. Credentials/keys are operator runbook steps, not code.

**Tech Stack:** Node ESM (`.mjs`), vitest, Playwright chromium, pnpm workspace.

## Global Constraints

- All paths below are relative to `apps/playwright-spec-for-ai-agent/` unless stated otherwise.
- Test command: `cd apps/playwright-spec-for-ai-agent && pnpm test` (vitest). Run a single file with `pnpm vitest run <path>`.
- Never write secrets, cookies, tokens, or query strings into evidence, logs, or docs. Post-interaction request log records **method, origin, pathname only** (no search/hash).
- Incomplete runs must never survive as success evidence: keep the existing `rmSync(runDirectory, …)` on failure in `executeQaNative`.
- `RUN_ENVELOPE_VERSION` becomes `"run-envelope/0.2"` when adaptive envelope hashing changes (Task 4) — old envelopes must fail validation.
- Adaptive multi-scenario is **sequential**, in QA IR declaration order; a scenario failure aborts the run with the failing `scenarioId` in the error message.
- Commit after every green task. Conventional commits (`fix:`, `feat:`, `test:`, `docs:`).

---

### Task 1: Strict provider — allow same-origin GET/HEAD after interaction, log allowed requests

**Files:**

- Modify: `packages/provider-playwright/index.mjs:732-758` (route handler), `packages/provider-playwright/index.mjs:805-818` (INTERACT action log)
- Test: `packages/provider-playwright/__tests__/provider-playwright.test.mjs`

**Interfaces:**

- Consumes: existing `createRuntime` closure state (`interactionStarted`, `interactionPolicyViolation`, `base`).
- Produces: ACTION_LOG artifact JSON gains an `allowedRequests: [{method, origin, path}]` field (bounded). No exported signature changes.

- [ ] **Step 1: Write two failing tests**

In `provider-playwright.test.mjs`, follow the existing pattern (local `node:http` server + `chromium` from `@playwright/test`). The spec source must compile to a scenario with a CLICK step (mirror the click fixtures already in this file for the target/selector shape).

```js
it("allows same-origin GET after a safe click and records it in the action log", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/data")
      return response.end(JSON.stringify({ ok: true }));
    response.setHeader("content-type", "text/html");
    response.end(
      `<!doctype html><button onclick="fetch('/data')">구독 이력 전체보기</button>`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const { qaIr, plan } = compileClickFixture(); // reuse this file's existing click-scenario compile helper
    const execution = await executeWithPlaywright({
      qaIr,
      plan,
      baseUrl,
      runId: "run-read-after-click",
      browserType: chromium,
    });
    expect(execution.outcome.type).toBe("COMPLETED");
    const actionLog = findActionLogArtifact(execution); // existing helper pattern: locate ACTION_LOG artifact, readBlob, JSON.parse
    expect(actionLog.allowedRequests).toContainEqual({
      method: "GET",
      origin: baseUrl,
      path: "/data",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

it("still fails with POLICY_VIOLATION when a click triggers a POST", async () => {
  // same shape, button onclick="fetch('/data',{method:'POST'})"
  // expect execution.outcome.type === "POLICY_VIOLATION"
});
```

Write both tests fully (no helpers left undefined — if `compileClickFixture`/`findActionLogArtifact` don't exist, inline the equivalent code copied from the nearest existing click test in the same file).

- [ ] **Step 2: Run tests, verify both fail**

Run: `pnpm vitest run packages/provider-playwright/__tests__/provider-playwright.test.mjs`
Expected: first test FAILS with outcome `POLICY_VIOLATION` (current behavior aborts the GET); second may already pass — that's fine, keep it as a regression guard.

- [ ] **Step 3: Implement the policy change**

In `createRuntime`, add near the other `let` declarations (line ~708):

```js
const MAX_POST_INTERACTION_REQUESTS = 100;
let postInteractionRequests = [];
```

Extract the shared read-only predicate (used by both branches of the route handler):

```js
function isReadOnlySameOriginRequest(requestUrl, method) {
  return (
    ["GET", "HEAD"].includes(method) &&
    ["http:", "https:"].includes(requestUrl.protocol) &&
    requestUrl.origin === base.origin &&
    !requestUrl.username &&
    !requestUrl.password
  );
}
```

Replace the `if (interactionStarted) { … abort … }` block (lines 741-745) with:

```js
if (interactionStarted) {
  if (isReadOnlySameOriginRequest(requestUrl, request.method())) {
    if (postInteractionRequests.length < MAX_POST_INTERACTION_REQUESTS) {
      postInteractionRequests.push({
        method: request.method(),
        origin: requestUrl.origin,
        path: requestUrl.pathname,
      });
    }
    await route.continue();
    return;
  }
  interactionPolicyViolation = true;
  await route.abort("blockedbyclient");
  return;
}
```

Rewrite the pre-interaction condition at line 746 to use the same predicate (`if (!isReadOnlySameOriginRequest(requestUrl, request.method())) { abort; return; }`). Leave the WebSocket handler unchanged (still closed + violation).

In the INTERACT branch (line ~816), include the log in the ACTION_LOG content and reset per interaction:

```js
const content = boundedText(
  JSON.stringify({
    action: "CLICK",
    target: actionLogTarget(step.target),
    beforeUrl,
    afterUrl,
    status: "SUCCEEDED",
    allowedRequests: postInteractionRequests,
  }),
  ACTION_LOG_LIMIT,
  "ACTION_LOG",
);
postInteractionRequests = [];
```

Note the click waits are unchanged; requests that land after the action log is written are simply allowed but attributed to the next interaction's log — acceptable, document nothing.

- [ ] **Step 4: Run the provider test file, verify green**

Run: `pnpm vitest run packages/provider-playwright/__tests__/provider-playwright.test.mjs`
Expected: PASS, including all pre-existing tests (some existing tests may assert the old "abort everything after interaction" behavior — update those assertions to the new policy: same-origin GET/HEAD allowed, everything else violation).

- [ ] **Step 5: Commit**

```bash
git add apps/playwright-spec-for-ai-agent/packages/provider-playwright
git commit -m "fix: allow same-origin GET/HEAD after safe interaction in strict provider"
```

---

### Task 2: Adaptive gateway — accept a shared evidence store

**Files:**

- Modify: `packages/provider-playwright/index.mjs:103-121` (`openPlaywrightBrowserToolGateway`), `packages/provider-playwright/index.mjs:589-602` (`runAdaptiveWithPlaywright`)
- Test: `packages/provider-playwright/__tests__/playwright-browser-tool-gateway.test.mjs`

**Interfaces:**

- Produces: both functions accept optional `store` (an object from `createInMemoryEvidenceStore`) and optional `priorManifest`. Default behavior unchanged when omitted. `appendCheckpoint` in `packages/evidence/index.mjs` already chains checkpoints per `runId` (`[...(current?.checkpoints ?? []), checkpoint]`) — no evidence-package change needed.

- [ ] **Step 1: Write the failing test**

```js
it("chains checkpoints from two gateway sessions into one manifest via a shared store", async () => {
  const store = createInMemoryEvidenceStore({
    providerCapabilities: playwrightBrowserToolCapabilities(),
    producer: { name: "gateway-test", version: "0.0.0" },
    secrets: [],
  });
  // open gateway #1 with input for scenario A (runId "run-shared"), execute one observe_dom, close.
  // open gateway #2 with input for scenario B (same runId), pass { store, priorManifest: manifestFromGateway1 }, execute one observe_dom.
  // expect final manifest.checkpoints.length === 2 and manifest.runId === "run-shared"
});
```

Copy the gateway-open/execute boilerplate from an existing test in the same file (local http server, chromium, scripted proposal objects) so the test is fully concrete.

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm vitest run packages/provider-playwright/__tests__/playwright-browser-tool-gateway.test.mjs`
Expected: FAIL — `store` param is ignored today, second manifest has 1 checkpoint.

- [ ] **Step 3: Implement**

In `openPlaywrightBrowserToolGateway`, add `store: sharedStore` and `priorManifest` to the options object. Replace line 121:

```js
const store =
  sharedStore ??
  createInMemoryEvidenceStore({
    providerCapabilities: capabilities,
    producer: { name: GATEWAY_PROVIDER_ID, version: GATEWAY_PROVIDER_VERSION },
    secrets,
  });
```

Initialize the gateway-local `manifest` (currently declared `let manifest;` near line 172) from `priorManifest`:

```js
let manifest = priorManifest;
```

(The existing append call `store.appendCheckpoint(bundle, { stage: "execute", ...(manifest === undefined ? {} : { manifest }) })` then validates the chain against store state — no change needed there.)

In `runAdaptiveWithPlaywright`, accept `store` and `priorManifest` in its options and forward both to `openPlaywrightBrowserToolGateway`.

- [ ] **Step 4: Run gateway tests, verify green**

Run: `pnpm vitest run packages/provider-playwright/__tests__/playwright-browser-tool-gateway.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/playwright-spec-for-ai-agent/packages/provider-playwright
git commit -m "feat: adaptive gateway accepts shared evidence store and prior manifest"
```

---

### Task 3: Provider — `runAdaptiveSuiteWithPlaywright` (sequential multi-scenario, one sealed manifest)

**Files:**

- Modify: `packages/provider-playwright/index.mjs` (new export next to `runAdaptiveWithPlaywright`)
- Test: `packages/provider-playwright/__tests__/adaptive-playwright-runner.test.mjs`

**Interfaces:**

- Consumes: `runAdaptiveWithPlaywright({ input, proposeAction, store, priorManifest, … })` from Task 2; `createInMemoryEvidenceStore` from `../evidence/index.mjs`; `playwrightBrowserToolCapabilities()`.
- Produces: `runAdaptiveSuiteWithPlaywright({ inputs, proposeAction, browserName, browserType, viewport, secrets, storageStatePath, authBootstrap, now, clock })` returning a frozen `{ outcome, bundles, manifest, readBlob, executions }` where `executions` is `[{ scenarioId, input, outcome, bundleIds }]` in execution order. The aggregate object must be registered in the module-level `adaptiveExecutions` WeakSet so `assertPlaywrightAdaptiveExecution` accepts it.

- [ ] **Step 1: Write the failing tests**

In `adaptive-playwright-runner.test.mjs` (reuse its server/proposer boilerplate):

```js
it("runs three scenarios sequentially into one sealed manifest", async () => {
  // three ExecutionAgentInputs, same runId "run-suite", scenario ids s1/s2/s3
  // scripted proposeAction: observe_dom per scenario until each completes (copy the existing single-scenario scripted proposer)
  const suite = await runAdaptiveSuiteWithPlaywright({
    inputs,
    proposeAction,
    browserType: chromium,
  });
  expect(suite.outcome.type).toBe("COMPLETED");
  expect(suite.executions.map((e) => e.scenarioId)).toEqual(["s1", "s2", "s3"]);
  expect(suite.manifest.checkpoints.length).toBe(suite.bundles.length);
  expect(new Set(suite.bundles.map((b) => b.runId)).size).toBe(1);
  expect(() => assertPlaywrightAdaptiveExecution(suite)).not.toThrow();
});

it("aborts on the failing scenario and names it", async () => {
  // proposer that throws for s2
  await expect(
    runAdaptiveSuiteWithPlaywright({
      inputs,
      proposeAction: failingOnS2,
      browserType: chromium,
    }),
  ).rejects.toThrow(/s2/);
});
```

- [ ] **Step 2: Run, verify both fail**

Run: `pnpm vitest run packages/provider-playwright/__tests__/adaptive-playwright-runner.test.mjs`
Expected: FAIL with `runAdaptiveSuiteWithPlaywright is not a function`.

- [ ] **Step 3: Implement**

```js
export async function runAdaptiveSuiteWithPlaywright({
  inputs,
  proposeAction,
  ...options
} = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0)
    throw new Error("adaptive suite requires at least one scenario input");
  const runIds = new Set(inputs.map((input) => input?.runId));
  if (runIds.size !== 1)
    throw new Error("adaptive suite inputs must share one runId");
  const store = createInMemoryEvidenceStore({
    providerCapabilities: playwrightBrowserToolCapabilities(),
    producer: { name: GATEWAY_PROVIDER_ID, version: GATEWAY_PROVIDER_VERSION },
    secrets: options.secrets ?? [],
  });
  const bundles = [];
  const executions = [];
  let manifest;
  for (const input of inputs) {
    let execution;
    try {
      execution = await runAdaptiveWithPlaywright({
        input,
        proposeAction,
        store,
        priorManifest: manifest,
        ...options,
      });
    } catch (error) {
      throw new Error(
        `adaptive scenario ${input.scenarioId} failed: ${error.message}`,
        { cause: error },
      );
    }
    if (execution.outcome.type !== "COMPLETED")
      throw new Error(`adaptive scenario ${input.scenarioId} did not complete`);
    bundles.push(...execution.bundles);
    manifest = execution.manifest;
    executions.push(
      Object.freeze({
        scenarioId: input.scenarioId,
        input,
        outcome: execution.outcome,
        bundleIds: Object.freeze(
          execution.bundles.map((bundle) => bundle.bundleId),
        ),
      }),
    );
  }
  const suite = Object.freeze({
    outcome: executions[executions.length - 1].outcome,
    bundles: Object.freeze(bundles),
    manifest,
    readBlob: store.readBlob,
    executions: Object.freeze(executions),
  });
  adaptiveExecutions.add(suite);
  return suite;
}
```

Note: `runAdaptiveWithPlaywright` currently takes `proposeAction` per call — pass the same function; the proposer receives `input.scenarioId` in its `ExecutionAgentInput`, so one Hermes proposer serves all scenarios.

- [ ] **Step 4: Run, verify green**

Run: `pnpm vitest run packages/provider-playwright/__tests__/adaptive-playwright-runner.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/playwright-spec-for-ai-agent/packages/provider-playwright
git commit -m "feat: sequential multi-scenario adaptive suite runner with one sealed manifest"
```

---

### Task 4: CLI execute + run envelope — multi-scenario adaptive artifacts

**Files:**

- Modify: `packages/cli/qa-native-execute.mjs:39-48,66-81`, `packages/cli/qa-native-run-envelope.mjs:29-53`, `packages/contracts/index.mjs:15` (version bump only)
- Test: `packages/cli/__tests__/qa-native-execute.test.mjs`

**Interfaces:**

- Consumes: `runAdaptiveSuiteWithPlaywright` (Task 3), `createAdaptiveExecutionInput` (unchanged, called per scenario), `validateAdaptiveExecutionEvidence` (called per scenario with that scenario's bundles).
- Produces: run directory files `execution-agent-inputs.json` and `execution-agent-outcomes.json` (JSON **arrays**, execution order; the old singular files are gone). Envelope adaptive bindings become `executionAgentInputsHash` / `executionAgentOutcomesHash` = `exactHash(arrayOfContracts)`. `RUN_ENVELOPE_VERSION = "run-envelope/0.2"`.

- [ ] **Step 1: Update/extend the failing tests**

In `qa-native-execute.test.mjs`:

- Change the existing adaptive persistence test (line ~98) to a **three-test spec source** (three `test(...)` blocks under one describe, each readonly) and assert:

```js
const inputs = JSON.parse(
  readFileSync(join(runDirectory, "execution-agent-inputs.json"), "utf8"),
);
const outcomes = JSON.parse(
  readFileSync(join(runDirectory, "execution-agent-outcomes.json"), "utf8"),
);
expect(inputs).toHaveLength(3);
expect(outcomes).toHaveLength(3);
inputs.forEach((input) => validateContract("ExecutionAgentInput", input));
outcomes.forEach((outcome, index) =>
  validateContract("ExecutionAgentOutcome", outcome, { input: inputs[index] }),
);
expect(existsSync(join(runDirectory, "execution-agent-input.json"))).toBe(
  false,
);
const replay = readEvidenceArchive({
  directory: join(runDirectory, "evidence"),
  integrityKey,
});
expect(new Set(replay.bundles.map((b) => b.scenarioId)).size).toBe(3);
```

The `executeAdaptive` override in this test becomes `(options) => runAdaptiveSuiteWithPlaywright({ ...options, browserType: chromium })`.

- Add a failure-cleanup test: proposer throws on the second scenario → `runQaNative` returns non-zero, run directory does not exist.

- [ ] **Step 2: Run, verify failures**

Run: `pnpm vitest run packages/cli/__tests__/qa-native-execute.test.mjs`
Expected: FAIL — current code throws `adaptive execution currently requires exactly one scenario`.

- [ ] **Step 3: Implement the CLI adaptive branch**

Replace `qa-native-execute.mjs:39-48` with:

```js
if (provider === "hermes" && mode === "adaptive") {
  const scenarios = qaIr.suites.flatMap((suite) => suite.scenarios);
  if (scenarios.length === 0)
    throw new Error("adaptive execution requires at least one scenario");
  const runId = basename(runDirectory);
  const inputs = scenarios.map((scenario) =>
    createAdaptiveInput({
      qaIr,
      scenarioId: scenario.id,
      baseUrl,
      runId,
      ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
      ...(allowExternalRead === true ? { allowExternalRead: true } : {}),
    }),
  );
  execution = await executeAdaptive({
    inputs,
    proposeAction: createProposer(),
    storageStatePath,
    authBootstrap,
  });
  assertPlaywrightAdaptiveExecution(execution);
  agentInputs = execution.executions.map((entry) => entry.input);
  agentOutcomes = execution.executions.map((entry, index) => {
    const outcome = validateContract("ExecutionAgentOutcome", entry.outcome, {
      input: agentInputs[index],
    });
    if (outcome.type !== "COMPLETED")
      throw new Error(`adaptive scenario ${entry.scenarioId} failed`);
    return outcome;
  });
  execution.executions.forEach((entry, index) =>
    validateAdaptiveExecutionEvidence({
      input: agentInputs[index],
      bundles: execution.bundles.filter((bundle) =>
        entry.bundleIds.includes(bundle.bundleId),
      ),
      manifest: execution.manifest,
      readBlob: execution.readBlob,
      outcome: agentOutcomes[index],
    }),
  );
  runtimeOutcome = validateContract("RuntimeOutcome", {
    schemaVersion: RUNTIME_OUTCOME_VERSION,
    stage: "execute",
    type: "COMPLETED",
  });
}
```

(Rename the `let agentInput/agentOutcome` declarations to `agentInputs`/`agentOutcomes`; update the executor import from `runAdaptiveWithPlaywright` to `runAdaptiveSuiteWithPlaywright` as the `executeAdaptive` default. Check `validateAdaptiveExecutionEvidence`'s exact parameter shape in `qa-native-adaptive-evidence.mjs` before wiring — pass per-scenario bundles; if it validates manifest coverage strictly per scenario, extend it to accept checkpoints that belong to other scenarios of the same run.)

Persistence (lines 66-69) becomes:

```js
if (agentInputs !== undefined) {
  writePrivateJsonExclusive(
    relative(cwd, join(runDirectory, "execution-agent-inputs.json")),
    agentInputs,
    { cwd },
  );
  writePrivateJsonExclusive(
    relative(cwd, join(runDirectory, "execution-agent-outcomes.json")),
    agentOutcomes,
    { cwd },
  );
}
```

Envelope call (line 80): `...(mode === "strict" ? { executionPlan } : { executionAgentInputs: agentInputs, executionAgentOutcomes: agentOutcomes })`.

- [ ] **Step 4: Implement the envelope change**

In `packages/contracts/index.mjs:15`: `export const RUN_ENVELOPE_VERSION = "run-envelope/0.2";` and in `validateRunEnvelope` rename the two adaptive keys to `executionAgentInputsHash` / `executionAgentOutcomesHash` (both allowed-keys arrays and the hash list).

In `qa-native-run-envelope.mjs`, replace the adaptive branch of `runEnvelopeBody`:

```js
if (mode === "adaptive") {
  if (
    !Array.isArray(executionAgentInputs) ||
    executionAgentInputs.length === 0 ||
    !Array.isArray(executionAgentOutcomes) ||
    executionAgentOutcomes.length !== executionAgentInputs.length
  )
    throw new Error("run envelope input is invalid");
  executionAgentInputs.forEach((input, index) => {
    validateContract("ExecutionAgentInput", input);
    validateContract("ExecutionAgentOutcome", executionAgentOutcomes[index], {
      input,
    });
    if (input.runId !== runId || executionAgentOutcomes[index].runId !== runId)
      throw new Error("run envelope input is invalid");
  });
  return {
    ...common,
    executionAgentInputsHash: exactHash(executionAgentInputs),
    executionAgentOutcomesHash: exactHash(executionAgentOutcomes),
  };
}
```

(Destructure `executionAgentInputs`/`executionAgentOutcomes` in the function signature, dropping the singular names.)

- [ ] **Step 5: Run CLI execute tests, verify green**

Run: `pnpm vitest run packages/cli/__tests__/qa-native-execute.test.mjs`
Expected: PASS (strict tests untouched and still green).

- [ ] **Step 6: Commit**

```bash
git add apps/playwright-spec-for-ai-agent/packages/cli apps/playwright-spec-for-ai-agent/packages/contracts
git commit -m "feat: multi-scenario adaptive execution artifacts and run envelope v0.2"
```

---

### Task 5: Judge — consume multi-scenario adaptive runs

**Files:**

- Modify: `packages/cli/qa-native-judge.mjs:18-35`
- Test: `packages/cli/__tests__/qa-native-judge.test.mjs`

**Interfaces:**

- Consumes: `execution-agent-inputs.json` / `execution-agent-outcomes.json` arrays and envelope bindings from Task 4.
- Produces: unchanged judge results per bundle; adaptive validation now runs per scenario.

- [ ] **Step 1: Extend the failing test**

In `qa-native-judge.test.mjs`, build an adaptive run directory fixture with 3 scenarios (reuse the execute path from Task 4's test to produce it — run `execute` with the suite override, then run `judge`). Assert: judge exits 0, produces one judge-result per final bundle per scenario, and rejects a run directory whose `execution-agent-inputs.json` is missing a scenario (tamper by rewriting the file → envelope binding failure expected).

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm vitest run packages/cli/__tests__/qa-native-judge.test.mjs`
Expected: FAIL — judge still reads singular `execution-agent-input.json`.

- [ ] **Step 3: Implement**

Replace lines 22-31 of `qa-native-judge.mjs` with:

```js
const agentInputs = readPrivateJson(
  relative(cwd, join(runDirectory, "execution-agent-inputs.json")),
  { cwd },
);
const agentOutcomes = readPrivateJson(
  relative(cwd, join(runDirectory, "execution-agent-outcomes.json")),
  { cwd },
);
if (
  !Array.isArray(agentInputs) ||
  !Array.isArray(agentOutcomes) ||
  agentInputs.length !== agentOutcomes.length ||
  agentInputs.length === 0
)
  throw new Error("adaptive execution artifacts are invalid");
agentInputs.forEach((agentInput, index) => {
  validateContract("ExecutionAgentInput", agentInput);
  const agentOutcome = validateContract(
    "ExecutionAgentOutcome",
    agentOutcomes[index],
    { input: agentInput },
  );
  if (agentOutcome.type !== "COMPLETED")
    throw new Error("adaptive execution is incomplete");
  if (agentInput.runId !== archive.manifest.runId)
    throw new Error("adaptive execution does not match evidence");
});
verifyRunEnvelopeBindings({
  envelope,
  runId: envelope.runId,
  mode: "adaptive",
  qaIr,
  runtimeOutcome,
  evidenceManifest: archive.manifest,
  executionAgentInputs: agentInputs,
  executionAgentOutcomes: agentOutcomes,
});
agentInputs.forEach((agentInput, index) => {
  const scenarioBundles = archive.bundles.filter(
    (bundle) => bundle.scenarioId === agentInput.scenarioId,
  );
  validateAdaptiveExecutionEvidence({
    input: agentInput,
    outcome: agentOutcomes[index],
    bundles: scenarioBundles,
    manifest: archive.manifest,
    readBlob: archive.readBlob,
  });
});
```

Keep the final-bundle selection (line 30) but resolve it per scenario (final bundle = last bundle whose `scenarioId` matches).

- [ ] **Step 4: Run judge + full CLI tests, verify green**

Run: `pnpm vitest run packages/cli`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/playwright-spec-for-ai-agent/packages/cli
git commit -m "fix: judge validates multi-scenario adaptive evidence per scenario"
```

---

### Task 6: One-shot integration test — 3 scenarios, execute → judge → report

**Files:**

- Test: `packages/cli/__tests__/qa-native.test.mjs` (or a new `qa-native-one-shot.test.mjs` beside it)

**Interfaces:**

- Consumes: everything above via `runQaNative` handlers, `runAdaptiveSuiteWithPlaywright` with `browserType: chromium`, scripted proposer.

- [ ] **Step 1: Write the test**

One test that, against a local http server and a 3-test spec source: runs `execute --provider=hermes --mode=adaptive`, then `judge`, then `report`, asserting exit 0 at every stage, three scenarios present in the report input, and a sealed archive that `readEvidenceArchive` verifies with the integrity key. Reuse the CLI invocation patterns from `qa-native-execute.test.mjs` and the judge/report invocation patterns from their own test files (copy the argument lists verbatim, adjust `--run-dir`).

- [ ] **Step 2: Run, verify green (this is a verification task — it should pass if Tasks 1-5 are correct)**

Run: `pnpm vitest run packages/cli`
Expected: PASS. If it fails, the failure names the broken layer — fix there, not in the test.

- [ ] **Step 3: Run the whole suite**

Run: `pnpm test` (in `apps/playwright-spec-for-ai-agent`)
Expected: PASS, no skips added by this work.

- [ ] **Step 4: Commit**

```bash
git add apps/playwright-spec-for-ai-agent/packages/cli/__tests__
git commit -m "test: one-shot execute-judge-report integration for three adaptive scenarios"
```

---

### Task 7: Hermes runner — protocol probe + secret-free smoke script

**Files:**

- Modify: `scripts/hermes-runner.mjs` (new exported probe, called from `runHermes`)
- Create: `scripts/hermes-runner-smoke.mjs`
- Test: `scripts/__tests__/hermes-runner.test.mjs` (extend; the file exists under `scripts/__tests__/`)

**Interfaces:**

- Produces: `assertHermesRunnerProtocol(helpText)` (pure, throws on missing `--query`/`--max_turns`) and `probeHermesRunnerProtocol({ spawn })` (spawns `<invocation> --help`, feeds the combined output to the pure function, caches success per process). `runHermes` calls the probe before building args.

- [ ] **Step 1: Write failing unit tests (pure function — no spawning)**

```js
it("accepts help text that documents --query and --max_turns", () => {
  expect(() =>
    assertHermesRunnerProtocol(
      "usage: hermes-agent --query=Q --max_turns=N --model=M",
    ),
  ).not.toThrow();
});
it("rejects help text without the legacy flags and names the fix", () => {
  expect(() =>
    assertHermesRunnerProtocol("usage: hermes run <task.json>"),
  ).toThrow(/hermes-agent CLI does not support --query\/--max_turns/);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run scripts/__tests__/hermes-runner.test.mjs`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement**

```js
let hermesProtocolVerified = false;

export function assertHermesRunnerProtocol(helpText) {
  if (!/--query\b/.test(helpText) || !/--max_turns\b/.test(helpText)) {
    throw new Error(
      "hermes-agent CLI does not support --query/--max_turns. Install the pinned compatible Hermes Agent version (see docs/qa-native-one-shot-runbook.md) or update scripts/hermes-runner.mjs to the new CLI contract.",
    );
  }
}

export function probeHermesRunnerProtocol({ spawn = spawnSync } = {}) {
  if (hermesProtocolVerified) return;
  const invocation = resolveHermesAgentInvocation();
  const result = spawn(invocation.command, [...invocation.baseArgs, "--help"], {
    shell: false,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  assertHermesRunnerProtocol(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  hermesProtocolVerified = true;
}
```

Call `probeHermesRunnerProtocol()` at the top of `runHermes` (after the `HERMES_QA_COMMAND` guard). Help output is not written anywhere (no secret risk; still, never echo it).

`scripts/hermes-runner-smoke.mjs` (runnable via `node scripts/hermes-runner-smoke.mjs`):

```js
import { probeHermesRunnerProtocol, runHermes } from "./hermes-runner.mjs";

probeHermesRunnerProtocol();
const result = runHermes(
  'Return exactly this JSON and nothing else: {"status":"ok"}',
  1,
  { mode: "text-only", requiredKeys: ["status"], timeoutMs: 120_000 },
);
if (result.status !== "ok")
  throw new Error("Hermes smoke response did not validate");
console.log("PASS: hermes-agent protocol + inference credential OK");
```

Failure prints the thrown message only — `runHermes` already redacts secrets in errors; the smoke script must not add any output of its own on failure. This one script covers both the runner-contract gate and the credential gate (a 403 surfaces as the existing redacted `Hermes API key was rejected or permission denied.` error).

- [ ] **Step 4: Run tests, verify green**

Run: `pnpm vitest run scripts/__tests__/hermes-runner.test.mjs`
Expected: PASS. (Do **not** run the smoke script in CI/tests — it spends inference and needs operator credentials.)

- [ ] **Step 5: Commit**

```bash
git add apps/playwright-spec-for-ai-agent/scripts
git commit -m "feat: hermes runner protocol probe and secret-free smoke script"
```

---

### Task 8: Operator runbook — credentials, keys, one-shot sequence

**Files:**

- Create: `docs/qa-native-one-shot-runbook.md` (repo root `docs/`)

No code, no tests. Content, in order:

- [ ] **Step 1: Write the runbook**

1. **Hermes Agent version**: install the Hermes Agent version whose CLI documents `--query`/`--max_turns` (verify with `node apps/playwright-spec-for-ai-agent/scripts/hermes-runner-smoke.mjs` — it must print `PASS`). Symlinks/aliases are not a fix; the probe checks the actual CLI surface.
2. **Credentials**: restore the inference provider credential via the secret manager / Hermes auth flow into `~/.hermes` (operator machine only). Never place credentials in source, argv, QA artifacts, or reports. Confirm with the same smoke script (it emits no secrets).
3. **Keys**: store `QA_NATIVE_INTEGRITY_KEY` and `QA_NATIVE_PUBLICATION_KEY` (base64, ≥32 bytes) in CI/secret manager. Local ad-hoc runs may generate a session integrity key; never publish without the stable publication key.
4. **One-shot sequence** (base URL must include the locale segment — `@qa-page: dashboard` resolves relative to it):

```bash
export STAGING_QA_BASE_URL='https://agent-dev.koreadeep.com/ko/'
export QA_NATIVE_RUN_DIR=".qa/runs/one-shot-dashboard-$(date +%Y%m%d-%H%M%S)"

pnpm exec qa-native execute \
  --spec=src/page/dashboard/__tests__/dashboard.qa-native.ts \
  --base-url="$STAGING_QA_BASE_URL" \
  --run-dir="$QA_NATIVE_RUN_DIR" \
  --storage-state=.private/staging-qa.storage.json \
  --provider=hermes \
  --mode=adaptive
pnpm exec qa-native judge --run-dir="$QA_NATIVE_RUN_DIR"
pnpm exec qa-native report --run-dir="$QA_NATIVE_RUN_DIR" --repository-root=. --revision=HEAD
```

5. **Verdict handling**: `MANUAL_REVIEW` is a valid terminal state — never coerce to PASS/FAIL. Remediation/publication only after reviewing evidence, judgment, and report, and only for FAIL/MANUAL_REVIEW with successful verification.

- [ ] **Step 2: Commit**

```bash
git add docs/qa-native-one-shot-runbook.md
git commit -m "docs: qa-native one-shot operator runbook"
```

---

## Verification checklist (maps to the incident report's exit criteria)

- Dashboard spec compiles to 3 scenarios → covered by Task 4/6 tests (3-test spec source).
- Adaptive runs all declared scenarios into one sealed manifest → Tasks 3, 4, 6.
- GET allowed / POST blocked after interaction, logged in evidence → Task 1.
- Hermes runner JSON proposal smoke test → Task 7 (script; operator-run).
- Full `pnpm test` green → Task 6 Step 3.
- Staging execute → judge → report in a fresh `.qa/runs/one-shot-*` → Task 8 (operator, after credentials).
- No secrets in artifacts/reports → global constraint, enforced by existing redaction plus Task 1's path-only request log.
