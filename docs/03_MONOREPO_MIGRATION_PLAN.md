# 03. 모노레포 마이그레이션 플랜

## 목표

현재 `v0.9.0` npm 패키지와 CLI를 깨지 않고 저장소를 모노레포로 바꾼다.
마이그레이션과 새 기능 구현을 한 PR에 섞지 않는다.

---

## 1. 릴리스 전략

권장 버전 계획:

| 버전 | 목표 |
|---|---|
| `v0.9.0` | 현재 baseline |
| `v0.10.0` | 모노레포 이동 및 parser extraction, 사용자 기능 변화 없음 |
| `v0.11.0` | versioned QA IR / StudySpec compiler experimental |
| `v0.12.0` | direct Playwright single-session runtime |
| `v0.13.0` | persona policy + multi-session + validity |
| `v0.14.0` | findings + HTML report |
| `v0.15.0` | baseline/candidate + GitHub report |
| `v1.0.0` | stable contracts, compatibility policy, production-ready local/CI runtime |

repo 이름 변경은 `v0.15` 이전에는 하지 않는다.
현재 링크와 GitHub 인지도를 유지한다.

---

## 2. PR M0 — Baseline freeze

### 작업

- `v0.9.0` 기준 compatibility fixture 생성
- 현재 CLI 명령별 exit code 기록
- 생성 JSON fixture 저장
- annotation/live policy golden fixture 고정
- release workflow dry-run 문서화
- current artifact naming snapshot

### 산출물

```text
tests/compat/v0.9/
  fixtures/
  expected/
  run-legacy-cli.test.ts

docs/migration/v0.9-baseline.md
```

### Acceptance Criteria

- 기존 테스트 전부 통과
- 최소 `spec`, `abstract-ai`의 JSON 구조 golden test
- Hermes binary가 없는 CI에서도 pure normalization test 수행 가능
- secrets가 fixture에 포함되지 않음

---

## 3. PR M1 — Workspace scaffold

### 목표 구조

```text
package.json                 # private root
pnpm-workspace.yaml
packages/
  playwright-spec-for-ai-agent/
    package.json
    bin/
    scripts/
    examples/
    README.md
```

### root package

```json
{
  "name": "playwright-spec-for-ai-agent-workspace",
  "private": true,
  "packageManager": "pnpm@10",
  "scripts": {
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "build": "pnpm -r build"
  }
}
```

### 보존 조건

- npm package name 유지
- bin path 유지
- command name 유지
- package `files` 결과 확인
- README와 CHANGELOG 포함
- Node `>=20` 유지
- provenance publish 유지

### Lockfile

현재 `pnpm-lock.yaml`과 `package-lock.json`이 함께 존재한다.

마이그레이션 PR에서는 삭제와 이동을 섞지 않는다.

권장:

1. M1에서 pnpm을 canonical package manager로 선언한다.
2. 기존 release와 설치 재현 테스트를 수행한다.
3. 별도 cleanup PR에서 `package-lock.json`을 제거한다.
4. README에 Corepack/pnpm 사용법을 기록한다.

---

## 4. PR M2 — Release pipeline migration

현재 root package용 release-please 설정을 package path로 옮긴다.

예:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    "packages/playwright-spec-for-ai-agent": {
      "release-type": "node",
      "component": "playwright-spec-for-ai-agent",
      "changelog-path": "CHANGELOG.md",
      "include-component-in-tag": false,
      "include-v-in-tag": true
    }
  }
}
```

manifest:

```json
{
  "packages/playwright-spec-for-ai-agent": "0.9.0"
}
```

publish workflow:

```yaml
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4
  with:
    node-version: "20"
    cache: "pnpm"
    registry-url: "https://registry.npmjs.org"
- run: pnpm install --frozen-lockfile
- run: pnpm test
- run: pnpm --filter playwright-spec-for-ai-agent publish --provenance --access public
```

실제 release-please output 이름은 action 문서와 generated output을 검증한 뒤 적용한다.
output key를 추측해 production workflow를 작성하지 않는다.

### Rollback

- package path 이전 release tag 유지
- publish 실패 시 npm version을 다시 올리기 전에 원인 수정
- 같은 version 재게시 시도 금지
- release PR과 runtime feature PR 분리

---

## 5. PR M3 — Adapter extraction

새 package:

```text
packages/playwright-spec-adapter/
```

초기 API:

```ts
export interface ParsePlaywrightSpecsOptions {
  specDir: string;
  page?: string;
}

export function parsePlaywrightSpecs(
  options: ParsePlaywrightSpecsOptions,
): PlaywrightScenarioIR;

