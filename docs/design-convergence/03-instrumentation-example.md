# Phase 3 — Test-only instrumentation and the example app

## 목표

한 manually bound JSX boundary가 명시적으로 enabled된 test build에서만 design-node attribute를 받고 production build에는 남지 않음을 증명한다.

## 선행 조건

- Phase 2 has produced a schema-valid `design-bindings.json` with one source-preflight-eligible intrinsic JSX target.
- The fixture-backed Figma node for `Pricing Card / Pro` is available without network access.
- `pnpm --filter @design-convergence/shared test`, `pnpm --filter @design-convergence/config test`, and `pnpm --filter @design-convergence/figma test` pass.
- Next.js build integration runs project code and therefore requires the explicit operator-approved execution setting from Phase 01.

Do not start browser comparison or AI binding work in this phase.

## 생성/수정 예정 파일

Create the instrumentation package only when this phase begins:

```text
packages/design-convergence-instrumentation/
  src/index.ts
  src/babel-plugin.ts
  src/resolve-target.ts
  test/babel-plugin.test.ts

examples/design-convergence-next-tailwind/
  package.json
  app/pricing/page.tsx
  app/globals.css
  components/PricingCard.tsx
  design-cases/pricing-desktop.ts
  babel.config.cjs
  design-convergence.config.json
  design-bindings.json
```

Planned package name: `@design-convergence/instrumentation`.

Add only `examples/design-convergence-*` to `pnpm-workspace.yaml`; do not enroll every existing example accidentally.

## 구현 결정

1. The compiler transform consumes preflight-eligible manual binding metadata; it never asks AI for a target.
2. v0.1 supports an `intrinsic-jsx-element` target first. `component-root` support arrives with Phase 5, after the component index exists.
3. The transform is enabled only when the configured environment variable equals the explicit value `true`.
4. The default attribute is `data-design-node`. Custom names must match `^data-[a-z0-9]+(?:-[a-z0-9]+)*$`.
5. The attribute value is emitted as a string literal from schema-validated metadata. Existing dynamic or conflicting attributes are an error.
6. The Next.js example opts into a conditional Babel configuration for the test build. Production uses the same Babel configuration with the plugin disabled and must be verified by output, not assumed.
7. SWC and Vite adapters are not scaffolded in this phase.
8. **`next/font` is forbidden in the example.** A `babel.config.cjs` disables Next's SWC entirely, and `next/font` requires SWC, so it would fail the build. The example fixes fonts with a committed local `@font-face` instead — which also makes `document.fonts.check` (a Phase 4 infrastructure gate) deterministic. Pin the example to a Next.js minor version whose webpack+Babel path is verified, and record that known-good version in `docs/design-convergence/limitations.md`.

## Task 3.1 — Add the deliberately mismatched Pricing example

**Files**

- Create the files under `examples/design-convergence-next-tailwind/` listed above.
- Modify `pnpm-workspace.yaml` with the narrow example glob.

- [ ] Build one `/pricing` page with one `PricingCard` component.
- [ ] Give the card stable content (`Pro`, `$29`, `Start Free`) and intentionally wrong height, padding, background, radius, font size, font weight, and text color.
- [ ] Keep behavior, data fetching, authentication, and routing logic out of the fixture.
- [ ] Add a page-ready marker used only for deterministic waiting.
- [ ] Add a manual binding whose source range points at the card's root `<section>`.
- [ ] Add a case module that only navigates/prepares UI state; it must not assert design correctness.

**Test first**

- [ ] Add a fixture source/build smoke that asserts readiness marker and expected static text without launching a browser.
- [ ] Confirm the test fails before the example exists and passes after the minimum page/build is added.

## Task 3.2 — Resolve a binding against Babel source locations

**Files**

- Create `packages/design-convergence-instrumentation/src/resolve-target.ts`.
- Create `packages/design-convergence-instrumentation/test/babel-plugin.test.ts`.

- [ ] Parse with JSX and TypeScript support and retain source locations.
- [ ] Match `filePath`, component identity, element name, occurrence, and the stored source range.
- [ ] Treat source location as a stale-content guard, not as the sole identity signal.
- [ ] Return exactly one target or a typed instrumentation error.
- [ ] Reject a missing target, two matching targets, an occurrence mismatch, a stale range, and a file outside the configured project root.
- [ ] Never choose the nearest JSX element as a fallback.
- [ ] Persist a successful `StaticBindingValidation` artifact, but keep the binding `proposed` until browser runtime validation.

