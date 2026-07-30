# Phase 6 — CSS source attribution and shared-cause grouping

## 목표

mismatching computed value의 winning source를 설명하고 deterministic evidence가 같은 원인을 가리킬 때만 반복 mismatch를 shared cause로 묶는다.

## 선행 조건

- Phase 5 stores validated bindings and exact source hashes.
- Phase 4 produces stable property-level diffs and browser captures.
- No patch generation is required to complete this phase.

## 생성/수정 예정 파일

```text
packages/design-convergence-attribution/
  src/cdp.ts
  src/property-map.ts
  src/css-attribution.ts
  src/tailwind-attribution.ts
  src/group-causes.ts
  test/
```

Planned name: `@design-convergence/attribution`.

This package consumes browser evidence, bindings, the source index, and diffs. It emits attribution and cause-group artifacts. It must not edit files or call AI.

## Task 6.1 — Capture matched styles through CDP

**Files**

- Create `cdp.ts` and focused Chromium integration fixtures.

- [ ] Open a Playwright `CDPSession` for Chromium and enable the DOM/CSS domains.
- [ ] Resolve each validated runtime element to a CDP node without exposing arbitrary browser control to later packages.
- [ ] Collect matched rules, inline styles, inherited rules, pseudo-element rules, stylesheet IDs, and source positions.
- [ ] Record disabled/overridden declarations only as diagnostic candidates; never call them winners.
- [ ] Keep browser protocol failure as `source-attribution` infrastructure provenance while preserving the original style diff.
- [ ] Record Chromium/version support in the artifact.

Do not add cross-browser attribution in v0.1.

## Task 6.2 — Map canonical property paths to winning declarations

**Files**

- Create `property-map.ts` and `css-attribution.ts`.

- [ ] Maintain an explicit mapping from canonical paths to CSS longhands and relevant shorthands.
- [ ] Reconcile matched rules with the final computed value, importance, cascade order, inheritance, and pseudo-element context.
- [ ] Follow CSS variable references to the winning workspace-local definition when CDP evidence supports it.
- [ ] Attribute inline values separately.
- [ ] Map stylesheet URLs and source maps only to real paths contained in the project root.
- [ ] Reject remote-fetched (`http:`/`https:`), `blob:`, traversal, symlink-escaped, and ambiguous source-map locations.
- [ ] Do **not** blanket-reject inline `data:` source maps: dev servers inline the CSS source map as a `data:` URI by default, so rejecting it would make CSS Modules attribution impossible in dev, and production omits CSS maps entirely unless enabled. Parse an inline `data:` map, then apply the same project-root containment check to each mapped original source path. The security property is unchanged — a hostile map can only point at paths, and paths are already contained.
- [ ] Fix the app run mode used for attribution in config and run the example with CSS source maps enabled; attribution requires a run mode that emits usable maps.
- [ ] Return `framework: "unknown"` plus alternatives when one winner cannot be proven.

Tests must cover shorthand-vs-longhand, `!important`, inheritance, CSS variables, pseudo-elements, CSS Modules, duplicate rules, and hostile source-map paths.

## Task 6.3 — Add basic static Tailwind attribution

**Files**

- Create `tailwind-attribution.ts` and source fixtures.

- [ ] Start from rendered class tokens and the bound JSX `className` expression.
- [ ] Resolve common static utility strings that explain the mismatching property.
- [ ] Support statically enumerable branches in common `clsx`, `classnames`, and `cva` calls only when the source index proves the tokens.
- [ ] Record the exact source range, expression, utility, and confidence.
- [ ] Return ambiguity when multiple utilities, variants, arbitrary values, or dynamic generation may win.
- [ ] Do not load or execute Tailwind configuration as repository code.

v0.1 does not promise arbitrary dynamic class, plugin, or generated utility support, and targets Tailwind 3.x only; the v4 CSS-first config model is deferred (see `limitations.md`).

## Task 6.4 — Emit source-attributed diffs

- [ ] Join attribution to a diff by case ID, binding ID, property path, capture hash, and exact source revision.
- [ ] Reject joins across stale runs or differing source hashes.
- [ ] Preserve unattributed diffs instead of dropping them.
- [ ] Add `attribution.json` under each case artifact directory.
- [ ] Show source path/line/declaration in terminal output only after redaction and path normalization.
- [ ] Never include full unrelated source files in the artifact.

## Task 6.5 — Group likely shared causes deterministically

**Files**

- Create `group-causes.ts` and unit tests.

- [ ] Build group keys from proven source identity: file/range/declaration or variable, Tailwind utility, component variant, property path, expected value, and actual value.
- [ ] Merge affected cases/bindings in stable sorted order.
- [ ] Compute group confidence from attribution completeness and agreement, not from an AI narrative.
- [ ] Mark a group patch-eligible only when its source cause is singular, workspace-local, current, and above the configured high-confidence threshold.
- [ ] Keep unknown or conflicting candidates in separate review-required groups.
- [ ] Never group merely because numeric deltas happen to match.

Required fixture:

```text
Login button    h-10 -> expected 48px
Pricing button  h-10 -> expected 48px
Checkout button h-10 -> expected 48px
```

All three should form one `tailwind-utility` cause group only when they resolve to the same shared source expression. A local unrelated `height: 40px` rule must remain separate.

## Task 6.6 — Extend `run`/`diff` artifacts

- [ ] Let `run` optionally capture CDP evidence after deterministic style extraction.
- [ ] Make `diff` recompute diffs and cause groups from stored normalized artifacts without launching the app.
- [ ] Validate artifact hashes and schema versions before offline recomputation.
- [ ] Print attribution coverage and ambiguity counts separately from fidelity.
- [ ] Make lack of attribution block auto-patching, not ordinary comparison/reporting.

## 실제 검증 명령

```bash
pnpm --filter @design-convergence/attribution test
pnpm --filter @design-convergence/attribution typecheck
pnpm --filter @design-convergence/attribution build
pnpm design-convergence run --case pricing-desktop
pnpm design-convergence diff --case pricing-desktop
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

The integration test must use local CSS, CSS Module, and Tailwind fixtures. No network or AI provider is needed.

현재 문서-only 상태에는 해당 package/commands가 없으므로 이 명령은 Phase 6 구현 PR에서만 실행 가능하다.

## Milestone 3 exit gate

- A padding mismatch points to the correct CSS/CSS Module declaration in a fixture.
- A static Tailwind height mismatch points to the correct utility and source range.
- Repeated shared-button mismatches form one stable cause group.
- Ambiguous, remote, stale, or dynamic sources remain review-required and cannot enter the patch phase automatically.
- Comparison remains usable when attribution is unsupported or fails.

## 다음 phase 진입 게이트

Phase 7은 singular/high-confidence cause group fixture와 ambiguity/review-required fixture가 모두 통과하고 stale/remote attribution이 patch-eligible이 아님이 증명된 뒤에만 시작한다.

## 의도적 보류

- non-Chromium protocol, arbitrary dynamic Tailwind, remote source-map fetch는 지원하지 않는다.
- attribution ambiguity를 AI로 덮거나 source를 추측하지 않는다.
- 이 phase는 source file을 수정하지 않는다.