export function compilePlaywrightIRToStudy(
  ir: PlaywrightScenarioIR,
  options: CompileOptions,
): StudySpec;
```

이동 대상:

- annotation parser
- fixture resolution
- live policy mapping
- test/describe extraction
- expectation parser
- expectation abstraction
- live skip filter

기존 파일 경로에는 compatibility re-export 또는 thin wrapper를 둔다.

```js
export * from "@workspace/playwright-spec-adapter/legacy";
```

M3에서는 AST parser를 구현하지 않는다.
기존 regex behavior를 그대로 옮겨 regression risk를 줄인다.

---

## 6. PR M4 — Contracts package

```text
packages/contracts/
```

추가:

- `qa-ir/0.1`
- `study-spec/0.1`
- `evidence/0.1`
- validation error
- schema registry
- JSON Schema generation
- migration function placeholder

기존 adapter output을 `QA IR`로 serialize한 뒤 golden test와 비교한다.

---

## 7. PR M5 — New runtime skeleton

```text
packages/runtime-core/
packages/playwright-driver/
apps/persona-runtime-cli/
```

처음에는 다음만 지원한다.

```bash
pnpm persona-runtime run ./examples/simple-onboarding/study.yaml
```

- single task
- single persona
- one seed
- local filesystem store
- no GitHub
- no analytics
- no remediation

---

## 8. Compatibility package 전략

기존 package는 다음 역할을 유지한다.

```text
playwright-spec-for-ai-agent
- current commands
- current config
- Hermes integration
- Slack integration
- Playwright spec import
```

새 package/CLI:

```text
persona-runtime
- canonical StudySpec
- direct Playwright runtime
- personas
- evidence
- behavioral findings
- comparison
```

초기에는 두 package를 억지로 하나로 합치지 않는다.

추후 기존 package에 optional bridge command를 추가할 수 있다.

```bash
playwright-spec-for-ai-agent behavioral --page=pricing
```

이는 내부적으로 `persona-runtime`을 호출하되,
설치되지 않았으면 명확한 안내를 제공한다.

기본 기존 command 동작은 변경하지 않는다.

---

## 9. Source file mapping

```text
bin/playwright-spec-for-ai-agent.mjs
→ packages/playwright-spec-for-ai-agent/bin/playwright-spec-for-ai-agent.mjs

scripts/dashboard-spec-parser.mjs
→ packages/playwright-spec-adapter/src/legacy/regex-parser.ts
  + compatibility wrapper

scripts/expectation-abstractor.mjs
→ packages/playwright-spec-adapter/src/expectation/abstractor.ts

scripts/spec-live-filter.mjs
→ packages/playwright-spec-adapter/src/policy/live-filter.ts

scripts/qa-spec-artifacts.mjs
→ packages/playwright-spec-for-ai-agent/scripts/qa-spec-artifacts.mjs
  (MVP에서는 legacy 위치 유지)

scripts/hermes-runner.mjs
→ packages/playwright-spec-for-ai-agent/scripts/hermes-runner.mjs
  + later packages/model-provider-hermes

scripts/run-hermes-*.mjs
→ legacy package 유지

scripts/__tests__/*
→ packages/playwright-spec-for-ai-agent/tests/compat/*
  또는 source package 옆 tests
```

---

## 10. Import compatibility

현재 scripts가 상대 경로 import에 크게 의존하므로 한 번에 이동하면 위험하다.

순서:

1. package 전체를 경로만 이동하고 import를 자동 수정한다.
2. 테스트 통과를 확인한다.
3. parser module만 adapter package로 추출한다.
4. 기존 script에 thin wrapper를 둔다.
5. wrapper removal은 `v1` 이후 deprecation policy에 따른다.

---

## 11. Deprecation policy

- `v0.x` 동안 기존 command 삭제 금지
- 최소 두 minor release 동안 warning
- release note에 migration guide 포함
- alias 또는 wrapper 제공
- config field rename 시 old/new 둘 다 parse
- artifact field 제거 대신 optional/deprecated 처리
- `v1.0`에서 stable contract 선언 전 migration tool 제공

---

## 12. 마이그레이션 검증 명령

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm --filter playwright-spec-for-ai-agent pack
npm install ./playwright-spec-for-ai-agent-*.tgz
npx playwright-spec-for-ai-agent --help
npx playwright-spec-for-ai-agent spec --page=fixture
```

pack 결과에서 반드시 확인:

- bin included
- scripts included
- README included
- example config included
- unintended secrets/artifacts excluded
- workspace-only paths가 런타임에서 필요하지 않음

---

## 13. 실패 시 되돌리는 기준

다음 중 하나면 새 기능 PR을 중단하고 migration을 먼저 수정한다.

- npm tarball에서 CLI 실행 불가
- release-please가 root package를 잘못 bump
- existing config path resolution 변경
- existing artifact path 변경
- current policy classification 변경
- stateless Hermes cleanup 누락
- package install에 workspace protocol이 남음
- CI와 local 결과 불일치

마이그레이션은 새 Runtime 기능의 선행 조건이지, 동시에 구현하는 작업이 아니다.