**Failing checks to add**

1. A valid `section` occurrence resolves once.
2. Moving the element invalidates the stored range.
3. Two candidates with ambiguous identity fail.
4. A binding for another file is ignored rather than injected.

## Task 3.3 — Implement the Babel plugin

**Files**

- Create `packages/design-convergence-instrumentation/src/babel-plugin.ts`.
- Export it from `src/index.ts`.

- [ ] Make the disabled path a no-op before reading binding files.
- [ ] Load and validate bindings through `@design-convergence/shared`; do not trust parsed JSON directly.
- [ ] Inject one string-literal attribute on the resolved opening element.
- [ ] Reject an existing conflicting attribute and avoid duplicating an identical attribute.
- [ ] Preserve Babel source maps and avoid unrelated AST rewrites.
- [ ] Include binding ID, file path, and reason in typed errors, but never source contents or secrets.

**Test sequence**

```bash
pnpm --filter @design-convergence/instrumentation test
pnpm --filter @design-convergence/instrumentation typecheck
pnpm --filter @design-convergence/instrumentation build
```

The tests must compare parsed output semantics rather than snapshotting an entire formatted file.

## Task 3.4 — Wire the test-only Next.js build

**Files**

- Create `examples/design-convergence-next-tailwind/babel.config.cjs`.
- Add example build and test scripts.

- [ ] Enable the plugin only when `DESIGN_CONVERGENCE=true` (or the configured variable) is present.
- [ ] Pass the config directory and binding artifact path explicitly.
- [ ] Run the Babel transform fixture with instrumentation enabled and prove the output AST has exactly one `data-design-node="120:8"`.
- [ ] Run it without the environment variable and prove the output AST has no design-node attribute.
- [ ] Build the example once in each mode to prove both compiler paths succeed; runtime DOM assertions belong to Phase 4.
- [ ] Dry-run a stale binding and prove the transform fails before any app/browser process starts.
- [ ] Document that v0.1 Next.js consumers must opt into this conditional Babel integration; do not imply transparent SWC support.

## Task 3.5 — Add the CLI instrumentation preflight

**Files**

- Add the smallest instrumentation preflight to `apps/design-convergence/src/commands/run.ts`.

- [ ] Validate bindings before starting the configured app command.
- [ ] Print the number of statically eligible bindings and the selected case.
- [ ] Stop with error kind `instrumentation` when the mapping is stale or ambiguous.
- [ ] Do not start Chromium or classify a design mismatch in this phase.

## 실제 검증 명령

Run from the workspace root:

```bash
pnpm --filter @design-convergence/instrumentation test
pnpm --filter @design-convergence/instrumentation typecheck
pnpm --filter @design-convergence/instrumentation build
pnpm --filter design-convergence-example-next-tailwind test
pnpm --filter design-convergence-example-next-tailwind build
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Capture the actual pass/fail counts. Do not treat a missing Chromium binary as a passing test; browser execution belongs to Phase 4 and should be reported as infrastructure setup.

현재 문서-only 상태에는 해당 workspace/example이 없으므로 이 명령은 Phase 3 구현 PR에서만 실행 가능하다.

## 종료 게이트

- Enabled transform: exactly one correct generated attribute in parsed output.
- Disabled transform: zero generated design-node attributes in parsed output.
- Stale, duplicate, and ambiguous bindings: clear failure before app comparison.
- Binding status is not promoted to `validated` before Phase 4 runtime checks.
- No server or browser is started by this phase's instrumentation tests.
- Original TSX source remains unchanged.
- No SWC/Vite adapter or permanent production attribute has been added.

Only after this gate passes may Phase 4 start.

## 다음 phase 진입 게이트

Phase 4는 enabled/disabled build와 stale-binding failure의 실제 command evidence가 모두 남은 뒤에만 시작한다. 입력은 statically eligible binding artifact, instrumented example command, fixture-backed Figma canonical node다.

## 의도적 보류

- `component-root` binding은 React index가 생기는 Phase 5까지 보류한다.
- SWC/Vite adapter와 permanent production attribute는 추가하지 않는다.
- Playwright style capture, runtime binding validation, diff는 Phase 4에서 구현한다.
