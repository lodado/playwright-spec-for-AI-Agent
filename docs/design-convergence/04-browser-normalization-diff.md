# Phase 4 — Browser capture, normalization, deterministic diff, and JSON output

## 목표

첫 vertical slice인 Figma Pricing Card fixture 1개, manual binding 1개, test-only instrumented Next.js page 1개, Playwright capture, deterministic property diff, terminal/JSON evidence를 완성한다.

## 선행 조건

- Phase 3 proves enabled and disabled instrumentation behavior.
- The example app can be started through an operator-approved argv command.
- No AI provider is configured or required.

## 생성/수정 예정 파일

Create only these packages in this phase:

```text
packages/design-convergence-browser/
  src/app-process.ts
  src/case-worker.ts
  src/load-prepare.ts
  src/stabilize.ts
  src/extract-rendered-style.ts
  src/validate-binding.ts
  src/run-case.ts
  test/

packages/design-convergence-comparison/
  src/normalize/
  src/diff.ts
  src/severity.ts
  src/metrics.ts
  test/
```

Planned names are `@design-convergence/browser` and `@design-convergence/comparison`. Keep terminal formatting in the CLI; do not create the full report package yet.

`@design-convergence/browser` declares its own `esbuild` runtime dependency for approved TypeScript case modules; it must not rely on the copy currently declared by another app.

Dependency direction:

```text
shared <- config
shared <- figma
shared + config <- browser
shared <- comparison
browser + figma + comparison <- CLI orchestration
```

`comparison` must not import Playwright, Figma REST types, the CLI, or an AI provider.

## Task 4.1 — Start and stop the configured application safely

**Files**

- Create `packages/design-convergence-browser/src/app-process.ts` and tests.

- [ ] Convert the validated command to `{ executable, args }` and call `spawn` with `shell: false`.
- [ ] Use only the config-selected command; AI output can never alter executable, args, cwd, or environment.
- [ ] Pass a minimal child environment and explicitly remove Figma, GitHub, and AI credentials.
- [ ] Set only the configured instrumentation variable for the comparison process.
- [ ] Refuse project commands unless `execution.allowProjectCode: true` was explicitly validated.
- [ ] Poll `readyURL` until ready or `startupTimeoutMs` expires.
- [ ] Bound and redact stdout/stderr; on failure, retain error kind `application-startup`.
- [ ] Terminate the complete child process tree on success, timeout, and cancellation.

Tests must cover timeout, early exit, redacted secret output, and cleanup. A failed app startup is never a style mismatch.

## Task 4.2 — Run a deterministic Playwright case

**Files**

- Create `stabilize.ts` and `run-case.ts`.

- [ ] Launch Chromium in a fresh context per case with configured viewport, locale, timezone, and device scale factor.
- [ ] v0.1 assumes Figma px and CSS px are 1:1, which holds only when the case viewport width matches the Figma frame width. Document this assumption; position plausibility uses the comparison-root box, and a percentage tolerance option is available when frame and viewport widths differ.
- [ ] Run Playwright and the prepare module in a dedicated Node worker process started with `shell: false` and a sanitized env; pass only schema-validated, secret-free case input and return schema-validated evidence.
- [ ] Navigate only to the configured same-origin route.
- [ ] Execute a case `prepare` module only in operator-approved execution mode.
- [ ] Support root-contained `.ts`/`.mts`/`.js`/`.mjs` prepare entries by bundling with esbuild (no repository plugins/config) to a private content-hashed ESM temp module, importing it once, validating its default `CasePrepare` function, then deleting it.
- [ ] Enforce project-root containment during module resolution, inspect the esbuild metafile, reject outside/symlinked/forbidden inputs, and ensure Figma/AI/GitHub secrets are absent from the worker/prepare environment.
- [ ] Test a TypeScript prepare with a contained helper, unsupported extension, outside-root import, unapproved execution, missing default export, and thrown setup error.
- [ ] Inject the animation/transition/caret suppression CSS from the specification.
- [ ] Wait for the configured ready selector, `document.fonts.ready`, and visible images required by the case.
- [ ] Check expected mapped font families with `document.fonts.check`; an unavailable required font makes typography evidence unreliable and the case infrastructure-failed.
- [ ] Record font, image, page, and setup failures as infrastructure errors.
- [ ] Capture `before.png` as secondary evidence after stabilization.
- [ ] Close page, context, browser, and app process in `finally` paths.

Time freezing and API mocking are opt-in case configuration. Do not silently intercept application APIs.

