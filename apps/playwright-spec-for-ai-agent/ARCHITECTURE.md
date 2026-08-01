# QA Native Architecture

This document is the implementation map for `apps/playwright-spec-for-ai-agent`.
Read it with `AGENTS.md` before changing the pipeline. `AGENTS.md` owns working
rules and change matrices; this file owns runtime boundaries, data flow, and
compatibility expectations.

## System goal

QA Native converts authored Playwright intent into bounded live-browser
evidence. The execution agent may choose actions, but it cannot grant policy,
declare a verdict, select a file, or turn its own claim into a test result.

```text
Playwright spec
  → static manifest (AST: identity, policy, fixtures, safe authored targets)
  → abstract-ai (explicit Given / When / Then semantics)
  → applicability preflight (one read-only live-page observation)
  → adaptive or strict execution (applicable/ambiguous scenarios only)
  → sealed evidence + authenticated run envelope
  → evidence-only judge
  → independent judgment review
  → report/remediation/publication
```

Static analysis owns authority. AI owns interpretation and action proposals.
Code-owned contracts, browser policy, evidence validation, and reviewers remain
the trust boundaries.

## Pipeline stages

### 1. Static manifest

`scripts/playwright-ast-parser.mjs` and
`scripts/dashboard-spec-parser.mjs` extract test boundaries, annotations,
`@qa-live-policy`, `@qa-fixture`, and the safe subset of authored Playwright
targets. Unsupported authority-bearing syntax fails closed. Static parsing does
not attempt to understand the full behavioral meaning of a test.

### 2. Abstract AI

`packages/provider-hermes/index.mjs` extracts, and independently reviews, each
test as an explicit behavioral contract:

- **Given**: only material initial conditions observable before the flow,
- **When**: the authored user or system flow,
- **Then**: observable claims that must hold after the flow,
- live classification.

Given is not a reconstruction of test fixtures or hidden API setup. When a
Then claim directly exposes the relevant product state, the internal mock,
endpoint, or payload that produced it is not an additional applicability gate.
Given also cannot presuppose the presence, absence, or state of the subject
that Then evaluates; otherwise a real product regression would be skipped as
not applicable instead of reaching judgment.

The approved abstraction artifact uses `given`, `when`, and `then` directly.
During compilation these map to the existing QA IR semantic fields
`applicability`, `when`, and `claims`, preserving old authenticated run and
judge compatibility while making the AI extraction boundary unambiguous.

`packages/abstract-playwright/index.mjs` combines approved semantics with the
immutable static manifest. AI output cannot add policy, selectors, actions,
fixtures, or verdicts. Cache keys include source, manifest, prompt, model, and
review identity so stale meaning cannot silently survive a change.

Large specs are extracted and independently reviewed in bounded batches of at
most eight tests. A timeout, invalid model envelope, or batch validation failure
retries only the failed batch at half size down to one test; successful batches
are never repeated. A retryable single-test timeout or invalid response is tried
once more, then fails closed. Approved results are stored in the private content-addressed
cache, while changed source, manifest, model, or prompt/reviewer versions force
fresh extraction.
Three reviewed revisions are allowed; a fourth independent rejection remains
`MANUAL_REVIEW` and never reaches compilation or execution.

### 3. Applicability preflight

Adaptive execution performs one read-only observation of the configured live
page before opening per-scenario sessions. Hermes compares that observation
with only every compiled scenario's approved, pre-flow Given conditions
conditions and returns one decision per scenario. Scenario titles, claims, and
post-action states are not selector input, so an authored destination or dialog
cannot be mistaken for a missing initial prerequisite:

Applicability is limited to initial live conditions a read-only observation can
establish: route, account state, product state, counts, and retained data.
Future mocked responses, route-handler payloads, fixture identities, uploads,
destination URLs, dialogs, requests, and toasts remain in authored flow or
claims; they are never reasons to skip before execution.

| Decision | Runtime behavior |
| --- | --- |
| `APPLICABLE` | Execute. |
| `NOT_APPLICABLE` | Do not execute or judge as a failure. Report separately. |
| `AMBIGUOUS` | Execute to preserve legacy coverage; the later judge may resolve it. |
| statically unsupported | Existing compile/`--allow-partial` path; never delegated to AI. |

Only a high-confidence, complete `NOT_APPLICABLE` decision may remove a
scenario from execution. Missing, malformed, duplicate, low-confidence, or
selector-failure decisions become `AMBIGUOUS`, preserving the preflight-free
legacy behavior. Preflight cannot grant a scenario more policy than its static
manifest. The runtime gives the selector short, run-local scenario keys and
maps validated decisions back to immutable scenario IDs; the model never has to
copy or reconstruct authority-bearing internal hashes.

The complete decision set is stored in `qaIr.extensions.applicabilityDecisions`.
Because `qa-ir.json` is hashed by the authenticated run envelope, later commands
can report the selection without trusting an unauthenticated side file.

### 4. Execution

