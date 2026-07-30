# Non-Deterministic Reasoning in the Execution Path (v2.2.0 feedback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move AI reasoning from the judge-only layer into expectation definition, adaptive execution, and milestone handling, so mock-bound / unreachable / timing-dependent expectations produce judged evidence instead of literal-mismatch FAILs, budget-exhaustion crashes, and deleted evidence.

**Architecture:** Keep the security invariants (agent never self-certifies; runtime owns verdicts). Add: (1) evidence is always sealed, failures become recorded outcomes, not throws; (2) `@qa-live-policy: mock-judgment` scenarios route to observe-only milestones + a `SEMANTIC` judge hint; (3) a `report_blocked` terminal action that seals evidence and lets the judge verify the claim; (4) real visibility waits and configurable budgets.

**Tech Stack:** Node 20 `.mjs`, vitest, Playwright 1.60, Hermes CLI transport. All work in `apps/playwright-spec-for-ai-agent/packages/*`.

## Global Constraints

- Test gate (per CLAUDE.md): `cd apps/playwright-spec-for-ai-agent && pnpm test` — run and report actual output before claiming done.
- Every PR needs a changeset for `playwright-spec-for-ai-agent` (these are `minor` — new capability; Task 6's contract additions are still `minor` because the CLI surface is the public API).
- Security invariants preserved: agent proposals never carry verdicts; `report_blocked` is a _claim_ the judge verifies against sealed evidence; prompt-injection defenses (redaction, untrusted-data framing) unchanged.
- Contract discipline: any contract whose allowed keys change bumps its version string (e.g. `execution-action-proposal/0.1` → `/0.2`) and its validator in `packages/contracts/index.mjs`.
- Priority order (from feedback §5): Task 1–2 (G3) → Task 3–5 (G1) → Task 6 (G2) → Task 7 (§3-1) → Task 8–10 (§3-2/3/4). Tasks 1–10 are independent diffs; G4 is a follow-up plan.

**Scope check:** G4 (GWT abstraction port) is a separate subsystem with its own schema work. It gets its own plan once Tasks 1–10 land (see "Follow-up" at the end). This plan delivers working software without it.

---

### Task 1: G3a — adaptive scenario failure becomes a recorded outcome, evidence survives

**Files:**

- Modify: `packages/provider-playwright/index.mjs:588-652` (`runAdaptiveWithPlaywright`, `runAdaptiveSuiteWithPlaywright`)
- Modify: `packages/core/index.mjs:107-121` (budget-exhaustion detection helper)
- Test: `packages/provider-playwright/__tests__/adaptive-playwright-runner.test.mjs`

**Interfaces:**

- Produces: `runAdaptiveSuiteWithPlaywright` no longer throws when one scenario fails or exhausts budget. Each `executions[]` entry keeps `{scenarioId, input, outcome, bundleIds}` where `outcome.type` may now be `"ERROR"` with `reason` starting `"BUDGET_EXHAUSTED"` or the failure message. Bundles collected before the failure stay in `suite.bundles`.
- Consumes: existing `ExecutionAgentOutcome` contract — `type: "ERROR" | "BLOCKED"` + `reason` already validated (`packages/contracts/index.mjs:520-544`); no contract change.

- [ ] **Step 1: Write the failing test** — in `adaptive-playwright-runner.test.mjs`, drive a two-scenario suite where scenario 1's proposer loops `observe_dom` until the actions budget dies and scenario 2 completes. Assert: no throw; `executions[0].outcome.type === "ERROR"` with `reason` matching `/^BUDGET_EXHAUSTED/`; `executions[1].outcome.type === "COMPLETED"`; `suite.bundles` includes scenario 1's pre-failure bundles.
- [ ] **Step 2: Run it** — `pnpm vitest run packages/provider-playwright/__tests__/adaptive-playwright-runner.test.mjs`. Expected: FAIL (current code throws `adaptive scenario ... failed`).
- [ ] **Step 3: Implement.** In `runAdaptiveWithPlaywright`, pre-check before each propose: if any of `proposerInput.remainingBudget.{actions,turns,timeMs,tokens} < 1`, synthesize outcome instead of letting `authorize` throw:

```js
if (Object.values(proposerInput.remainingBudget).some((value) => value < 1)) {
  outcome = snapshotContract("ExecutionAgentOutcome", {
    schemaVersion: EXECUTION_AGENT_OUTCOME_VERSION,
    runId: input.runId, scenarioId: input.scenarioId, type: "ERROR",
    completedMilestoneIds: completedMilestoneIds(proposerInput),
    reason: `BUDGET_EXHAUSTED: ${budgetSummary(input.remainingBudget, proposerInput.remainingBudget)}`,
  });
  break;
}
```

`budgetSummary` prints consumed/initial per dimension (feeds Task 2's per-scenario report). In `runAdaptiveSuiteWithPlaywright:637-648`, replace the throw-on-error / throw-on-non-COMPLETED with: catch → synthesize an `ERROR` outcome carrying `error.message` as `reason`; always push whatever bundles the scenario produced; continue to the next scenario. Suite-level `outcome` = last execution's outcome (unchanged shape).

- [ ] **Step 4: Run tests** — same command. Expected: PASS. Then full gate: `pnpm test`.
- [ ] **Step 5: Commit** — `feat: record adaptive scenario failures as outcomes and keep partial evidence`

---

### Task 2: G3b — CLI `execute` seals partial evidence and reports per-scenario consumption

**Files:**

- Modify: `packages/cli/qa-native-execute.mjs:43-103` (adaptive branch, `rmSync` catch, summary)
- Modify: `packages/cli/qa-native-judge.mjs:28` (accept non-COMPLETED adaptive outcomes)
- Modify: `packages/cli/qa-native-adaptive-evidence.mjs` (validate evidence for partial outcomes)
- Test: `packages/cli/__tests__/qa-native-execute.test.mjs`, `packages/cli/__tests__/qa-native-judge.test.mjs`

**Interfaces:**

- Consumes: Task 1's non-throwing suite result.
- Produces: `execute` exits `0` with outcomes written even when scenarios ended `ERROR`/`BLOCKED`; `run.json` stays `COMPLETED` (the _runtime_ completed; scenario outcomes carry their own status). Summary line gains per-scenario status + consumption: `qa-native: hermes/adaptive executed 2 scenario(s), 1 budget-exhausted → .qa/runs/x` plus one stderr line per non-completed scenario with turns/seconds/tokens consumed. `judge` judges every scenario bundle, including failed ones.

- [ ] **Step 1: Failing tests.** (a) execute test: stub `executeAdaptive` returning one COMPLETED + one ERROR(BUDGET_EXHAUSTED) execution; assert exit 0, `execution-agent-outcomes.json` contains both, evidence archive written, run directory NOT deleted, summary mentions `budget-exhausted`. (b) judge test: outcomes file containing an ERROR outcome no longer throws `adaptive execution is incomplete`; judge results produced for the completed scenario and for the failed scenario's sealed bundles.
- [ ] **Step 2: Run** both test files. Expected: FAIL — `qa-native-execute.mjs:52` throws `adaptive scenario ... failed`, `qa-native-judge.mjs:28` throws on non-COMPLETED.
- [ ] **Step 3: Implement.** In `qa-native-execute.mjs:50-54` drop the `outcome.type !== "COMPLETED"` throw — validate the contract, keep the outcome. Skip `validateAdaptiveExecutionEvidence`'s completed-milestone assertions for non-COMPLETED outcomes (pass `outcome` through; inside `qa-native-adaptive-evidence.mjs`, gate milestone-completion checks on `outcome.type === "COMPLETED"` while still verifying bundle integrity/hashes for all). Keep the `rmSync` in the catch — after Task 1 an executed run no longer reaches it; it now only cleans genuine setup failures (compile error, bad spec), which produce no evidence. Extend `defaultReportSummary` with the failed-scenario count and add a `defaultReportScenario` stderr line per non-COMPLETED scenario using the `reason` string from Task 1 (feedback §3-6).
- [ ] **Step 4: Run tests** — both files, then `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat: seal partial adaptive evidence and report per-scenario budget consumption`

---

### Task 3: G1a — carry `@qa-live-policy` judgment intent into the QA IR

**Files:**

- Modify: `packages/adapter-playwright/index.mjs:88-119` (`scenarioFromLegacyTest`), `:56-78` (extensions)
- Modify: `packages/contracts/index.mjs` (QaIrDocument `extensions` validator, alongside `blockedScenarioIds`)
- Test: `packages/adapter-playwright/__tests__/adapter-playwright.test.mjs`

**Interfaces:**

- Produces: `qaIr.extensions.semanticJudgmentScenarioIds: string[]` — ids of scenarios whose `test.liveRunPolicy` starts with `"judgment-"`. Follows the existing `blockedScenarioIds` pattern exactly (adapter writes it, downstream reads it, absent when empty).
- Consumed by: Task 4 (judge hint), Task 5 (observe-only milestones), Task 9 (origin classification).

- [ ] **Step 1: Failing test** — compile a spec with `@qa-live-policy: mock-judgment` (parser maps it to `judgment-mock-api`, `scripts/dashboard-spec-parser.mjs:39`); assert the scenario id appears in `qaIr.extensions.semanticJudgmentScenarioIds` and an `executable-readonly` scenario does not.
- [ ] **Step 2: Run** — expected FAIL (key absent).
- [ ] **Step 3: Implement** — in `scenarioFromLegacyTest`, mirror the `blockedScenarioIds` push: `if (String(test.liveRunPolicy ?? "").startsWith("judgment-")) semanticJudgmentScenarioIds.push(id);` thread the array through `compilePlaywrightSpec` into `extensions` the same way `blockedScenarioIds` is (`adapter-playwright/index.mjs:74-77`). Add the key to the QaIrDocument extensions validator (unique bounded strings, same rule as `blockedScenarioIds`).
- [ ] **Step 4: Run tests** — adapter file, then `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat: record semantic-judgment scenario ids in QA IR extensions`

---

### Task 4: G1b — semantic judge receives `judgment: "SEMANTIC"` and judges structure, not literals

**Files:**

- Modify: `packages/judge/index.mjs:256-291` (`buildSemanticInput`, `copyExpectationForPrompt`)
- Modify: `packages/contracts/index.mjs` (SemanticJudgeInput expectation allowed keys + version bump `semantic-judge-input/0.x`)
- Modify: `packages/provider-hermes/index.mjs:144-155` (`buildHermesJudgeQuery`)
- Test: `packages/judge/__tests__/judge.test.mjs`, `packages/provider-hermes/__tests__/provider-hermes.test.mjs`

**Interfaces:**

- Consumes: `qaIr.extensions.semanticJudgmentScenarioIds` (Task 3).
- Produces: each expectation in `SemanticJudgeInput.expectations` for a semantic-judgment scenario carries `judgment: "SEMANTIC"`; others carry nothing (absent = literal). Hermes prompt gains one instruction line.

- [ ] **Step 1: Failing tests.** (a) judge test: `buildSemanticJudgeInput` with a qaIr whose scenario is listed in `semanticJudgmentScenarioIds` → every routed expectation has `judgment: "SEMANTIC"`; unlisted scenario → key absent. (b) hermes test: `buildHermesJudgeQuery` output contains the semantic-judgment instruction line.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement.** In `buildSemanticInput`, read the set once: `const semantic = new Set(qaIr.extensions?.semanticJudgmentScenarioIds ?? []);` and pass `semantic.has(scenario.id)` into `copyExpectationForPrompt`, which adds `...(isSemantic ? { judgment: "SEMANTIC" } : {})`. Allow the key in the SemanticJudgeInput validator and bump its version. In `buildHermesJudgeQuery` add after the existing instruction lines:

```js
"Expectations marked judgment:\"SEMANTIC\" were authored against mock data. Judge structural equivalence: MATCHED when the evidence shows the same UI structure and message shape with account- or data-dependent values differing (e.g. a different user name or email in the same sentence frame). CONTRADICTED only when the structure or behavior itself differs.",
```

Note the deterministic layer needs no change: a literal mismatch already resolves to `null` → unresolved → routed to the semantic judge (`packages/judge/index.mjs:165-171`); the hint is what flips the feedback's `dev-user` vs `lee@koreadeep.com` case from CONTRADICTED 0.98 to MATCHED.

- [ ] **Step 4: Run tests** — both files, then `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat: route mock-judgment expectations to the semantic judge with a SEMANTIC hint`

---

### Task 5: G1c — adaptive mode treats judgment scenarios as observe-only

**Files:**

- Modify: `packages/core/index.mjs:144-191` (`createAdaptiveExecutionInput`), `:228-281` (`advanceAdaptiveMilestone`)
- Test: `packages/core/__tests__/adaptive-execution.test.mjs`

**Interfaces:**

- Consumes: `qaIr.extensions.semanticJudgmentScenarioIds` (Task 3).
- Produces: for a listed scenario, expectation-derived milestones are replaced by ONE observe-only milestone `{id: "evidence-<scenarioId hash>", class: "REQUIRED_SEMANTIC_MILESTONE", status: "PENDING", description: "Observe the page and collect visible text and ARIA evidence for semantic judgment."}` — no `target`, no `expectation` (both already optional in the contract, `contracts/index.mjs:431-438`). Interaction-step milestones (`REQUIRED_EXACT_ACTION`) are unchanged. An observe-only milestone is satisfied by any accepted, fresh `observe_dom`/`observe_aria`.

- [ ] **Step 1: Failing tests.** (a) `createAdaptiveExecutionInput` for a semantic-judgment scenario with a `CONTAINS_TEXT "dev-user님은…"` expectation: milestones contain no literal-text milestone, exactly one observe-only milestone; the `adaptiveSemanticExpectation` unsupported-kind throw is also skipped for these scenarios. (b) `advanceAdaptiveMilestone` with the observe-only milestone current + an accepted `observe_dom` result + a fresh observation (matching pageId/domGeneration, no `satisfiedMilestoneIds` needed) → milestone COMPLETED / outcome COMPLETED when it was the last required one.
- [ ] **Step 2: Run** — expected FAIL (today the literal milestone is created and a matching element can never exist).
- [ ] **Step 3: Implement.** In `createAdaptiveExecutionInput`: read the semantic set from `qaIr.extensions`; when the scenario is listed, skip the `adaptiveSemanticExpectation` gate and, instead of mapping `scenario.expectations` to milestones, append the single observe-only milestone (id via the existing `canonicalHash` pattern). In `advanceAdaptiveMilestone:238-243`, extend `matchedObservation`:

```js
const observeOnly =
  milestone.target === undefined && milestone.expectation === undefined;
const matchedObservation =
  ["observe_dom", "observe_aria"].includes(proposalSnapshot.action) &&
  observationSnapshot?.pageId === inputSnapshot.currentPage.pageId &&
  observationSnapshot.domGeneration ===
    inputSnapshot.currentPage.domGeneration &&
  (observeOnly
    ? true
    : milestone.expectation === undefined
      ? observationSnapshot.elements.some((element) =>
          element.milestoneIds.includes(milestone.id),
        )
      : observationSnapshot.satisfiedMilestoneIds?.includes(milestone.id) ===
        true);
```

`evaluateSemanticMilestones` (provider) already skips milestones without target/expectation (`provider-playwright/index.mjs:470`), so no provider change. The sealed VISIBLE_TEXT/ARIA evidence plus Task 4's SEMANTIC hint is what the judge rules on — the agent stops hunting for text that cannot exist.

- [ ] **Step 4: Run tests** — core tests, then `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat: observe-only adaptive milestones for mock-judgment scenarios`

---

### Task 6: G2 — `report_blocked` terminal action (claim, sealed, judge-verified)

**Files:**

- Modify: `packages/contracts/index.mjs` (`ADAPTIVE_ACTIONS`, `validateAdaptiveActionParameters`; bump `execution-action-proposal` + `execution-agent-input` versions)
- Modify: `packages/core/index.mjs:107-142` (authorize), `:176-178` (lease actions), `:228-281` (advance)
- Modify: `packages/provider-playwright/index.mjs` (gateway `execute` handling for the new action — seal an observation bundle, accept)
- Modify: `packages/provider-hermes/index.mjs:20-35` (execution prompt vocabulary)
- Test: `packages/contracts/__tests__/adaptive-contracts.test.mjs`, `packages/core/__tests__/adaptive-execution.test.mjs`, `packages/provider-playwright/__tests__/playwright-browser-tool-gateway.test.mjs`

**Interfaces:**

- Produces: action `report_blocked` with `parameters: {milestoneId: string, reason: string (≤4096)}`; always leased. Runtime response: seal a full observation (VISIBLE_TEXT + ARIA, same capture as `observe_dom`), mark the current milestone `status: "BLOCKED"`, advance to the next pending required milestone; when none remain and any milestone is BLOCKED, outcome is `type: "BLOCKED"` with `reason` aggregating the agent's reports and `completedMilestoneIds` listing only genuinely completed ones. The runtime never converts the claim into a verdict — the judge later rules on the sealed evidence (Tasks 2/4 already make judge accept BLOCKED outcomes and judge their bundles).
- Consumes: Tasks 1–2 (non-COMPLETED outcomes flow through execute/judge).

- [ ] **Step 1: Failing tests.** (a) contracts: `report_blocked` proposal with `{milestoneId, reason}` validates; extra keys or missing reason fail. (b) core: `authorize` accepts `report_blocked` for the current milestone regardless of `REQUIRED_EXACT_ACTION` (add to the always-allowed list next to `safeRecoveryActions`), rejects it for a non-current `milestoneId`. `advanceAdaptiveMilestone` (or a new `advanceBlockedMilestone` if cleaner — prefer extending advance) on an accepted `report_blocked`: current milestone → BLOCKED, next required pending selected; last milestone → outcome `type: "BLOCKED"`. (c) gateway: executing `report_blocked` seals a bundle whose artifacts include VISIBLE_TEXT and ARIA_SNAPSHOT.
- [ ] **Step 2: Run** — expected FAIL (`report_blocked` is not in `ADAPTIVE_ACTIONS`).
- [ ] **Step 3: Implement** in the order contracts → core → gateway → prompt. Prompt: extend the action list line at `provider-hermes/index.mjs:29` with `report_blocked uses {milestoneId, reason}` and soften the ban line at `:26` to keep the self-certification invariant while opening the escape hatch:

```
"Do not declare PASS, FAIL, or milestone completion. If the current milestone appears unreachable after genuine attempts, propose report_blocked with {milestoneId, reason}; the runtime seals the current page evidence and an independent judge verifies your reason — it is a claim, not a verdict.",
```

- [ ] **Step 4: Run tests** — three files, then `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat: report_blocked terminal action with sealed evidence and judge verification`

---

### Task 7: §3-1 — real visibility waits in element observation

**Files:**

- Modify: `packages/provider-playwright/index.mjs:985` (`observeExpectations`), `:476` (`evaluateSemanticMilestones`)
- Test: `packages/provider-playwright/__tests__/provider-playwright.test.mjs`

**Interfaces:** none new — `ELEMENT_OBSERVATION.value.visible` simply becomes wait-based.

- [ ] **Step 1: Failing test** — page where the target element starts `opacity: 0` / `visibility: hidden` and becomes visible after 300ms (fixture with a script or CSS animation, following existing fixtures in that test file). Assert observation resolves `visible: true`.
- [ ] **Step 2: Run** — expected FAIL (`isVisible` snapshots immediately; the feedback's framer-motion stagger false alarm).
- [ ] **Step 3: Implement:**

```js
const visible = await locator.waitFor({ state: "visible", timeout }).then(
  () => true,
  () => false,
);
const value = { expectationId: expectation.id, resolution: "FOUND", visible };
```

`timeout` is the per-node timeout already threaded into `observeExpectations`; a hidden element now costs one node-timeout wait instead of a false negative — acceptable, and it removes the self-contradicting evidence (FOUND/visible:false while VISIBLE_TEXT contains the text). Apply the same `.then(() => true, () => false)` pattern at `:476` with a short fixed wait (e.g. `Math.min(timeoutBudgetRemaining, 2000)`) so adaptive semantic checks tolerate mount animations without eating the budget. Carrying the spec's own `expect(...).toBeVisible({ timeout })` into the IR (parser → expectation.timeoutMs → min with node timeout) is a bonus step here if the parser already surfaces the options object; otherwise defer it to the G4 plan — note which you did in the PR.

- [ ] **Step 4: Run tests** — file, then `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** — `fix: wait for visibility instead of instant isVisible snapshot in observations`

---

### Task 8: §3-2 — configurable adaptive budget + exhaustion usage summary

**Files:**

- Modify: `packages/cli/qa-native.mjs:18,31,228` (flag registry, usage, parse types)
- Modify: `packages/cli/qa-native-execute.mjs:16,47` (thread `budget` into `createAdaptiveInput`)
- Test: `packages/cli/__tests__/qa-native-execute.test.mjs`

**Interfaces:**

- Produces: `--budget-actions=N --budget-turns=N --budget-time-ms=N --budget-tokens=N` on `execute`; each overrides its `DEFAULT_ADAPTIVE_BUDGET` field (`core/index.mjs:16`); positive-integer validation at the CLI boundary. The exhaustion usage summary already exists via Task 1's `reason` string + Task 2's stderr line — this task only makes the ceiling configurable.

- [ ] **Step 1: Failing test** — `execute` with `--budget-actions=3`: stub `createAdaptiveInput` capture asserts `budget.actions === 3` and other fields keep defaults; `--budget-actions=0` exits with a validation error.
- [ ] **Step 2: Run** — expected FAIL (unknown flag).
- [ ] **Step 3: Implement** — add the four flags to the `execute` set and `parseArgs` options (string type, parse with the same positive-integer check style used elsewhere in `parseRequest`), build `budget = {...DEFAULT_ADAPTIVE_BUDGET, ...overrides}` in `qa-native-execute.mjs` and pass to `createAdaptiveInput({ ..., budget })`.
- [ ] **Step 4: Run tests** — file, then `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat: --budget-* flags for adaptive execution`

---

### Task 9: §3-3 — mock-judgment failures classify as TEST_DATA origin

**Files:**

- Modify: `packages/remediation/index.mjs:54,696` (`classifyOrigin` and its call site — thread the semantic-judgment flag)
- Test: `packages/remediation/__tests__/remediation.test.mjs`

**Interfaces:**

- Consumes: `qaIr.extensions.semanticJudgmentScenarioIds` (Task 3) — the diagnose input already carries the qaIr/scenario linkage; pass `isSemanticJudgment` down to `classifyOrigin`.
- Produces: a CONTRADICTED expectation in a semantic-judgment scenario yields `origin: "TEST_DATA"` (mapping already exists, `remediation/index.mjs:27`) instead of `PRODUCT_CODE 0.70`; `TEST_DATA` stays Draft-PR-ineligible per the existing gate at `:628`.

- [ ] **Step 1: Failing test** — diagnosis for a contradicted expectation whose scenario is in the semantic set → `origin === "TEST_DATA"`; same failure outside the set → `PRODUCT_CODE` (unchanged).
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** — `classifyOrigin(...)` returns `hasContradiction ? (isSemanticJudgment ? "TEST_DATA" : "PRODUCT_CODE") : "UNKNOWN"`; adjust `diagnosisConfidence`/`likelyCause` tables to cover `TEST_DATA` with a cause string like `"Expectation was authored against mock data; live values differ."`
- [ ] **Step 4: Run tests** — file, then `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** — `fix: classify mock-judgment contradictions as TEST_DATA origin`

---

### Task 10: §3-4 — human-readable verdict summary + `--fail-on` exit codes

**Files:**

- Modify: `packages/cli/qa-native-judge.mjs:44-75` (verdict summary to stdout)
- Modify: `packages/cli/qa-native.mjs` (flag registry: `judge` gains `fail-on`)
- Test: `packages/cli/__tests__/qa-native-judge.test.mjs`

**Interfaces:**

- Produces: after writing judge results, one stdout line per scenario: `qa-native judge: <scenarioId> <VERDICT> (confidence <n>)` and a totals line `verdicts: N pass, N fail, N manual-review`. `--fail-on=fail` → exit 1 if any FAIL; `--fail-on=manual-review` → exit 1 if any FAIL or MANUAL_REVIEW; default unchanged (exit 0, CI keeps current behavior).

- [ ] **Step 1: Failing test** — judge run producing one PASS + one FAIL: stdout contains both verdict lines and the totals; with `--fail-on=fail` return code is 1; without the flag, 0.
- [ ] **Step 2: Run** — expected FAIL (judge is currently silent, no flag).
- [ ] **Step 3: Implement** — accumulate `result.verdict` per bundle in the existing loop, print via an injectable `reportVerdicts` override (same pattern as `defaultReportSummary` in execute), map `--fail-on` to the return value.
- [ ] **Step 4: Run tests** — file, then `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat: judge verdict summary and --fail-on exit codes`

---

## Backlog (explicitly deferred)

- **G4 — GWT abstraction port** (mock literal → structural expectation at compile time; `scripts/expectation-abstractor.mjs` exists as prior art). Separate plan after Tasks 1–10 ship: it changes the IR schema and the adapter contract, and Tasks 3–5 deliver the highest-value slice (policy routing) without it. Feedback confirms routing alone flips the `dev-user` case to PASS.
- **§3-5 LOW** — recommended-locator over-confidence (ROUTE_MATCH): fold into the G4 plan, same code region.

## Self-Review Notes

- Spec coverage: G1→Tasks 3-5, G2→Task 6, G3→Tasks 1-2, §3-1→7, §3-2→8, §3-3→9, §3-4→10, §3-6→Task 2, G4/§3-5→backlog with rationale. Judge acceptance of BLOCKED outcomes is in Task 2 (shared with ERROR handling), which Task 6 depends on — order preserved.
- Type consistency: `semanticJudgmentScenarioIds` (Tasks 3,4,5,9), `judgment: "SEMANTIC"` (Task 4), `report_blocked {milestoneId, reason}` (Task 6), `reason: "BUDGET_EXHAUSTED: …"` (Tasks 1,2,8) used identically throughout.
