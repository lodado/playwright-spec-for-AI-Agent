# 10. 하드닝, 통합 fixture, 공개 릴리스 구현 계획

## 목표

`design-convergence`를 MVP에서 공개 가능한 v0.1로 올리기 위해 통합 fixture, 보안/성능 검증, 사용자 문서, root smoke, changeset 릴리스 절차를 완성한다.

핵심 불변식:

> 최종 릴리스는 동작하는 범위와 알려진 한계를 명확히 문서화하고, 검증되지 않은 AI binding 또는 CSS patch를 신뢰하지 않는다.

## 선행 조건

- 01~09 단계가 최소 vertical slice와 patch/report/PR 흐름을 제공한다.
- root workspace scripts와 package publishing 정책은 `CLAUDE.md`의 Changesets 규칙을 따른다.
- 공개 package와 private package 경계가 결정되어 있다.
- 실제 CLI command와 report output이 로컬 fixture에서 재현 가능하다.

## 생성/수정 예정 파일

필요해질 때만 생성한다.

```text
examples/design-convergence-next-tailwind/
examples/design-convergence-react-css-modules/
examples/design-convergence-storybook/

fixtures/design-convergence/
  figma/
  browser/
  bindings/
  diffs/
  patches/
  reports/
  security/

scripts/design-convergence-package-smoke.mjs
scripts/design-convergence-fixture-smoke.mjs

.changeset/<release-name>.md
```

수정 후보:

```text
README.md
CLAUDE.md
package.json
pnpm-workspace.yaml
apps/design-convergence/README.md
packages/design-convergence-*/README.md
docs/design-convergence/architecture.md
docs/design-convergence/binding.md
docs/design-convergence/configuration.md
docs/design-convergence/limitations.md
docs/design-convergence/contributing.md
```

## 작은 체크박스 작업

### 1. 통합 fixture를 점진적으로 추가

- [ ] Phase 03의 Next.js + Tailwind fixture를 full vertical slice와 accepted/rejected patch-loop까지 확장한다.
- [ ] CSS Modules fixture는 padding, radius, color attribution을 검증한다.
- [ ] Storybook fixture는 route가 아닌 component case 설정을 검증한다.
- [ ] 각 fixture는 하나의 known-bad style과 하나의 expected accepted patch를 가진다.
- [ ] fixture별 README는 실행 command와 expected artifact path만 포함한다.

### 2. 보안/adversarial matrix

- [ ] path traversal edit 시도
- [ ] symlink escape 시도
- [ ] forbidden glob 수정 시도
- [ ] `.env` prompt leakage 시도
- [ ] AI command injection 시도
- [ ] tolerance 증가 또는 binding 삭제 패치 시도
- [ ] HTML report script injection 시도
- [ ] Markdown mention/comment injection 시도
- [ ] GitHub non-draft PR 또는 default branch push 시도
- [ ] source hash mismatch와 stale binding 시도
- [ ] executable config syntax와 unapproved prepare/app command 시도
- [ ] Figma redirect/oversized payload/token leakage와 layer-name prompt injection 시도
- [ ] source comment prompt injection, invented file/component/range, provider secret echo 시도
- [ ] CDP/source-map remote URL와 root escape attribution 시도
- [ ] verification timeout/output overflow/mutating check/secret env theft 시도
- [ ] wrong Git remote/revision, unsafe branch, accepted artifact tampering 시도

각 항목은 자동 테스트 또는 fixture smoke로 PASS/FAIL을 남긴다.

별도 OS/container/VM 격리가 없는 v0.1은 operator-approved checkout만 실행 대상으로 지원한다. 문서와 CLI 경고에 이 한계를 명시하고 arbitrary third-party repository의 안전한 host 실행을 주장하지 않는다.

### 3. 필수 회귀 matrix 완성

- [ ] Unit: color/length/font weight/shadow/geometry normalization, tolerance, severity, score.
- [ ] Unit: candidate selection/absorption, React index, confidence gate/conflict, transform, diff, cause group, patch policy, error classification.
- [ ] Fixture: exact match, size, padding, font, color, border, radius, shadow, unsupported.
- [ ] Fixture: missing browser element, stale binding, duplicate runtime binding, invalid source location.
- [ ] Patch loop: known-bad button → mock proposal → isolated apply → target improves → full suite passes → accepted.
- [ ] Regression loop: target improves → another case worsens → full suite detects → rejected.
- [ ] Snapshot은 versioned serialized schema와 작은 stable report fragment에만 사용하고 semantic correctness는 explicit assertion으로 검증한다.