## Task 4.3 — Extract a Rendered Style Tree

**Files**

- Create `extract-rendered-style.ts` and fixture tests.

- [ ] Locate all elements carrying the configured attribute, then compare exact attribute values; do not interpolate untrusted values into a CSS selector.
- [ ] In an enabled app run, prove the expected attribute is present exactly once. The disabled-production-run proof (no design-node attribute rendered) belongs to the Phase 3/4 integration test, run once — not to every `run` invocation. The ordinary `run --case` starts the app in enabled mode a single time.
- [ ] Require exactly one visible, non-zero element for the v0.1 binding.
- [ ] Resolve the case's Figma root binding first and use its browser rect as the comparison-root box for all descendant relative geometry.
- [ ] Capture `getBoundingClientRect()`, root and parent bounds, scroll offsets, device scale information, and visibility.
- [ ] Export one typed comparable allowlist covering display/position/flex/alignment/gaps, four paddings, typography, color/background, four border widths/styles/colors/radii, shadow, opacity, transform, overflow, object fit/position, and reliably parseable grid templates; capture nothing outside it by default.
- [ ] Capture `::before` and `::after` styles separately and mark absent pseudo-elements.
- [ ] Preserve raw browser strings in a bounded capture artifact, then normalize outside the page context.
- [ ] Record DOM tag and a debugging selector as metadata, not as a design contract.

The internal name is **Rendered Style Tree = Computed Style + Layout Box + Pseudo-element Style**. Do not describe this as a pure CSSOM comparison.

## Task 4.4 — Runtime-validate the manual binding

**Files**

- Create `validate-binding.ts` and use the shared `RuntimeBindingValidation` schema.

- [ ] Require `found`, `unique`, `visible`, and non-zero geometry checks to pass.
- [ ] Compare text overlap when the Figma node has meaningful text descendants.
- [ ] Check deterministic size, root-relative position, parent, and sibling plausibility thresholds.
- [ ] Require the element to be inside the configured comparison root.
- [ ] Persist every check and reason; high confidence or manual authorship cannot override a failed check.
- [ ] Promote the manual binding to `validated` only after static instrumentation and runtime validation both pass.
- [ ] Allow comparison/reporting only for the now-validated binding; automatic patching is still absent.

Add a rejection fixture that deliberately maps the 360 × 480 card to a 14 × 18 icon.

## Task 4.5 — Normalize Figma and browser values

**Files**

- Add focused modules under `packages/design-convergence-comparison/src/normalize/`.

Write a failing test before each normalizer:

- [ ] Colors: hex, rgb/rgba, transparent, Figma float channels, Lab conversion, and reference-vector-tested CIEDE2000 Delta E.
- [ ] Lengths: finite CSS pixel values and computed `rem`/`em` results; reject `NaN` and infinity.
- [ ] Typography: ordered family list, configurable aliases, numeric font weights, derived line height, and letter spacing.
- [ ] Corners and borders: four independent sides/corners rather than one shorthand assumption.
- [ ] Shadows: structured inset/offset/blur/spread/color arrays; mark approximations.
- [ ] Geometry: absolute and comparison-root-relative coordinates with zero-root guards.
- [ ] Derive aspect ratio and clipping/overflow diagnostics from canonical boxes/styles without extending DOM-structure comparison.
- [ ] Paints/transforms/images: normalize supported cases and emit explicit unsupported records for the rest.

Never convert an unsupported value to `undefined` and then treat it as equal.

## Task 4.6 — Implement deterministic property diffing

**Files**

- Create `diff.ts`, `severity.ts`, and `metrics.ts` with unit tests.

- [ ] Walk a fixed property registry rather than arbitrary object keys.
- [ ] Assign each property a category, comparator, tolerance source, and severity rule.
- [ ] Cover default/per-property overrides for position, size, spacing, font size, line height, letter spacing, radius, opacity, and color Delta E.
- [ ] Use finite numeric deltas for geometry/spacing/typography/opacity and Delta E for colors.
- [ ] Distinguish `match`, `mismatch`, `unsupported`, `missing-expected`, and `missing-actual` internally. Reserve an `acknowledged` status in the enum now (schema slot only, no v0.1 behavior) so a future triage/baseline workflow can mark a known mismatch without a schema migration. This is triage, not the forbidden "raise tolerance to hide failure" — see the limitations roadmap.
- [ ] Emit only non-matching or unsupported `StyleDiff` records, each with `schemaVersion: 1`.
- [ ] Derive severity from configured thresholds; AI is not in this code path.
- [ ] Use default severity weights `info=0`, `low=1`, `medium=3`, `high=8`, `critical=20` and make overrides explicit config.
- [ ] Compute `weightedDifference = Σ severityWeight`, `normalizedWeightedDifference = 100 × weightedDifference / (comparedPropertyCount × criticalWeight)`, and `fidelityScore = max(0, 100 - normalizedWeightedDifference)`; unsupported properties are counted but excluded from the denominator.
- [ ] Encode the specification's default critical/high/medium/low thresholds (missing mapped element, >20% size, >8px, 3–8px, cosmetic deltas) as tested config defaults.
- [ ] Define a passing case independently of the displayed score, using configured blocking severities.

