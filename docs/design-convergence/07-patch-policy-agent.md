# 07. 패치 정책과 AI 패치 에이전트 구현 계획

## 목표

`design-convergence`의 패치 단계가 좁혀진 증거만 AI에 전달하고, AI 출력은 엄격한 스키마와 정책 검사를 통과한 뒤에만 격리 검증 단계로 넘기도록 구현한다.

핵심 불변식:

> AI는 CSS 중심 패치를 제안할 수 있지만, 명령 실행·성공 판정·허용 파일 결정은 절대 하지 않는다.

## 선행 조건

- 01~06 단계에서 다음 산출물이 존재한다.
  - `CanonicalStyleNode`와 `StyleDiff` 스키마
  - 검증된 `DesignBinding`
  - 소스 attribution 결과
  - cause grouping 결과
  - artifacts run 디렉터리와 schemaVersion 정책
- 설정 패키지는 `patching.allowedGlobs`, `patching.forbiddenGlobs`, `patching.cssOnly`, `patching.allowJsxClassNameChanges`, `patching.allowStructuralJsxChanges`를 검증한다.
- 자동 proposal 대상은 validated binding과 singular/high-confidence source attribution을 가진 cause group으로 제한한다.
- QA Native의 remediation/reporter 안전 패턴을 참고하되, `apps/playwright-spec-for-ai-agent/**`의 domain-specific `.mjs` 구현에 결합하지 않는다.

## 생성/수정 예정 파일

Phase 05에서 만든 AI package는 확장하고 patching package만 새로 생성한다.

```text
packages/design-convergence-ai/
  src/patch-schema.ts
  test/patch-provider.test.ts

packages/design-convergence-patching/
  package.json
  src/index.ts
  src/patch-task.ts
  src/policy.ts
  src/source-hash.ts
  src/structured-edits.ts
  src/tailwind-static-class.ts
  test/policy.test.ts
  test/source-hash.test.ts
  test/structured-edits.test.ts
  fixtures/eligible-button.patch.json
  fixtures/rejected-command-attempt.json
```

수정 후보:

```text
packages/design-convergence-config/src/schema.ts
packages/design-convergence-shared/src/schemas.ts
```

## 작은 체크박스 작업

### 1. 패치 입력 모델 고정

- [ ] `PatchTask` Zod 스키마를 추가한다.
- [ ] 입력은 `DiffCauseGroup`, 관련 파일 content, source hash, 제한된 related context만 포함한다.
- [ ] related context는 bound component excerpt, statically read existing design tokens, bounded Tailwind config text만 허용하고 config를 실행하지 않는다. v0.1은 Tailwind 3.x의 정적 JS/TS config를 전제로 핀한다. Tailwind v4의 CSS-first `@theme`/cascade-layer 모델은 정적 파싱과 CDP matched-rule 해석 양쪽에 영향을 주므로 `limitations.md`에 미지원으로 명시하고 별도 phase로 미룬다.
- [ ] `.env`, 토큰, 쿠키, 전체 저장소 tree, unrelated files는 입력에 포함하지 않는다.
- [ ] source hash는 `sha256:<hex>` 형식으로 저장한다.
- [ ] task는 exact Git base revision과 각 file blob hash를 포함해 stale proposal을 적용 전에 식별한다.
- [ ] AI 전달 전 모든 텍스트에 redaction을 적용한다.

### 2. 기존 AI Provider의 patch method 완성

- [ ] Phase 05의 `AIProvider.proposePatch()`를 strict patch schema와 연결한다.
- [ ] core deterministic packages는 provider 구현을 import하지 않는다.
- [ ] mock provider에 known-good/known-bad patch fixture를 추가해 테스트가 네트워크 없이 통과하게 한다.
- [ ] OpenAI-compatible provider는 base URL, model, API key env name만 설정에서 받는다.
- [ ] provider 응답은 raw text가 아니라 strict structured output으로만 받는다.

### 3. 패치 출력 스키마 추가

- [ ] `PatchProposalOutput` Zod 스키마를 추가한다.
- [ ] 허용 출력은 `summary`, `edits[]`, `expectedEffects[]`, `risks[]`로 제한한다.
- [ ] v0.1 `edits[]`는 `{ filePath, baseHash, replacements, reason }` 형태의 structured exact-text edit만 허용한다.
- [ ] 각 replacement는 bounded `oldText`, `newText`, `occurrence`를 가지며 old text가 정확히 한 target으로 해석되지 않으면 적용 단계에서 거부한다.
- [ ] unified diff 입력은 두 번째 실제 필요가 생길 때까지 지원하지 않는다.
- [ ] shell command, package install, tolerance 변경, binding 삭제, Figma artifact 수정 필드를 거부한다.
- [ ] AI 응답이 “성공했다”는 문구를 포함해도 상태로 저장하지 않는다.

