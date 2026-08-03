# @lodado/personaut

## 0.5.1

### Patch Changes

- Repair the cross-app spec parser import and consolidate Playwright source
  extraction into the shared playwright-spec-extract workspace package.

## 0.5.0

### Minor Changes

- 33618b0: Realign the deferred fail-loud design decisions per the maintainer's plan: budget exhaustion (action/time/no-progress) now terminates as a clean ABANDONED with the budget code preserved instead of runtime_error, so it counts toward abandonment and is no longer excluded from variant comparison as infrastructure; one session's evidence-seal failure no longer aborts the whole run (the in-memory manifest is returned and that session degrades to runtime_error while siblings still complete and report); variant comparison reports insufficient_evidence below 5 comparable pairs per arm rather than declaring a winner off a single flipped session; and the hyperactivity heuristic only applies when the action budget is large enough for its ">=80%" ratio to be meaningful.

### Patch Changes

- 6f0403e: Extract the Hermes CLI transport into a shared private package `@persona-runtime/hermes-transport` so personaut no longer deep-imports a file inside the sibling app (`../../playwright-spec-for-ai-agent/scripts/hermes-runner.mjs`) with no declared dependency edge. personaut now imports the package and bundles it. qa-native ships raw `.mjs`, so its `scripts/hermes-runner.mjs` re-exports the package in the monorepo and a `prepack` step inlines the package back into that path for publish, keeping the published artifact self-contained. No runtime behavior changes for either package.

## 0.4.0

### Minor Changes

- Wire the persona behavioral dimensions into the deterministic policy (readingDepth, retry/recovery, backtrack, signup/price aversion, hesitation, exploration breadth, real elapsed time) so seeds and personas actually diverge; let a Hermes persona voluntarily finish or abandon; make the statistical validity metrics defensible (honest seed-sensitivity, equal-weight fingerprint distance, identity for empty profiles, cumulative progress curve, guarded cooperation/positivity heuristics, higher default recurrence bar); suppress binary evidence for all authenticated sessions; render captured screenshots/video inline in the HTML report; and correct the README's false Hermes loopback/no-auth security claims.

## 0.3.2

### Patch Changes

- Complete authenticated adaptive one-shot QA with safer bounded action handling.

## 0.3.1

### Patch Changes

- Add private storage-state injection and bounded auth-bootstrap support for authenticated QA sessions.

## 0.3.0

### Minor Changes

- 9497444: Add an opt-in bounded Hermes action policy with digest-only attempt provenance and no deterministic fallback.

### Patch Changes

- Capture settled failure screenshots and preserve explicit progress signals while inferring successful URL changes.

## 0.2.0

### Minor Changes

- e6f8aa1: Publish Personaut as a bundled public npm package under the Lodado scope, with a safe starter-study generator and standalone quick start.