### 4. 성능과 budget

- [ ] Figma fetch cache hit/miss 시간을 기록한다.
- [ ] source index file count와 parse 시간을 기록한다.
- [ ] Playwright case별 render/extract 시간을 기록한다.
- [ ] AI prompt token estimate와 redacted byte size를 기록한다.
- [ ] report input size와 HTML size 상한을 둔다.
- [ ] 대형 fixture에서 timeout이 infrastructure failure로 분류되는지 검증한다.

초기 측정/guardrail 기준(실제 CI 측정 후 조정하고 tolerance처럼 결과를 숨기는 용도로 쓰지 않음):

```text
single-case vertical slice: 60초 이하
source index fixture: 1,000 files 이하에서 30초 이하
HTML report: 기본 10MB 이하
AI prompt payload: provider별 configured byte limit 이하
```

### 5. 필수 사용자 문서

- [ ] README: 무엇을 하는지와 하지 않는지
- [ ] README: 설치와 Figma token setup
- [ ] README: configuration example
- [ ] README: binding workflow와 comparison workflow
- [ ] README: patch verification rules
- [ ] README: report 예시와 보안 모델
- [ ] README: supported frameworks와 known limitations
- [ ] `docs/design-convergence/architecture.md`
- [ ] `docs/design-convergence/binding.md`
- [ ] `docs/design-convergence/configuration.md`
- [ ] `docs/design-convergence/limitations.md`
- [ ] `docs/design-convergence/contributing.md`
- [ ] `CLAUDE.md`: 새 package 검증 command와 changeset reminder

README에는 다음 positioning을 그대로 포함한다.

```text
Design Convergence is an evidence-driven runtime that binds Figma nodes to React render boundaries, compares normalized design properties with final browser-computed styles, and produces verified CSS-oriented patches.
```

또한 다음 문장을 포함한다.

```text
It is not a Figma-to-code generator and does not validate DOM structure or product behavior.
```

### 6. root scripts와 package smoke

- [ ] root `package.json`에 design-convergence smoke script를 추가한다.
- [ ] package smoke는 packed CLI가 `--help`를 실행하는지 검증한다.
- [ ] fixture smoke는 Next+Tailwind 최소 case가 JSON report를 생성하는지 검증한다.
- [ ] 기존 root `pnpm package:smoke`가 두 기존 smoke 뒤에 Design Convergence CLI/config pack smoke를 실행하도록 연결한다.
- [ ] root `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`가 design-convergence workspace를 포함하도록 한다.
- [ ] `.github/workflows/pr-regression.yml`과 `release.yml`의 Chromium install을 `@design-convergence/browser` integration tests도 충족하도록 갱신한다.

### 7. 공개 릴리스 변경

- [ ] 공개 package는 CLI `design-convergence`와 config authoring API `@design-convergence/config` 두 개로 고정한다. 두 이름의 npm 예약이 code 작성 초기에 끝나 있어야 한다(00의 npm 이름 결정 참조). 예약이 안 됐으면 publish 전에 중단한다.
- [ ] `@design-convergence/config`는 private workspace에 runtime 의존하지 않는 standalone publish artifact로 만들고 사용자 예제의 import를 그대로 보장한다.
- [ ] 나머지 `@design-convergence/*` workspace는 private로 유지하고 CLI bundle에 필요한 코드만 포함한다.
- [ ] private-only package는 `private: true`와 publish 제외 상태를 유지한다.
- [ ] 공개 package는 `files`, `bin`, `exports`, `engines`, `license`를 확인한다.
- [ ] `pnpm pack` 산출물에 secrets, token fixture, 임시 artifacts가 없는지 확인한다.
- [ ] published package를 변경하는 PR에는 `.changeset/<release-name>.md`를 추가한다.
- [ ] `pnpm changeset version` 결과를 커밋한다.
- [ ] root README와 `CLAUDE.md`의 “두 published packages” 설명을 네 package 체계로 갱신하고 두 신규 package의 release gate를 적는다.

### 8. 최종 delivery checklist

