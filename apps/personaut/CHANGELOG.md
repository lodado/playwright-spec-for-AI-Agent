# @lodado/personaut

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
