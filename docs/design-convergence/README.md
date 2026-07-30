# Design Convergence 구현 계획

Design Convergence는 Figma 노드를 React 렌더 경계에 바인딩하고, 정규화된 디자인 속성을 브라우저의 최종 computed style/layout box와 비교한 뒤, 검증된 CSS 중심 패치만 수용하는 evidence-driven 런타임이다.

이 문서는 구현 순서를 나눈 상위 인덱스다. 현재 저장소에는 아직 Design Convergence 코드가 없으므로, 아래 명령은 각 phase가 해당 패키지와 스크립트를 만든 뒤에만 실행 가능하다.

## 저장소 기준 결정

- 구현 위치: 기존 pnpm/turbo monorepo 내부.
- 앱 위치: `apps/design-convergence`.
- 패키지 위치: `packages/design-convergence-*`.
- 초기 패키지: `packages/design-convergence-shared`, `packages/design-convergence-config`, `packages/design-convergence-figma`, `apps/design-convergence`만 순차 생성.
- 공개 전까지 모든 신규 workspace는 `private: true`로 유지한다.
- Changesets는 공개 릴리스 또는 기존 published package 변경 때만 적용한다.
- Phase 10에서 `design-convergence`와 `@design-convergence/config`만 공개하고 나머지 runtime workspace는 private로 유지한다.
- 기존 MJS persona/runtime packages에 직접 결합하지 않는다. 재사용 대상은 검증된 불변조건, 테스트 스타일, evidence/provenance 사고방식뿐이다.

## 문서 순서

| 순서 | 문서 | 구현 범위 | 상태 |
| --- | --- | --- | --- |
| 00 | [저장소 적합성 및 작업 원칙](./00-repository-fit.md) | 현재 monorepo 구조, 릴리스 정책, 패키지 경계, 첫 수직 슬라이스 정의 | 작성됨 |
| 01 | [기초 구조, 설정, 계약](./01-foundation-config-contracts.md) | TypeScript 기반 CLI/config/shared contract, secret/path/provenance/error taxonomy | 작성됨 |
| 02 | [Figma fixture와 manual binding](./02-figma-manual-bindings.md) | raw fixture, REST mock, cache, normalization, candidate selection, `design-bindings.json`, static validation | 작성됨 |
| 03 | [Test-only instrumentation과 예제 앱](./03-instrumentation-example.md) | 조건부 Babel transform, Next.js pricing fixture, production 미주입 증명 | 작성됨 |
| 04 | [브라우저 추출과 결정론적 diff](./04-browser-normalization-diff.md) | Playwright, rendered style tree, 정규화, diff, JSON/터미널 출력 | 작성됨 |
| 05 | [React index와 AI binding 검증](./05-ai-binding-validation.md) | source index, AI provider, proposal schema, static/runtime validation | 작성됨 |
| 06 | [Source attribution과 cause grouping](./06-attribution-cause-grouping.md) | CDP, CSS/CSS Modules/Tailwind attribution, shared cause grouping | 작성됨 |
| 07 | [패치 정책과 AI patch proposal](./07-patch-policy-agent.md) | narrowed evidence, structured edit, allowed/forbidden policy | 작성됨 |
| 08 | [격리 worktree와 결정론적 검증](./08-worktree-verification.md) | patch 적용, configured checks, target/full-suite regression gate | 작성됨 |
| 09 | [리포트, CLI, GitHub draft PR](./09-reporting-github-cli.md) | JSON/HTML/Markdown, 전체 command, accepted-only PR | 작성됨 |
| 10 | [하드닝과 공개 릴리스](./10-hardening-release.md) | 통합 fixture, 보안 matrix, 문서, package smoke, Changesets | 작성됨 |

## Phase gates와 milestone mapping