`packages/core/index.mjs` builds strict plans or adaptive inputs and owns the
single milestone-completion rule. `packages/provider-playwright/index.mjs`
enforces browser capabilities and seals every accepted or failed action.

Adaptive recovery is autonomous: the agent may click a structurally safe
observed element, press Escape, hover, scroll, or wait. A recovery action never
completes an exact authored milestone. Exact completion requires a fresh
authored locator used by the successful browser action and a corresponding
`satisfiedMilestoneIds` proof in sealed evidence.

Network policy is code-owned. Adaptive mode permits only `GET`/`HEAD` to exact
leased origins, closes WebSockets, blocks mutations, and drains pending policy
decisions before sealing success. File uploads use only an author-designated
`@qa-fixture` inside the project root.

### 5. Evidence

`packages/evidence/index.mjs` captures bounded, redacted artifacts, HMAC-sealed
manifests, and private archives. `packages/cli/qa-native-adaptive-evidence.mjs`
validates action ordering and delegates completion semantics to core. Rejected
actions such as pointer interception are sealed as `EXECUTION_FAILED`; they do
not advance a milestone and stale observations are discarded.

Evidence is never deleted. Invalid runs are quarantined to `<run-dir>.invalid`
and every downstream command refuses them.

### 6. Judge and review

`packages/judge/index.mjs` evaluates only sealed evidence. It may return
`PASS`, `FAIL`, `SKIP`, or `MANUAL_REVIEW`. A scenario whose material
applicability is affirmatively not met is `SKIP`, not `PASS`, `FAIL`, or
`MANUAL_REVIEW`.

Missing evidence for an internal mock, helper, or setup request is not an
applicability conflict when the required route/account/product state and the
user-visible claim are directly established by sealed page evidence. Internal
network setup matters only when that network behavior is itself an authored
claim or is required to distinguish the visible product state.

`packages/review/index.mjs` uses an independent invocation to check grounding.
Review approval means the judgment is evidence-supported; it does not change
the verdict and is not an application PASS.

### 7. Report and remediation

Reports separate:

- executed judgments by verdict,
- preflight `NOT_APPLICABLE` scenarios,
- statically unsupported/blocked scenarios,
- unapproved reviews.

Only `FAIL` and approved `MANUAL_REVIEW` judgments enter remediation. `SKIP`
and preflight `NOT_APPLICABLE` never count as failing. Publication remains
authenticated and has no merge or auto-merge path.

## Module ownership

| Module | Owns | Must not own |
| --- | --- | --- |
| `packages/contracts` | Schemas, versions, action vocabulary | Browser behavior or prompt policy |
| `scripts/*parser*`, `packages/adapter-playwright` | Static identity and authority | Semantic guessing |
| `packages/abstract-playwright` | Manifest + approved semantics composition | Live decisions |
| `packages/provider-hermes` | Extraction, applicability, action, judgment, review prompts | Enforcement or verdict promotion |
| `packages/core` | Plans, leases, milestones, completion rule | Browser I/O |
| `packages/provider-playwright` | Browser I/O, network policy, evidence capture | Verdicts |
| `packages/evidence` | Redaction, storage, HMAC, archive I/O | Scenario semantics |
| `packages/cli/qa-native-adaptive-evidence` | Cross-layer evidence sequencing | A second completion-rule copy |
| `packages/judge` | Evidence → verdict | Browser access or execution claims as facts |
| `packages/review` | Independent judgment grounding | Replacement verdicts |
| `packages/cli/*` | Orchestration and authenticated persistence | Duplicated domain rules |
| reporters/remediation/repository providers | Presentation and bounded repair workflow | New evidence or authority |

## Compatibility rules

1. Strict mode, `--compiler=ast`, and old authenticated runs remain readable.
2. Additive optional QA IR extensions do not change action authority.
3. If applicability preflight fails, adaptive execution falls back to the old
   execute-all behavior instead of silently dropping coverage.
4. Prompt changes bump their prompt version. Contract field changes follow the
   `AGENTS.md` schema-version and legacy-read matrix.
5. A new action changes `ACTION_SPECS` first; every consumer derives from it.
6. Completion semantics change only in `milestoneCompletionRule`; runtime and
   evidence validation share it.
7. Partial or failed scenarios preserve every already-sealed bundle.
8. Downstream commands consume authenticated QA IR, evidence, and run-envelope
   bindings; diagnostic side files never grant authority.

## Change checklist

Before merging a pipeline change, walk the relevant `AGENTS.md` matrix and run:

```bash
pnpm vitest run packages/cli/__tests__/qa-native-adaptive-matrix.test.mjs
pnpm test
```

For applicability changes additionally verify:

1. one live observation is shared across scenario selection;
2. high-confidence inapplicable scenarios are not executed;
3. ambiguous or selector-failure scenarios still execute;
4. `SKIP`/`NOT_APPLICABLE` are not reported as failures;
5. strict and AST compatibility tests remain green;
6. an authenticated live run completes execute → judge → review → report.
