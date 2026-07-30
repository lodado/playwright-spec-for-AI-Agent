# Phase 5 — React indexing, AI-assisted binding, and two-stage validation

## 목표

AI로 compact Figma-to-source binding을 제안하되 source target과 rendered boundary가 deterministic validation을 통과한 binding만 trusted status로 저장한다.

## 선행 조건

- Milestone 1 is complete and repeatable with manual bindings.
- Comparison and reporting still work when no AI provider is installed.
- The exact Git revision, source hashes, and binding hashes are already recorded.

## 생성/수정 예정 파일

```text
packages/design-convergence-binding/
  src/react-indexer.ts
  src/candidate-narrowing.ts
  src/proposal.ts
  src/static-validation.ts
  src/runtime-validation.ts
  test/

packages/design-convergence-ai/
  src/provider.ts
  src/mock-provider.ts
  src/openai-compatible.ts
  test/
```

Planned names: `@design-convergence/binding` and `@design-convergence/ai`.

The AI package owns provider transport and strict response parsing. The binding package owns candidate construction, confidence policy, and validation. Neither package may apply patches.

## Task 5.1 — Build a bounded React source index

**Files**

- Create `react-indexer.ts` and fixture sources for function, arrow, wrapper, conditional, CSS Module, and Tailwind components.

- [ ] Enumerate tracked `.tsx`, `.jsx`, `.ts`, and `.js` files inside the project root.
- [ ] Exclude `.git`, `node_modules`, build output, artifacts, `.env*`, `.private`, binaries, oversized files, and symlink escapes.
- [ ] Parse with `@babel/parser` TypeScript/JSX plugins and source locations; enable decorators only when config requires them.
- [ ] Traverse without importing or executing repository modules.
- [ ] Emit `ReactComponentIndexEntry` with exact file hash, source ranges, props, imports, intrinsic elements, static texts, class expressions, roots, and `usedBy` edges.
- [ ] Mark conditional/dynamic output as uncertain instead of predicting runtime output.
- [ ] Enforce file-count, byte, depth, and parse-error budgets with `source-index` provenance.

Tests must include malformed source, an excluded secret file, a symlink escape, dynamic JSX, and stable occurrence numbering.

## Task 5.2 — Narrow candidates before any model call

**Files**

- Create `candidate-narrowing.ts` and tests.

- [ ] Start from the configured route entry and its reachable component graph.
- [ ] Score deterministic hints: component/node-name similarity, text overlap, route usage, hierarchy, and rough dimensions.
- [ ] Include known bindings and compact Figma candidate ancestry.
- [ ] Bound candidate count, source excerpt bytes, text descendant count, and total prompt payload.
- [ ] Redact secret patterns and configured secret values centrally.
- [ ] Never include `.env`, cookies, authorization headers, storage state, unrelated files, or the entire repository/Figma document.
- [ ] Label Figma names/text and source comments as untrusted data so prompt text cannot promote them to instructions.

Candidate ranking only narrows model input; it does not create a binding.

## Task 5.3 — Define the AI provider boundary

**Files**

- Create the provider interface, mock provider, and generic OpenAI-compatible adapter.

- [ ] Expose `proposeBindings` and `proposePatch` on the public `AIProvider` interface, but implement and exercise only binding proposals in this phase.
- [ ] Validate inputs and outputs with strict Zod schemas and reject unknown keys.
- [ ] Require top-level `{ bindings, unresolved }` structured output and preserve unresolved Figma node IDs/reasons for review.
- [ ] Give the provider no shell, filesystem, browser, Git, or repository tool capability.
- [ ] Require the output source file/component/target to be exact members of the supplied candidate set.
- [ ] Reject independent proposals for absorbed/decorative node IDs unless the candidate artifact explicitly marks them bindable.
- [ ] Reject invented ranges, files, components, unsupported target kinds, oversized output, and secret echoes.
- [ ] Use bounded timeout/cancellation and classify provider/network failures as `binding-proposal`, not as rejected design mappings.
- [ ] Keep the mock provider deterministic for all tests and offline development.
- [ ] Configure the generic adapter with one exact operator-approved origin, model, and API-key environment-variable name; require HTTPS except loopback, block metadata/private targets unless explicitly local, and reject redirects. Keep the resolved key in orchestrator memory only.
- [ ] Use the platform `fetch` API rather than adding a provider SDK solely for this adapter.