| Phase | Gate | 통과 조건 | 원본 milestone |
| --- | --- | --- | --- |
| 00 | Fit gate | 현재 repo 구조와 신규 package 경계가 문서화됨 | 준비 단계 |
| 01 | Foundation gate | config/schema/error/provenance/path/security contracts가 테스트 가능하게 정의됨 | Milestone 1 |
| 02 | Figma/manual binding gate | live Figma token 없이 fixture-backed normalized Figma node와 manual binding static validation이 동작함 | Milestone 1 |
| 03 | Instrumentation gate | test build에만 정확한 attribute가 들어가고 production build에는 들어가지 않음 | Milestone 1 |
| 04 | First vertical slice gate | `pricing-desktop`이 runtime binding 검증 후 layout/computed style diff를 JSON/터미널로 출력함 | Milestone 1 |
| 05 | AI binding gate | AI proposal은 static/runtime validation 전까지 trusted state가 아님을 보장함 | Milestone 2 |
| 06 | Attribution gate | padding mismatch가 source file/declaration에 연결되고 반복 mismatch가 group으로 묶임 | Milestone 3 |
| 07 | Proposal gate | AI patch output이 source hash와 patch policy를 통과해야만 적용 후보가 됨 | Milestone 4 |
| 08 | Verification gate | good patch accept, regression patch reject가 격리 worktree에서 재현됨 | Milestone 4 |
| 09 | PR gate | accepted patch만 branch/commit/draft PR에 포함되고 evidence가 연결됨 | Milestone 5 |
| 10 | Release gate | 3개 example, 보안/운영/changeset/public package 기준을 만족함 | 최종 전달 |

## 첫 수직 슬라이스

처음 구현할 경로는 AI 없이 닫힌 데이터로 끝까지 연결한다.

```text
Example Next.js pricing page
→ fixture-backed Figma Pricing Card node
→ manually authored design-bindings.json
→ test-only data-design-node injection
→ Playwright render
→ computed style + layout box extraction
→ height, padding, background, radius, font-size, font-weight, text-color diff
→ JSON and terminal report
```

목표 명령은 Phase 04 gate 이후에만 실행 가능하다.

```bash
pnpm design-convergence run --case pricing-desktop
```

## 명령 위험 분류

| 등급 | 예 | 정책 |
| --- | --- | --- |
| Data-only | config parse, schema validation, fixture normalization, source indexing, diff from saved artifacts | 기본 자동 실행 가능. 네트워크, app command, Git write 없음. |
| Operator-approved execution | app start command, Playwright live render, Figma REST fetch, patch verification, Git worktree/branch/PR | 명시 config와 operator 승인 필요. 토큰/쿠키/환경변수는 로그와 AI prompt에서 redaction. |
| Forbidden by default | AI 생성 shell command, destructive Git, tolerance 증가로 failure 숨기기, Figma artifact 수정, binding 삭제로 pass 만들기 | 구현하지 않는다. 예외는 별도 문서와 명시 승인 후에만 추가한다. |

## 요구사항 추적

| 요구사항 묶음 | 구현 phase |
| --- | --- |
| 저장소 구조, config, versioned schema, 오류/로그/보안 경계 | 00~01 |
| Figma REST/cache/candidate/absorption/manual binding | 02 |
| test-only Babel instrumentation과 Next.js pricing example | 03 |
| Playwright 안정화, computed style/layout, 정규화, tolerance/severity/metrics, raw JSON report | 04 |
| React AST index, provider abstraction, AI proposal, static/runtime binding validation | 05 |
| CDP/CSS Modules/Tailwind attribution과 shared-cause grouping | 06 |
| narrowed CSS-oriented proposal과 patch policy | 07 |
| disposable worktree, configured checks, target/full-suite verification과 regression rejection | 08 |
| HTML/JSON/Markdown report, 전체 CLI, draft PR | 09 |
| examples, fixture/security matrix, 필수 사용자 문서, package/release smoke | 10 |

범위 밖 항목(DOM 구조, 접근성, 제품 동작, pixel screenshot 비교, 복잡한 SVG/canvas/video)은 00과 10의 제한 사항으로 유지한다.

## 실행 규칙

1. 문서 번호 순서대로 구현한다.
2. 각 문서의 **exit gate**와 root 검증 명령이 통과하기 전에는 다음 phase를 시작하지 않는다.
3. 각 체크박스 묶음은 실패 테스트 → 최소 구현 → package gate → root gate 순서의 한 reviewable increment다.
4. 실제 출력과 명령 증거가 없는 완료 표시는 허용하지 않는다.

## 문서 작성 검증 상태

- 저장소 구조 확인: `CLAUDE.md`, root `README.md`, `package.json`, `pnpm-workspace.yaml`, `turbo.json`, 기존 app/package README를 읽었다.
- 구현 명령 검증: 아직 관련 workspace가 없으므로 실행하지 않았다.
- 이 문서는 구현 계획이며 코드 완료 보고가 아니다.