- [ ] working monorepo
- [ ] typed public APIs
- [ ] versioned schemas
- [ ] CLI commands
- [ ] manual binding support
- [ ] AI-assisted binding support
- [ ] test-only instrumentation
- [ ] Figma extraction
- [ ] browser style extraction
- [ ] deterministic diffing
- [ ] source attribution
- [ ] CSS patch proposals
- [ ] isolated verification
- [ ] regression protection
- [ ] HTML and JSON reports
- [ ] optional GitHub draft PR
- [ ] unit and integration tests
- [ ] example applications
- [ ] limitations and security documentation

### 9. 최종 구현 완료 보고 template

릴리스 구현자는 vague completion claim 대신 아래 순서로 실제 evidence를 채운다.

1. Architecture summary와 invariant 보존 방식.
2. 생성/수정한 exact files와 package 목록.
3. 실행한 exact verification commands.
4. command별 실제 pass/fail/skip count와 infrastructure note.
5. Known limitations와 지원하지 않는 framework/style/Figma feature.
6. Recommended next milestone.
7. 완료하지 못한 요구사항, blocker, honest reason.

실행하지 않은 command를 green으로 쓰거나 pseudocode를 구현 완료로 표시하지 않는다.

## 테스트 우선 절차

1. Next+Tailwind vertical slice fixture test를 먼저 안정화한다.
2. CSS Modules attribution fixture를 추가하고 regression 없는지 확인한다.
3. Storybook component case fixture를 추가한다.
4. 보안/adversarial matrix를 fixture-driven tests로 추가한다.
5. package smoke script를 작성하고 packed CLI `--help`를 검증한다.
6. README command를 실제로 실행한 뒤 문서에 반영한다.
7. changeset versioning dry run 대신 실제 Changesets flow를 PR에서 수행한다.

## 실제 검증 명령

릴리스 후보 PR에서 실행한다.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm package:smoke
pnpm design-convergence --help
pnpm design-convergence run --case pricing-desktop
pnpm design-convergence converge --case pricing-desktop --provider mock --max-iterations=1
pnpm --filter design-convergence pack
pnpm --filter @design-convergence/config pack
```

문서 command는 구현 후 실제 출력으로 README에 반영한다. 현재 문서 단계에서는 구현되지 않은 `design-convergence` command를 실행하지 않는다.

## 종료 게이트

- 세 가지 integration fixture가 CI에서 통과한다.
- 보안/adversarial matrix가 자동 검증된다.
- root build/typecheck/lint/test/package smoke가 통과한다.
- README와 package README의 command가 실제로 실행된 출력과 일치한다.
- public release package에 changeset과 version bump가 포함된다.
- known limitations가 현재 구현 범위를 정확히 설명한다.

## 공개 릴리스 진입 게이트

- unresolved critical regression 0개인 fixture run이 존재한다.
- accepted patch와 rejected patch evidence가 report에 모두 나타난다.
- GitHub draft PR flow가 fake transport와 선택적 real dry-run repository에서 검증된다.
- Figma token, AI token, GitHub token이 artifact/report/log에 남지 않는다는 테스트가 통과한다.
- `CLAUDE.md`가 design-convergence 검증 command와 release rule을 최신 상태로 유지한다.
- packed CLI/config tarball에 private source, `.env`, cache, run artifacts, token fixture가 없다는 smoke가 통과한다.

## 의도적 보류

- full SVG path equivalence, canvas, video, mesh gradients는 v0.1에서 제외한다.
- SWC/Vite instrumentation adapter는 Babel plugin이 한계에 도달한 뒤 추가한다. Next.js v0.1 지원은 조건부 Babel integration 범위로 정직하게 표기하고, `next/font` 미사용과 known-good Next minor 버전 핀을 `limitations.md`에 적는다.
- Tailwind는 3.x만 지원한다. v4 CSS-first config 모델은 별도 phase로 미룬다.
- baseline/triage 워크플로(`acknowledged` diff status)는 v0.1 동작으로 구현하지 않지만 schema slot은 예약한다. 레거시 페이지 도입 시 tolerance 조작 없이 known mismatch를 승인하는 로드맵 항목으로 `limitations.md`에 명시한다.
- remote artifact upload와 GitHub Checks API는 draft PR evidence link만으로 부족할 때 추가한다.
- visual pixel comparator는 만들지 않는다. screenshots는 보조 증거로만 유지한다.
- accessibility, DOM hierarchy, product behavior validation은 별도 도구 책임으로 남긴다.
