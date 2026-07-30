# AGENTS.md — canonical development guide

This file is the canonical guide for working on `apps/playwright-spec-for-ai-agent`.
When CLAUDE.md and this file differ, this file wins. Release/changeset rules stay in CLAUDE.md.

The adaptive execution protocol is spread across six-plus modules. Changing one of them in
isolation compiles fine and fails at runtime — that is exactly how the 2.3.0 regression shipped
(the semantic milestone model landed in core/judge/remediation but not in the evidence validator,
which then rejected the runtime's own output and the failure path deleted the evidence).
§2 is the map of what must move together.

## §1 Architecture map

```text
spec (.spec.ts)
  → scripts/playwright-ast-parser.mjs          TS AST → syntax blocks
  → scripts/dashboard-spec-parser.mjs          @qa-scenario / @qa-live-policy annotations → scenario + policy
  → packages/adapter-playwright/index.mjs      compilePlaywrightSpec → QA IR + diagnostics
                                               + extensions.blockedScenarioIds / semanticJudgmentScenarioIds
  → packages/core/index.mjs                    strict: createExecutionPlan
                                               adaptive: createAdaptiveExecutionInput,
                                               createAdaptiveActionAuthorizer, advanceAdaptiveMilestone,
                                               milestoneCompletionRule, DEFAULT_ADAPTIVE_BUDGET
  → packages/provider-playwright/index.mjs     strict executor + adaptive browser-tool gateway
       ↑ proposals from                        (action switch, audit sealing, origin/network policy)
  packages/provider-hermes/index.mjs           Hermes proposer/judge prompts, EXECUTION_PROMPT_VERSION
  → packages/evidence/index.mjs                sealing, HMAC, redaction, archive read/write
  → packages/cli/qa-native-adaptive-evidence.mjs   evidence integrity validator (execute + judge)
  → packages/judge/index.mjs                   sealed evidence → verdict (semantic branch)
  → packages/remediation/index.mjs             diagnosis, repair recommendation, patch proposals
  → packages/repository-provider/index.mjs     repo snapshot, locateCode
  → packages/reporter-markdown/index.mjs / packages/reporter-github/index.mjs   render / publish

CLI shell: packages/cli/qa-native.mjs (paths, keys, options) + bin entry, with per-command
handlers packages/cli/qa-native-execute.mjs, packages/cli/qa-native-judge.mjs,
packages/cli/qa-native-report.mjs, packages/cli/qa-native-remediate.mjs,
packages/cli/qa-native-publish-issue.mjs, packages/cli/qa-native-propose-patch.mjs.
```

Per-module responsibility, consumers, and change constraints:

| Module                                                                       | Responsibility                                                                                                                                              | Imported by                                                                          | Change constraints                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts/index.mjs`                                               | Every schema; `validateContract` / `snapshotContract` / `canonicalHash`; schema version constants                                                           | practically everything                                                               | Field changes = schemaVersion bump + old-artifact read compatibility + HMAC surface review. Run the "contracts field" matrix row.                                                                                                                                              |
| `packages/core/index.mjs`                                                    | Execution planning; adaptive input/authorizer/milestone transitions; **`milestoneCompletionRule` — the single definition of milestone completion**; budgets | `packages/cli/qa-native-execute.mjs`, `packages/provider-playwright/index.mjs`       | Completion semantics, action vocabulary, or budget shape changes trigger their full matrix rows. The rule is a necessary-condition contract for the validator — never fork it.                                                                                                 |
| `packages/evidence/index.mjs`                                                | In-memory store, archive read/write, `verifyStoredEvidence`, `redactSensitiveText`                                                                          | judge, both providers, remediation, reporters, repository-provider, all CLI commands | Sealing-format changes must keep old runs re-readable and respect the `.invalid` preservation path.                                                                                                                                                                            |
| `packages/adapter-playwright/index.mjs`                                      | Spec compilation → QA IR; diagnostics (`testIndex`); blocked/semantic extensions                                                                            | `packages/cli/qa-native-execute.mjs`                                                 | Policy or diagnostics changes must round-trip with `scripts/dashboard-spec-parser.mjs`. Compilation failures stay fail-closed per scenario.                                                                                                                                    |
| `packages/provider-playwright/index.mjs`                                     | Strict executor and the adaptive browser-tool gateway (action switch, audit sealing, lease enforcement)                                                     | `packages/cli/qa-native-execute.mjs`                                                 | Adding/removing an action = "action vocabulary" matrix row. The startup navigation rewrites the first page URL — coupled to the validator's first-audit baseline. `report_blocked` audits seal a sixth VISIBLE_TEXT artifact — coupled to the validator's artifact-count rule. |
| `packages/provider-hermes/index.mjs`                                         | Hermes proposer/judge/reviewer transports and prompts; `EXECUTION_PROMPT_VERSION`                                                                           | CLI execute/judge/remediate/propose-patch                                            | Any prompt change bumps `EXECUTION_PROMPT_VERSION`. Prompts advise; only the runtime authorizer enforces.                                                                                                                                                                      |
| `packages/judge/index.mjs`                                                   | Sealed evidence → verdict; semantic scenario branch                                                                                                         | `packages/provider-hermes/index.mjs`, `packages/cli/qa-native-judge.mjs`             | Never promote an agent claim to a verdict. `.invalid` runs are unreadable by construction (path guard).                                                                                                                                                                        |
| `packages/cli/qa-native-adaptive-evidence.mjs`                               | Adaptive evidence integrity validator (used by execute and judge)                                                                                           | `packages/cli/qa-native-execute.mjs`, `packages/cli/qa-native-judge.mjs`             | Completion logic lives in core's `milestoneCompletionRule`; this file must not grow its own copy. This was the epicenter of the 2.3.0 regression.                                                                                                                              |
| `packages/cli/qa-native.mjs`                                                 | `resolvePrivateQaPath` (including `.invalid` quarantine), exclusive create/read/write, CLI options/usage                                                    | every CLI handler + bin                                                              | Never loosen path rules. Option changes = "CLI options" matrix row.                                                                                                                                                                                                            |
| `packages/remediation/index.mjs`                                             | `diagnoseFailure` / `recommendRepair` / patch proposals / fingerprints                                                                                      | reporters, CLI report/remediate/propose-patch                                        | New failure origins must reach reporter rendering and the docs tables.                                                                                                                                                                                                         |
| `packages/repository-provider/index.mjs`                                     | Repository snapshot, `locateCode`                                                                                                                           | `packages/cli/qa-native-report.mjs`                                                  | —                                                                                                                                                                                                                                                                              |
| `packages/reporter-markdown/index.mjs`, `packages/reporter-github/index.mjs` | Render reports / publish GitHub issues                                                                                                                      | CLI report / publish-issue                                                           | Published output must never contain secrets or claims-as-verdicts.                                                                                                                                                                                                             |
| `scripts/playwright-ast-parser.mjs`, `scripts/dashboard-spec-parser.mjs`     | AST parsing; annotation/policy extraction                                                                                                                   | `packages/adapter-playwright/index.mjs`                                              | New `@qa-live-policy` values = "policy value" matrix row.                                                                                                                                                                                                                      |
| `scripts/hermes-runner.mjs`, `scripts/hermes-qa-project-config.mjs`          | Hermes CLI invocation and project config                                                                                                                    | provider-hermes, CLI propose-patch                                                   | External CLI contract (`--query` / `--max_turns`) — keep in sync with the runbook.                                                                                                                                                                                             |

## §2 Synchronization matrix

Each row: what you change → everything you must check or change with it → what happened when a
row was skipped.

**Adaptive action vocabulary**
→ ① `packages/core/index.mjs` action list in `createAdaptiveExecutionInput` + authorizer safe-recovery
handling ② hermes prompt parameter description ③ `packages/provider-playwright/index.mjs` gateway
action switch ④ `packages/cli/qa-native-adaptive-evidence.mjs` (admissible actions, artifact shape)
⑤ `packages/contracts/index.mjs` ExecutionActionProposal parameters ⑥ docs.
Skipped: 2.3.0 — validator was left out; adaptive rejected its own runs.

**Milestone model / completion semantics**
→ ① `createAdaptiveExecutionInput` ② `advanceAdaptiveMilestone` ③ `milestoneCompletionRule`
(single source — change it here, both runtime and validator follow) ④ judge semantic branch
⑤ prompt milestone rules ⑥ the policy-matrix fixture suite.
Skipped: 2.3.0 — three concrete gaps: startup-navigation URL rewrite vs first-audit equality;
sealed empty `satisfiedMilestoneIds` vs observe-only completion; `report_blocked`'s sixth artifact
vs the exact-five artifact count.

**`@qa-live-policy` values**
→ ① `scripts/dashboard-spec-parser.mjs` mapping ② `packages/adapter-playwright/index.mjs`
`POLICY_BY_LIVE_RUN` + semantic/blocked branches ③ README/docs policy tables ④ example specs
⑤ consumer-repo migration note.
Skipped: a value known only to the parser silently degrades to `blocked-unknown`.

**Diagnostics codes**
→ ① emitting layer (parser diagnostics carry offsets → block mapping) ② adapter file-level vs
test-level resolution (`testIndex`) ③ `--allow-partial` behavior.
Skipped: 2.1.0 — missing `testIndex` neutralized `--allow-partial`.

**CLI options**
→ ① `COMMAND_OPTIONS` in `packages/cli/qa-native.mjs` ② usage/help text ③ README
④ `docs/qa-native-one-shot-runbook.md`.
Skipped: `--help` drifts from reality.

**Budget shape**
→ ① `DEFAULT_ADAPTIVE_BUDGET` ② `--budget-*` flags ③ authorizer exhaustion checks ④ prompt
`remainingBudget` description ⑤ docs.
Skipped: a missing check is an infinite budget.

**Hermes prompts**
→ ① bump `EXECUTION_PROMPT_VERSION` ② if the change encodes a rule, verify the runtime authorizer
actually enforces it (prompts advise, runtime enforces).
Skipped: results become incomparable across runs.

**Contracts fields**
→ ① schemaVersion bump ② `validateContract` ③ old-artifact read compatibility (judge re-runs old
runs) ④ HMAC surface changes.
Skipped: previously sealed runs fail re-judgment. The validator keeps a legacy shim for 4-key
audits (no `satisfiedMilestoneIds`) for exactly this reason.

**Evidence deletion / failure paths**
→ ① failure paths preserve, never delete (`preserveInvalidRun` → `<run-dir>.invalid`) ② the
`.invalid` path guard in `resolvePrivateQaPath` ③ judge/report refusal of `.invalid`.
Skipped: 2.2.0-era `rmSync` destroyed the only evidence of validation failures.

**Browser network policy** (route interception, origin allowances, mutation blocking)
→ ① strict pre-interaction allows same-site (registrable domain) GET/HEAD — consumer apps serve
their API from sibling origins, and blocking those reads breaks the page under test itself
② the exfiltration guard (foreign-site reads) and mutation blocking stay intact — named tests
③ post-interaction traffic keeps the stricter same-origin rule ④ docs network-policy sentences.
Skipped: v2.4 — same-origin-only reads aborted the consumer app's own auth/plans/credit calls;
scenarios sealed "Failed to fetch" error shells and verdicts flipped with SSR cache luck.

**Timing / clock / wait-budget changes** (element observation waits, gateway deadlines,
`withTimeout`, node timeout policy)
→ ① repeated no-DEBUG runs against the consumer repo are the only valid verdict — `DEBUG=pw:api`
and even the lightweight `QA_NATIVE_TRACE_TIMING=1` probe change scheduling enough to mask races
(measured: trace-on 3/3 pass while no-DEBUG failed) ② every element-level wait must stay bounded
below the node timeout and end as an observed fact, never as a run-killing timeout ③ the
policy-matrix fixture suite.
Skipped: v2.4-pre — `waitFor(visible)` and `locator.evaluate` used the full node timeout; hidden
NOT_VISIBLE targets and detached elements killed the consumer strict one-shot (0/4 → 5/5 after
bounding).

**Deferred**: replacing the first-audit baseline exception with an explicit RUNTIME_NAVIGATION
audit sealed by the gateway (root-cause fix for startup navigation). Requires an audit schema
bump — run the "contracts fields" row when picked up.

## §3 Invariants

1. The execution agent never declares verdicts or milestone completion; `report_blocked` carries a
   claim, judged later against sealed evidence — prompt-injection defense.
2. Evidence is never deleted; failed-run evidence is the most valuable evidence. Failure paths
   quarantine to `<run-dir>.invalid`.
3. The only source of policy truth is the spec annotation (`@qa-live-policy`).
4. Diagnostics are never swallowed: stderr always, details behind `QA_NATIVE_DEBUG`.
5. Compilation failures fail closed per scenario; `--allow-partial` skips, never guesses.
6. `milestoneCompletionRule` acceptance is a necessary condition of runtime acceptance — the
   validator may be more lenient than the live runtime (it lacks element handles), never stricter.

## §4 PR checklist (adaptive / compilation path changes)

- [ ] Every applicable §2 matrix row walked.
- [ ] `packages/cli/__tests__/qa-native-adaptive-matrix.test.mjs` passes (all-complete /
      report_blocked / budget-exhausted against `packages/cli/__tests__/fixtures/policy-matrix.spec.ts`).
- [ ] For minor+ releases: one manual pass of `docs/qa-native-one-shot-runbook.md` (strict and
      adaptive tracks) against real staging.
- [ ] Changeset added and applied (see CLAUDE.md).

## §5 Verification

```bash
cd apps/playwright-spec-for-ai-agent && pnpm test   # vitest run — the full gate
```

There is no lint/typecheck script (the source is `.mjs`). Run the gate and report its actual
output before claiming work is done. The file references in this document are checked by
`packages/__tests__/agents-md-refs.test.mjs`.