Do not hard-code the illustrative `Compared properties: 18`; count supported values actually compared. Document fidelity as a project-relative QA metric, never a universal visual-quality score.

Because the denominator scales with `comparedPropertyCount`, widening the captured allowlist mechanically dilutes any single mismatch's effect on the score. This is exactly why pass/fail is defined from blocking severities, not from the score. Always print the absolute count of remaining high/critical diffs next to the fidelity number so a rising score cannot hide unresolved records.

## Task 4.7 — Persist atomic run artifacts

**Files**

- Add the run-artifact writer to `@design-convergence/shared` and orchestration to the CLI.

- [ ] Create `.design-convergence/artifacts/<run-id>` as a private run directory using a validated generated run ID.
- [ ] Write JSON atomically and exclusively; reject symlinks and paths outside the artifact root.
- [ ] Write, for the selected case, `figma.raw.json`, `figma.normalized.json`, `browser.normalized.json`, `bindings.json`, `diffs.json`, `before.png`, and `report.json`.
- [ ] Include schema version, exact Git commit, redacted config hash, binding hash, Figma payload hash, browser version, and timestamps in run metadata.
- [ ] Exclude token values and the unredacted process environment from every hash and artifact.
- [ ] Update `.gitignore` for the chosen `.design-convergence/` artifact/cache root.

There is no `after.png` until an accepted patch exists.

## Task 4.8 — Finish `run --case pricing-desktop`

**Files**

- Complete `apps/design-convergence/src/commands/run.ts` and terminal formatting.

- [ ] Resolve config and case.
- [ ] Load the fixture-backed Figma input and manual binding.
- [ ] Static-validate/instrument/start/runtime-validate/capture/normalize/diff/persist in that order.
- [ ] Print expected, actual, delta, tolerance, and severity for the required card properties.
- [ ] Print validated binding count, compared property count, fidelity score, artifact path, and honest status.
- [ ] Use exit code `0` for a passing comparison, `1` for deterministic product mismatches, and `2` for configuration/infrastructure failure.

Required mismatch coverage:

- height
- four padding sides
- background color
- four border radii
- font size
- font weight
- text color
- supported border values

## 실제 검증 명령

```bash
pnpm --filter @design-convergence/browser test
pnpm --filter @design-convergence/comparison test
pnpm --filter @design-convergence/browser typecheck
pnpm --filter @design-convergence/comparison typecheck
pnpm --filter design-convergence-example-next-tailwind test
pnpm design-convergence run --case pricing-desktop
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

For the intentionally mismatched fixture, the `run` command is expected to exit `1`; verify its artifact and terminal output rather than masking that exit code. Add a matching fixture variant that exits `0`.

현재 문서-only 상태에는 해당 package/CLI가 없으므로 이 명령은 Phase 4 구현 PR에서만 실행 가능하다.

## Milestone 1 exit gate

- One manually bound card is compared end to end with no AI provider.
- Its stored status becomes `validated` only after the complete static/runtime check record passes.
- Height, padding, background, radius, typography, color, border mismatches are property-level records.
- Missing element, font failure, app startup failure, and unsupported values keep distinct provenance.
- JSON artifacts validate against versioned schemas.
- Production output remains uninstrumented.
- Both passing and intentionally failing CLI cases have runnable integration checks.

Do not start Phase 5 until this vertical slice is green.

## 다음 phase 진입 게이트

Phase 5는 pass fixture exit `0`, mismatch fixture exit `1`, infrastructure fixture exit `2`와 schema-valid artifacts가 모두 확인된 뒤에만 시작한다.

## 의도적 보류

- AI binding, attribution, patching은 이 deterministic slice에서 구현하지 않는다.
- non-Chromium browser와 pixel screenshot comparison은 추가하지 않는다.
- complex blend/mask/mesh/SVG/canvas/video는 unsupported evidence로만 남긴다.