### 4. 패치 정책 검사

- [ ] `allowedGlobs`와 `forbiddenGlobs`를 root-relative normalized path에 적용하고 forbidden match가 항상 우선하게 한다.
- [ ] path traversal, absolute path, null byte, root 밖 symlink 경로를 거부한다.
- [ ] `cssOnly: true`는 CSS 효과만 바꾸는 정책으로 정의한다: CSS/SCSS/CSS Module 선언, CSS 변수/기존 token, 정적 inline style 값, 정적 component variant style map만 허용한다.
- [ ] 예외로 `allowJsxClassNameChanges: true`이면 정적 Tailwind class string 변경을 허용한다.
- [ ] `allowStructuralJsxChanges: false`이면 JSX element 추가/삭제/순서 변경을 거부한다.
- [ ] product text, imports/dependencies, event handlers, data fetching, state, routing, auth, API logic 변화는 AST/text policy에서 거부한다.
- [ ] CSS 변수와 기존 design token 파일은 allowed globs에 들어온 경우에만 허용한다.
- [ ] config, tolerance, binding, fixture, artifact, lockfile, workflow, server/API/auth 경로는 default-deny 목록으로 둔다.
- [ ] file count, changed-line count, replacement bytes의 configurable hard limit를 넘으면 거부한다.

### 5. 정적 Tailwind class 예외

- [ ] binding source range에서 `className` expression을 찾는다.
- [ ] 문자열 literal, template literal without expressions, `clsx`/`classnames`의 정적 인자를 지원한다.
- [ ] Babel parse/generate 전후 AST를 비교해 허용된 class token 외 JSX 구조나 동작이 바뀌지 않았음을 증명한다.
- [ ] 동적 class generation은 `review-required`로 돌리고 자동 패치를 금지한다.
- [ ] 한 property에 여러 utility가 경쟁하면 ambiguity를 반환한다.

### 6. 패치 후보 저장

- [ ] 모든 policy-eligible 후보는 artifact 디렉터리에 schemaVersion과 함께 저장한다.
- [ ] policy-rejected 후보도 이유와 redacted model output hash를 저장한다.
- [ ] 후보 ID는 source hash와 cause group hash에서 결정적으로 만든다.

## 테스트 우선 절차

1. mock provider가 올바른 structured output을 반환하는 테스트를 먼저 작성한다.
2. invalid provider output fixtures를 추가하고 Zod가 거부하는지 확인한다.
3. allowed/forbidden glob 충돌 테스트를 작성한다.
4. `cssOnly`에서 TSX 구조 변경이 거부되는 테스트를 작성한다.
5. 정적 Tailwind class 변경만 예외 허용되는 테스트를 작성한다.
6. source hash mismatch가 패치 후보를 거부하는 테스트를 작성한다.
7. AI가 command field 또는 success status를 보내면 거부되는 테스트를 작성한다.

## 실제 검증 명령

구현 PR에서 실행한다.

```bash
pnpm --filter @design-convergence/ai test
pnpm --filter @design-convergence/ai typecheck
pnpm --filter @design-convergence/patching test
pnpm --filter @design-convergence/patching typecheck
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

현재 문서 단계에서는 위 패키지가 아직 없으므로 명령을 실행하지 않는다.

## 종료 게이트

- mock provider만으로 patch proposal 테스트가 통과한다.
- OpenAI-compatible adapter는 네트워크 없이 contract 테스트가 가능하다.
- AI 출력이 정책을 우회하는 fixture가 모두 거부된다.
- policy-eligible/rejected 후보 artifact가 source hash와 rejection reason을 포함한다.
- 패치 성공 여부를 나타내는 필드는 오직 검증 단계에서만 생성된다.

## 다음 단계 진입 게이트

08 단계로 진입하려면 다음이 필요하다.

- `PatchProposalOutput`이 deterministic validation을 통과한다.
- 각 edit가 root-relative path와 base hash를 가진다.
- 후보가 적용 가능한 형태로 직렬화된다.
- AI가 실행할 command를 제공할 수 없는 구조가 테스트로 보장된다.

## 의도적 보류

- 여러 AI provider의 고급 prompt 최적화는 보류한다.
- 동적 Tailwind class 분석 완전 지원은 보류한다.
- CSS-in-JS 런타임 평가와 styled-components rule rewrite는 보류한다.
- 패치 품질의 최종 판정은 이 단계에서 하지 않고 08 단계 검증으로 넘긴다.