The OpenAI-compatible adapter is optional at runtime. Manual binding, compare, report, and verification paths must not import it eagerly.

## Task 5.4 — Apply confidence policy without treating it as proof

- [ ] `confidence >= 0.90`: eligible for static validation.
- [ ] `0.70 <= confidence < 0.90`: persist as `review-required` without automatic instrumentation.
- [ ] `confidence < 0.70`: persist as `rejected`.
- [ ] Clamp/reject non-finite or out-of-range confidence; do not silently normalize it.
- [ ] Store evidence scores and notes after redaction.
- [ ] Resolve conflicts deterministically when proposals target the same source boundary or reuse a runtime value.

Unit tests must cover exactly `0.70`, exactly `0.90`, conflicts, duplicate IDs, and high confidence with invalid evidence.

## Task 5.5 — Perform static validation

**Files**

- Create `static-validation.ts` and extend instrumentation support for `component-root` only after tests exist.

- [ ] Pin validation to the indexed Git revision and file content hash.
- [ ] Confirm file, component, target JSX element, occurrence, and source range still exist.
- [ ] Confirm the runtime attribute value is unique among eligible bindings.
- [ ] Dry-run the Babel transform and parse the result again.
- [ ] Reject syntax damage, stale content, ambiguous component roots, duplicate attributes, and conflicting mappings.
- [ ] Promote only successful proposals to runtime-validation eligibility.

Do not write the target source file during validation.

## Task 5.6 — Reuse runtime validation for AI proposals

**Files**

- Create `runtime-validation.ts` as binding orchestration over the Phase 4 browser validator; do not duplicate geometry/text/context checks.

- [ ] Start the instrumented app only in operator-approved execution mode.
- [ ] Require the attribute to exist exactly once, be visible, have non-zero bounds, and lie within the comparison root.
- [ ] Compare normalized text overlap when the Figma candidate has text.
- [ ] Check configurable but deterministic geometry, relative-position, parent, and sibling plausibility thresholds.
- [ ] Reject a card-to-icon mapping even when AI confidence is high.
- [ ] Emit a complete `RuntimeBindingValidation` record with every boolean check and reason.
- [ ] Set status to `validated` only when both static and runtime validation pass.
- [ ] Keep manual bindings on the same validator and status transition as AI proposals.

v0.1 requires one visible runtime element per binding. Explicit multiplicity support is deferred rather than guessed.

## Task 5.7 — Implement `index-source`, `bind`, and `validate-bindings`

- [ ] `index-source` writes the bounded source index and statistics without executing the app.
- [ ] `bind` writes proposals and static-validation results; it never edits source.
- [ ] `validate-bindings` runs only eligible proposals and updates statuses in a new artifact atomically.
- [ ] Existing validated manual bindings remain usable when no provider is configured.
- [ ] Re-running with unchanged inputs yields stable IDs and artifact hashes.
- [ ] A binding review summary lists proposed, validated, review-required, rejected, and unresolved nodes.

## 실제 검증 명령

```bash
pnpm --filter @design-convergence/binding test
pnpm --filter @design-convergence/ai test
pnpm --filter @design-convergence/instrumentation test
pnpm design-convergence index-source
pnpm design-convergence bind --case pricing-desktop --provider mock
pnpm design-convergence validate-bindings --case pricing-desktop
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Tests use only mock provider output and local browser/Figma fixtures. A separate opt-in smoke command may exercise a real provider, but it is not a required CI gate.

현재 문서-only 상태에는 해당 package/commands가 없으므로 이 명령은 Phase 5 구현 PR에서만 실행 가능하다.

## Milestone 2 exit gate

- The example Pricing Card receives a valid AI proposal from the mock provider.
- Low-confidence, invented, stale, conflicting, duplicate, invisible, and geometrically implausible proposals never become `validated`.
- Validated metadata is deterministic and reusable on later runs.
- AI failure leaves manual comparison available.
- Automatic patching remains disabled for every non-validated binding.

## 다음 phase 진입 게이트

Phase 6는 validated binding artifact와 exact source/browser hashes가 있고 manual/no-provider comparison도 계속 통과할 때만 시작한다.

## 의도적 보류

- 자동 patch 생성과 AI 성공 판정은 구현하지 않는다.
- arbitrary runtime output prediction, dynamic class execution, binding multiplicity는 지원하지 않는다.
- real-provider smoke는 opt-in이며 CI gate가 아니다.
