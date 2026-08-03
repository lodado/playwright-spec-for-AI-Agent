# Personaut 모듈 통합 + 공유 모듈 추출 — 구현 플랜

> **For agentic workers:** 이 플랜은 코드베이스 맥락이 전혀 없는 실행자를
> 전제로 씀. 태스크 순서대로, 체크박스(`- [ ]`) 단위로 실행. 각 Phase는
> 독립 PR이며 Phase 내부 태스크는 순서 의존 있음.
> 설계 근거: `docs/superpowers/specs/2026-08-03-personaut-module-consolidation-design.md`

**Goal:** personaut의 10개 워크스페이스 패키지를 앱 내부 파일로 평탄화하고,
두 앱(apps/personaut, apps/playwright-spec-for-ai-agent)이 중복 구현한
스펙 추출·canonical hash·DOM settle·redaction을 공유 패키지로 추출한다.

**Architecture:** 공유 = 워크스페이스 패키지 3개(hermes-transport 기존,
playwright-spec-extract 신규, qa-kit 신규). 앱별 해석·조립은 각 앱 소유.
personaut은 `apps/personaut/src/*.mjs` 평면 파일 + 조립 1개(index.mjs).

**Tech Stack:** Node >=20, ESM(.mjs), pnpm workspace, esbuild(번들),
node --test(personaut), vitest(playwright-spec-for-ai-agent), Changesets.

## Global Constraints (모든 태스크에 적용)

- 저장소 규칙: `AGENTS.md`가 `CLAUDE.md`보다 우선. 스펙 컴파일 경로를
  건드리므로 각 PR에서 AGENTS.md §2 동기화 매트릭스 해당 행 점검.
- 발행 패키지(`@lodado/personaut`, `playwright-spec-for-ai-agent`)를 바꾸는
  PR은 `.changeset/*.md` 필수. **`pnpm changeset version` 적용은 하지 말 것**
  — 버전 적용된 PR이 main에 머지되면 npm 자동 발행됨. changeset 파일만
  커밋하고 적용 시점은 저장소 소유자가 결정.
- 호환 브랜치 금지: 옮긴 파일의 원위치 shim을 남기지 않는다(re-export
  경유지는 소비자 import 유지 목적일 때만 허용, 플랜에 명시된 곳만).
- 스키마 버전 문자열·해시 입력이 되는 값은 바이트 단위로 보존.
  `RUNTIME_SESSION_SCHEMA_VERSION`("runtime-session/0.1")과 contracts
  `SESSION_VERSION`("session/0.1")은 서로 다른 계약 — 절대 통합 금지.
- 검증 명령:
  - personaut: `cd apps/personaut && node --test test/*.test.mjs`
  - qa-native: `cd apps/playwright-spec-for-ai-agent && pnpm test` (vitest run)
  - 발행 레이아웃: 각 앱에서 `npm pack --dry-run`
- 커밋: conventional commits (`feat:`/`fix:`/`refactor:`/`docs:`/`test:`).
- 실행 중 이 플랜과 실제 코드가 다르면(라인 번호, 심볼명) 코드가 정답 —
  같은 의도로 적응하되, 의미가 달라 적응 불가능하면 STOP하고 보고.

## 사전 확인된 사실 (실행자가 다시 조사할 필요 없음)

- `packages/playwright-spec-adapter/src/legacy/parser.mjs` 내용 전체:
  `export * from "../../../../apps/playwright-spec-for-ai-agent/scripts/dashboard-spec-parser.mjs";`
  — 대상 파일 없음(리네임됨). 이것 때문에 `apps/personaut/src/index.mjs`
  import 체인이 기동 시 죽음. 현 personaut 테스트도 이 때문에 실패 가능.
- 원래 대상은 현재의
  `apps/playwright-spec-for-ai-agent/scripts/playwright-spec-parser.mjs`이며
  필요한 두 심볼 다 export함: `parsePlaywrightSource`(363행),
  `parseSpecDirectory`(527행).
- abstractor 두 벌의 export 심볼은 완전 동일 7개:
  `ABSTRACTION_RULES_VERSION`, `liveRegexFromLiteral`,
  `literalExpectedForLive`, `liveTextLocatorForLive`,
  `adaptExpectationForLive`, `abstractExpectation`, `abstractSpec`.
  - scripts판(=1.1.0, 202줄): ISO_DATE_PATTERN 규칙 보유,
    `adaptExpectationForLive(expectation, _testTitle, _scenarioId)` —
    testTitle 미사용.
  - adapter판(=1.0.0, 318줄): CREDIT_REMAINING_LIVE_PATTERN,
    SCORE/PERCENT/CREDIT_TITLE_HINT 정규식 보유,
    `adaptExpectationForLive(expectation, testTitle, _scenarioId)` —
    testTitle 사용.
- canonicalJson/canonicalHash 함수 본문은 두 contracts에서 문자 그대로 동일.
- personaut `bin/personaut.mjs`는 `../dist/index.mjs`를 import (7줄짜리).
- personaut package.json build:
  `pnpm --filter @persona-runtime/persona-policy build && esbuild src/index.mjs --bundle --platform=node --format=esm --outfile=dist/index.mjs --external:@playwright/test --external:typescript --external:yaml`
- persona-policy만 TypeScript(`packages/persona-policy/src/index.ts`, 380줄,
  tsc 빌드). exports: `PRESETS`, `deriveSessionSeed`, `createRandom`,
  `sampleDistribution`, `sampleBehaviorPolicy`, `createPersonaState`,
  `reducePersonaState`, `filterPerceivedElements`, `evaluateAbandonment`
  - type들.
- qa-native에서 scripts 파서를 import하는 곳:
  `packages/static-authority/index.mjs:2`
  (`import { parsePlaywrightSource } from "../../scripts/playwright-spec-parser.mjs"`),
  `scripts/hermes-qa-project-config.mjs`, scripts 내부 상호 import.
  실행 시 `grep -rn "scripts/playwright-\|scripts/expectation-abstractor"` 로
  전수 확인할 것.
- qa-native 테스트는 `apps/playwright-spec-for-ai-agent/scripts/__tests__/`의
  vitest 파일들(`expectation-abstractor.test.ts`,
  `playwright-spec-parser.test.ts`, `package-pack-smoke.test.ts`,
  `workspace-release.test.ts` 등). **테스트 파일은 옮기지 않는다** — import
  경로만 새 패키지로 바꾼다.
- personaut의 워크스페이스 소비 패키지(devDependencies, prepack 번들로
  인라인): contracts, evaluator, hermes-transport, persona-policy,
  reporter-html, runtime-core, playwright-driver, playwright-spec-adapter.
- `reporter-github`, `provider-fixture`는 미사용이지만 **삭제 보류** — 이번
  작업에서 건드리지 않는다.

---

## Phase 1 (PR-1): `playwright-spec-extract` 공통화 + 기동 사고 수리

브랜치: `refactor/spec-extract-shared`

### Task 1.1: 베이스라인 기록

- [ ] `cd apps/playwright-spec-for-ai-agent && pnpm test` 실행, 결과 저장.
- [ ] `cd apps/personaut && node --test test/*.test.mjs` 실행, 결과 저장.
      spec-adapter 경유 import 실패가 있으면 그 내용 기록(이 PR의 수리 대상).
- [ ] `node -e "import('./packages/playwright-spec-adapter/src/index.mjs').then(()=>console.log('OK')).catch(e=>console.log('BROKEN:',e.message))"`
      → 현재 `BROKEN: Cannot find module ... dashboard-spec-parser.mjs` 확인.

### Task 1.2: 패키지 스켈레톤

- [ ] `packages/playwright-spec-extract/package.json` 생성:

```json
{
  "name": "playwright-spec-extract",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Shared Playwright source -> IR extraction (parser, AST, expectation abstractor).",
  "exports": {
    ".": "./spec-parser.mjs",
    "./spec-parser": "./spec-parser.mjs",
    "./ast-parser": "./ast-parser.mjs",
    "./expectation-abstractor": "./expectation-abstractor.mjs"
  },
  "dependencies": {
    "typescript": "^5.9.3"
  }
}
```

- [ ] typescript 의존이 실제 필요한지 확인:
      `grep -n "from \"typescript\"\|require(\"typescript\")" apps/playwright-spec-for-ai-agent/scripts/playwright-ast-parser.mjs apps/playwright-spec-for-ai-agent/scripts/playwright-spec-parser.mjs`
      — 안 쓰면 dependencies에서 제거.

### Task 1.3: 파서 2개 이동

- [ ] `git mv apps/playwright-spec-for-ai-agent/scripts/playwright-ast-parser.mjs packages/playwright-spec-extract/ast-parser.mjs`
- [ ] `git mv apps/playwright-spec-for-ai-agent/scripts/playwright-spec-parser.mjs packages/playwright-spec-extract/spec-parser.mjs`
- [ ] 옮긴 두 파일 내부의 상대 import를 서로에 맞게 수정
      (예: `./playwright-ast-parser.mjs` → `./ast-parser.mjs`).
- [ ] qa-native 소비처 전환:
  - `apps/playwright-spec-for-ai-agent/package.json` dependencies에
    `"playwright-spec-extract": "workspace:*"` 추가.
  - `packages/static-authority/index.mjs:2` →
    `import { parsePlaywrightSource } from "playwright-spec-extract/spec-parser";`
  - `grep -rn "scripts/playwright-spec-parser\|scripts/playwright-ast-parser" apps/playwright-spec-for-ai-agent`
    로 남은 참조 전부 같은 방식으로 전환 (scripts/hermes-qa-project-config.mjs,
    `scripts/__tests__/playwright-spec-parser.test.ts` 포함).
- [ ] `pnpm install` (workspace 링크 생성).
- [ ] `cd apps/playwright-spec-for-ai-agent && pnpm test` → Task 1.1 베이스라인과
      동일하게 그린.
- [ ] 커밋: `refactor: move playwright spec parsers to shared playwright-spec-extract`

### Task 1.4: abstractor 병합

- [ ] 병합 기준: **adapter판(1.0.0, 318줄)을 베이스로 복사**
      (`cp packages/playwright-spec-adapter/src/expectation/abstractor.mjs packages/playwright-spec-extract/expectation-abstractor.mjs`).
      adapter판이 title-hint 구조를 갖고 있어 superset임.
- [ ] scripts판(1.1.0)에만 있는 규칙을 베이스에 이식:
  - `const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;` 및 이 패턴을 쓰는
    `semanticIsoDateExpected` 규칙 분기.
  - 두 파일을 diff해서(`diff apps/... packages/...` 대신 이미 이동했으므로
    `git show HEAD~1:apps/playwright-spec-for-ai-agent/scripts/expectation-abstractor.mjs` 사용)
    1.1.0에만 존재하는 규칙 분기를 전부 목록화해 이식. 동일 입력에 대해 두
    판의 기대 출력이 충돌하면 **STOP — 사람 결정 필요** 라고 보고.
- [ ] 병합본 버전: `export const ABSTRACTION_RULES_VERSION = "1.2.0";`
- [ ] 소비처 전환:
  - `packages/playwright-spec-adapter/src/index.mjs`의
    `export * from "./expectation/abstractor.mjs";` →
    `export * from "playwright-spec-extract/expectation-abstractor";`
  - `packages/playwright-spec-adapter/package.json`에
    `"playwright-spec-extract": "workspace:*"` 추가.
  - qa-native 쪽에서 scripts/expectation-abstractor.mjs를 import하던 곳 전부
    (`grep -rn "expectation-abstractor" apps/playwright-spec-for-ai-agent`)
    → `playwright-spec-extract/expectation-abstractor`.
- [ ] 원본 2개 삭제: `git rm apps/playwright-spec-for-ai-agent/scripts/expectation-abstractor.mjs packages/playwright-spec-adapter/src/expectation/abstractor.mjs`
- [ ] 동등성 게이트(둘 다 기존 테스트가 병합본을 향하게 됨):
  - `cd apps/playwright-spec-for-ai-agent && pnpm test` — 특히
    `scripts/__tests__/expectation-abstractor.test.ts` 그린.
  - `cd apps/personaut && node --test test/*.test.mjs` 그린.
  - 둘 중 하나라도 레드면 병합 누락 — 1.1.0/1.0.0 규칙 재대조.
- [ ] 커밋: `refactor: merge duplicated expectation abstractors into playwright-spec-extract (rules 1.2.0)`

### Task 1.5: 깨진 legacy re-export 수리

- [ ] `packages/playwright-spec-adapter/src/compiler.mjs:6`
      `import { parseSpecDirectory } from "./legacy/parser.mjs";` →
      `import { parseSpecDirectory } from "playwright-spec-extract/spec-parser";`
- [ ] `packages/playwright-spec-adapter/src/index.mjs`의
      `export * from "./legacy/parser.mjs";` →
      `export * from "playwright-spec-extract/spec-parser";`
- [ ] `git rm packages/playwright-spec-adapter/src/legacy/parser.mjs`
      (legacy 디렉토리 비면 디렉토리째 제거).
- [ ] 기동 스모크:
      `node -e "import('./packages/playwright-spec-adapter/src/index.mjs').then(m=>console.log('OK',Object.keys(m).length)).catch(e=>{console.error(e);process.exit(1)})"`
      → OK.
      `node -e "import('./apps/personaut/src/index.mjs').then(()=>console.log('CLI OK')).catch(e=>{console.error(e);process.exit(1)})"`
      → CLI OK (이 라인이 이 PR의 존재 이유).
- [ ] 커밋: `fix: repair broken cross-app spec parser re-export via playwright-spec-extract`

### Task 1.6: 발행 레이아웃 + changeset

- [ ] `cd apps/playwright-spec-for-ai-agent && npm pack --dry-run` — 산출물에
      번들이 포함되고 `packages/playwright-spec-extract` 참조가 미해결로 남지
      않는지 확인 (`package-pack-smoke.test.ts`, `workspace-release.test.ts`가
      게이트 역할, 그린 필수).
- [ ] `cd apps/personaut && pnpm build && npm pack --dry-run` — dist 번들에
      spec-extract 코드가 인라인됐는지 확인
      (`grep -c "parseSpecDirectory" dist/index.mjs` ≥ 1).
- [ ] `.changeset/spec-extract-shared.md` 생성:

```md
---
"@lodado/personaut": patch
"playwright-spec-for-ai-agent": patch
---

Repair broken cross-app spec parser import and move Playwright spec
extraction (parser, AST, expectation abstractor) into the shared
playwright-spec-extract workspace package. Personaut CLI failed to boot
from source due to a re-export of a renamed file; both apps now consume
one parser and one merged abstractor (rules 1.2.0).
```

- [ ] 전체 그린 재확인(양쪽 테스트), 커밋:
      `chore: add changeset for playwright-spec-extract`

---

## Phase 2 (PR-2): personaut 평탄화 + 빌드 축소

브랜치: `refactor/personaut-flatten` (PR-1 머지 후 시작)

### Task 2.1: 파일 이동

- [ ] git mv 표 (전부 `apps/personaut/src/` 아래로):

| 원위치                                              | 새 위치                                |
| --------------------------------------------------- | -------------------------------------- |
| `packages/contracts/index.mjs`                      | `apps/personaut/src/contracts.mjs`     |
| `packages/runtime-core/src/index.mjs`               | `apps/personaut/src/runtime.mjs`       |
| `packages/playwright-driver/src/index.mjs`          | `apps/personaut/src/driver.mjs`        |
| `packages/evaluator/src/index.mjs`                  | `apps/personaut/src/evaluator.mjs`     |
| `packages/reporter-html/src/index.mjs`              | `apps/personaut/src/reporter-html.mjs` |
| `packages/playwright-spec-adapter/src/compiler.mjs` | `apps/personaut/src/spec-adapter.mjs`  |

spec-adapter는 compiler.mjs가 본체이므로 compiler를 옮기고, 기존
`src/index.mjs`(barrel)의 재수출 4줄 중 `./compiler.mjs` 외 3줄
(spec-parser/abstractor/live-filter 재수출)을 spec-adapter.mjs 상단에
옮겨 심는다:

```js
export * from "playwright-spec-extract/spec-parser";
export * from "playwright-spec-extract/expectation-abstractor";
export * from "./spec-adapter-live-filter.mjs";
```

- [ ] `git mv packages/playwright-spec-adapter/src/policy/live-filter.mjs apps/personaut/src/spec-adapter-live-filter.mjs`
- [ ] import 재작성 표 — `apps/personaut/src`와 `apps/personaut/test` 전체에서:

| 기존 specifier                      | 새 specifier                                          |
| ----------------------------------- | ----------------------------------------------------- |
| `@persona-runtime/contracts`        | `./contracts.mjs` (test에서는 `../src/contracts.mjs`) |
| `@persona-runtime/runtime-core`     | `./runtime.mjs`                                       |
| `playwright-driver`                 | `./driver.mjs`                                        |
| `@persona-runtime/evaluator`        | `./evaluator.mjs`                                     |
| `@persona-runtime/reporter-html`    | `./reporter-html.mjs`                                 |
| `playwright-spec-adapter`           | `./spec-adapter.mjs`                                  |
| `@persona-runtime/persona-policy`   | `./persona-policy.mjs` (Task 2.2 이후)                |
| `@persona-runtime/hermes-transport` | **변경 없음** (공유 패키지 유지)                      |

옮겨진 모듈들끼리의 상호 import(예: runtime.mjs가
`@persona-runtime/contracts` import)도 같은 표로 재작성.

- [ ] 커밋: `refactor: flatten persona-runtime packages into apps/personaut/src`

### Task 2.2: persona-policy TS→mjs 변환

- [ ] `packages/persona-policy/src/index.ts`(380줄)를
      `apps/personaut/src/persona-policy.mjs`로 변환:
  - 타입 어노테이션 제거, `interface`/`type`은 `@typedef` JSDoc으로 보존.
  - export 심볼 9개 이름·시그니처 유지: `PRESETS`, `deriveSessionSeed`,
    `createRandom`, `sampleDistribution`, `sampleBehaviorPolicy`,
    `createPersonaState`, `reducePersonaState`, `filterPerceivedElements`,
    `evaluateAbandonment`.
  - 로직 변경 금지 — 순수 문법 변환만.
- [ ] `packages/persona-policy/test/`의 테스트를 `apps/personaut/test/`로
      이동, import를 `../src/persona-policy.mjs`로.
- [ ] 변환 검증: 테스트 그린 + `node --check apps/personaut/src/persona-policy.mjs`.
- [ ] 커밋: `refactor: convert persona-policy to plain ESM with JSDoc types`

### Task 2.3: 내부 중복 2건 정리

- [ ] `apps/personaut/src/runtime.mjs` 19-22행 부근:
      `export const OBSERVATION_SCHEMA_VERSION = "observation/0.1";` →
      `export const OBSERVATION_SCHEMA_VERSION = OBSERVATION_VERSION;`
      (contracts import에 `OBSERVATION_VERSION` 추가.
      `RUNTIME_SESSION_SCHEMA_VERSION`은 그대로 둘 것 — 다른 계약.)
- [ ] `apps/personaut/src/index.mjs`의 `atomicJson`(약 541행)을 runtime.mjs의
      `atomicWrite`를 사용하도록 교체 — runtime.mjs에서 `atomicWrite`를
      export하고 index.mjs의 자체 구현 삭제:

```js
// index.mjs
import { atomicWrite } from "./runtime.mjs";
async function atomicJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}
```

(atomicWrite의 실제 시그니처가 다르면 시그니처에 맞춰 적응하되, tmp 파일

- rename 원자성은 유지.)

* [ ] 테스트 그린, 커밋: `refactor: dedupe observation version constant and atomic write`

### Task 2.4: 테스트 합류 + import-방향 테스트

- [ ] 각 이동 패키지의 `test/`·`tests/` 파일을 `apps/personaut/test/`로 이동.
      파일명 충돌 시 접두사(`contracts-`, `runtime-` 등) 부여.
- [ ] 이주 전후 테스트 케이스 수 동일 확인:
      `node --test test/*.test.mjs 2>&1 | tail -5`의 `# tests` 수를 이동
      전(각 패키지 합산)과 비교.
- [ ] `apps/personaut/test/architecture.test.mjs` 신규 작성:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const SRC = new URL("../src/", import.meta.url);

async function srcFiles() {
  return (await readdir(SRC)).filter((f) => f.endsWith(".mjs"));
}

test("contracts.mjs is a leaf (no relative imports)", async () => {
  const text = await readFile(new URL("contracts.mjs", SRC), "utf8");
  assert.doesNotMatch(text, /from "\.\//, "contracts must not import siblings");
});

test("only driver.mjs touches Playwright", async () => {
  for (const file of await srcFiles()) {
    const text = await readFile(new URL(file, SRC), "utf8");
    const usesPlaywright = /from "(@playwright\/test|playwright)"/.test(text);
    if (file === "driver.mjs") continue;
    assert.equal(usesPlaywright, false, `${file} must not import playwright`);
  }
});

test("only hermes-action-policy.mjs talks to hermes-transport", async () => {
  for (const file of await srcFiles()) {
    const text = await readFile(new URL(file, SRC), "utf8");
    const usesHermes = /@persona-runtime\/hermes-transport/.test(text);
    if (file === "hermes-action-policy.mjs") continue;
    assert.equal(usesHermes, false, `${file} must not import hermes-transport`);
  }
});
```

- [ ] `node --test test/architecture.test.mjs` 그린 (레드면 위반 지점을
      플랜 규칙에 맞게 수정; index.mjs가 hermes-transport를 직접 import하고
      있으면 hermes-action-policy 경유로 옮긴다).
- [ ] 커밋: `test: merge package tests and add import-direction guard`

### Task 2.5: 빌드 축소 + 패키지 정리

- [ ] `apps/personaut/package.json`:
  - `build`: `esbuild src/index.mjs --bundle --sourcemap --platform=node --format=esm --outfile=dist/index.mjs --external:@playwright/test --external:typescript --external:yaml`
    (`pnpm --filter ... build &&` 선행부 삭제, `--sourcemap` 추가).
  - devDependencies에서 제거: `@persona-runtime/contracts`,
    `@persona-runtime/evaluator`, `@persona-runtime/persona-policy`,
    `@persona-runtime/reporter-html`, `@persona-runtime/runtime-core`,
    `playwright-driver`, `playwright-spec-adapter`.
  - 유지: `@persona-runtime/hermes-transport`, 추가:
    `"playwright-spec-extract": "workspace:*"`, `esbuild`.
  - `typecheck`: `node --check src/*.mjs && node --check bin/personaut.mjs`
    (변경 없음, persona-policy.mjs가 자동 포함되는지 확인).
- [ ] 빈 껍데기가 된 워크스페이스 패키지 삭제:
      `git rm -r packages/contracts packages/runtime-core packages/playwright-driver packages/evaluator packages/persona-policy packages/playwright-spec-adapter packages/reporter-html`
      (**reporter-github, provider-fixture는 건드리지 않음** — 보류 결정.)
- [ ] 저장소 전체에서 삭제 패키지 참조 잔존 확인:
      `grep -rn "@persona-runtime/\(contracts\|runtime-core\|evaluator\|persona-policy\|reporter-html\)\|\"playwright-driver\"\|\"playwright-spec-adapter\"" --include="*.json" --include="*.mjs" --include="*.ts" . | grep -v node_modules | grep -v docs/`
      → 0건이어야 함.
- [ ] `pnpm install` 후 게이트:
  - `cd apps/personaut && node --test test/*.test.mjs` 그린.
  - `pnpm build && node bin/personaut.mjs help` — 도움말 출력(기동 스모크).
  - `npm pack --dry-run` — bin/dist/README 포함, src 미포함이어도 무방
    (번들 발행 유지).
  - `cd apps/playwright-spec-for-ai-agent && pnpm test` 그린(영향 없음 확인).
- [ ] `.changeset/personaut-flatten.md`:

```md
---
"@lodado/personaut": patch
---

Flatten internal persona-runtime workspace packages into apps/personaut/src
flat modules, convert persona-policy to plain ESM, dedupe version constants
and atomic writes, and simplify the build to a single esbuild bundle with
sourcemaps. No public API change.
```

- [ ] 커밋: `refactor: single-app personaut layout with simplified build`

---

## Phase 3 (PR-3): `qa-kit` 공유 추출

브랜치: `refactor/qa-kit` (PR-2 머지 후 시작)

### Task 3.1: 스켈레톤 + canonical

- [ ] `packages/qa-kit/package.json`:

```json
{
  "name": "qa-kit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Shared primitives for evidence-first QA apps: canonical hashing, DOM settle, secret redaction.",
  "exports": {
    "./canonical": "./canonical.mjs",
    "./settle": "./settle.mjs",
    "./redact": "./redact.mjs"
  }
}
```

- [ ] **해시 회귀 기준값 먼저 채취** (전환 전):

```bash
node -e "import('./apps/personaut/src/contracts.mjs').then(m=>console.log(m.canonicalHash({b:1,a:[2,{d:3,c:4}],s:'문자열'})))"
node -e "import('./apps/playwright-spec-for-ai-agent/packages/contracts/index.mjs').then(m=>console.log(m.canonicalHash({b:1,a:[2,{d:3,c:4}],s:'문자열'})))"
```

두 출력이 같아야 정상(구현 동일). 값을 기록.

- [ ] `packages/qa-kit/canonical.mjs` 생성 —
      `apps/personaut/src/contracts.mjs`에서 `canonicalize`(내부 헬퍼),
      `canonicalJson`, `canonicalHash`, `stableId` 함수를 그대로 이동.
- [ ] 두 contracts가 qa-kit을 소비하며 **재수출 유지**(소비처 11+곳 무변경):
  - `apps/personaut/src/contracts.mjs`:
    `export { canonicalJson, canonicalHash, stableId } from "qa-kit/canonical";`
    — 단, architecture.test.mjs의 leaf 규칙과 충돌하므로 그 테스트의
    contracts 검사를 "relative import 금지 + 허용 목록 `qa-kit/`"로 완화.
  - `apps/playwright-spec-for-ai-agent/packages/contracts/index.mjs`: 자체
    구현 삭제, 동일하게 재수출 (`payloadContentHash`는 qa-kit의
    canonicalHash를 쓰도록 내부 수정, export 유지).
  - 양 앱 package.json에 `"qa-kit": "workspace:*"` 추가.
- [ ] `packages/qa-kit/test/canonical.test.mjs` — 채취한 기준값을 고정:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalHash } from "../canonical.mjs";

test("canonicalHash is stable across the extraction (regression pin)", () => {
  assert.equal(
    canonicalHash({ b: 1, a: [2, { d: 3, c: 4 }], s: "문자열" }),
    "<Task 3.1에서 채취한 값으로 교체>",
  );
});
```

("<...>" 는 실행 시점에 채취값으로 반드시 치환 — 치환 없이 커밋 금지.)

- [ ] 양 앱 테스트 그린 + `pnpm build && npm pack --dry-run` (양 앱, 번들
      인라인 확인). 커밋:
      `refactor: extract canonical hashing into shared qa-kit`

### Task 3.2: settle 공유

- [ ] 먼저 두 구현을 읽는다:
      `apps/personaut/src/driver.mjs`의 `stabilizePage(page, policy)`
      (MutationObserver quiet 대기, `policy.domQuietMs`/`policy.maxWaitMs`),
      `apps/playwright-spec-for-ai-agent/packages/runtime/playwright.mjs`의
      `settleDomForObservation(page, remainingMs)`(476행)과
      `settleGatewayDom(page, timing)`(511행).
- [ ] 공유 범위는 **브라우저 안에서 도는 quiet 판정 함수 하나만**:

```js
// packages/qa-kit/settle.mjs
/**
 * Browser-side predicate: resolves when DOM mutations stay quiet for
 * quietMs, or after the hard cap. Passed to page.waitForFunction.
 * Timing policy (quietMs, caps, deadlines) stays app-owned.
 */
export function domQuietPredicate(quietMs) {
  /* MutationObserver 본문 이동 */
}
export async function waitForDomQuiet(page, { quietMs, maxWaitMs }) {
  await page
    .waitForFunction(domQuietPredicate, quietMs, { timeout: maxWaitMs })
    .catch(() => undefined);
}
```

구현 본문은 personaut `stabilizePage`의 `page.waitForFunction` 페이로드를
그대로 이동(타이밍 값 변경 금지). qa-native 쪽 판정 본문이 의미상 다르면
(quiet 판정 조건 자체가 다르면) **qa-native는 전환하지 말고 personaut만
전환 후 보고** — 타이밍 동작 결합은 골든 테스트 없이 강행 금지.

- [ ] 두 앱의 기존 함수(`stabilizePage`, `settleDomForObservation`,
      `settleGatewayDom`)는 이름·시그니처·타이밍 값 유지, 내부만
      `waitForDomQuiet` 호출로 교체.
- [ ] 게이트: 양 앱 테스트 그린 (settle 관련 기존 테스트가 골든 역할).
- [ ] 커밋: `refactor: share DOM quiet predicate via qa-kit/settle`

### Task 3.3: redact 리터럴 치환 공유

- [ ] `packages/qa-kit/redact.mjs`:

```js
/**
 * Replace literal secrets (and their URI-encoded forms) in a string.
 * Context-specific redaction rules (URL, headers, JSON paths) stay in
 * each app — do NOT centralize rule sets here (per qa-native design rule 5).
 */
export function replaceSecretLiterals(
  text,
  secrets = [],
  marker = "[redacted]",
) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (!secret) continue;
    const s = String(secret);
    out = out.split(s).join(marker);
    out = out.split(encodeURIComponent(s)).join(marker);
  }
  return out;
}
```

- [ ] `packages/hermes-transport/index.mjs`의 `redactSensitiveText`(338행) —
      secret 치환 루프를 `replaceSecretLiterals` 호출로 교체
      (`redactHermesOutput` 전처리는 유지). marker 문자열이 기존과 다르면
      기존 값을 인자로 넘겨 보존.
- [ ] `apps/playwright-spec-for-ai-agent/packages/evidence/index.mjs`의
      `redactString` 내부에서 리터럴 치환 부분만 동일하게 교체. **규칙
      목록(REDACTION_RULES)·URL/헤더 파서는 절대 건드리지 않음.** marker가
      `[REDACTED]`(대문자)면 그대로 인자로 전달.
- [ ] 게이트: 양 앱 테스트 그린. redaction 관련 테스트 레드면 marker/순서
      차이 — 기존 출력에 맞춰 인자 조정(축소 방향 변경 금지).
- [ ] `.changeset/qa-kit-shared.md`:

```md
---
"@lodado/personaut": patch
"playwright-spec-for-ai-agent": patch
---

Extract shared canonical hashing, DOM quiet predicate, and secret literal
replacement into the internal qa-kit package. Behavior-preserving: hash
regression pins, unchanged timing values, and app-owned redaction rules.
```

- [ ] 커밋: `refactor: share redaction literal replacement via qa-kit`

---

## Phase 4 (PR-4): 에러 provenance + ARCHITECTURE.md

브랜치: `refactor/personaut-provenance` (PR-3 머지 후)

### Task 4.1: 공통 에러 base

- [ ] `apps/personaut/src/errors.mjs` 신규:

```js
/**
 * Provenance keeps infrastructure failures from masquerading as UX findings.
 * - "infra": provider/driver/runtime failure — never a product finding.
 * - "contract": schema/validation violation — a bug in specs or code.
 * - "ux": evidence-backed product behavior finding.
 */
export const PROVENANCES = Object.freeze(["infra", "contract", "ux"]);

export class PersonautError extends Error {
  constructor(message, { code, provenance, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    if (!PROVENANCES.includes(provenance)) {
      throw new TypeError(`invalid provenance: ${provenance}`);
    }
    this.provenance = provenance;
  }
}
```

- [ ] 기존 3개 에러 클래스가 base를 상속하도록 수정(공개 형태 유지):
  - `contracts.mjs` `ContractValidationError`/`ContractMigrationError` →
    `extends PersonautError`, provenance `"contract"` 고정.
  - `runtime.mjs` `RuntimeCoreError` → provenance `"infra"` 기본값
    (생성자 인자로 덮어쓰기 허용).
  - `evaluator.mjs` `EvaluatorError` → provenance `"infra"` 기본값
    (oracle 판정 실패는 infra, finding은 에러가 아니라 데이터이므로 ux
    provenance 에러는 현재 없음 — 주석으로 명시).
  - 각 클래스의 기존 필드(`code` 등)와 메시지 형식은 그대로 — 스냅샷
    테스트가 있으면 그린 유지가 증명.
- [ ] `apps/personaut/test/errors.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { PersonautError } from "../src/errors.mjs";
import { RuntimeCoreError } from "../src/runtime.mjs";
import { ContractValidationError } from "../src/contracts.mjs";

test("runtime errors carry infra provenance", () => {
  const error = new RuntimeCoreError("boom", { code: "E_DRIVER" });
  assert.equal(error.provenance, "infra");
  assert.ok(error instanceof PersonautError);
});

test("contract errors carry contract provenance", () => {
  const error = new ContractValidationError("bad spec", []);
  assert.equal(error.provenance, "contract");
});

test("invalid provenance is rejected", () => {
  assert.throws(() => new PersonautError("x", { provenance: "vibes" }));
});
```

(기존 생성자 시그니처가 위와 다르면 기존 시그니처를 유지하고 테스트를
그에 맞춤 — 시그니처 변경은 공개 API 변경이므로 금지.)

- [ ] CLI 에러 출력 경로(`src/index.mjs`의 catch / stderr 출력부)에서
      `error.provenance`가 있으면 `[infra]`처럼 접두 출력하도록 한 줄 추가.
- [ ] 테스트 그린, 커밋: `feat: unify personaut errors under provenance-tagged base`

### Task 4.2: ARCHITECTURE.md

- [ ] `apps/personaut/ARCHITECTURE.md` 작성 — 아래 뼈대에 실제 파일 목록
      반영(섹션 구성 유지):

```md
# Personaut Architecture

AI chooses. Code constrains. Evidence decides.

## Pipeline

StudySpec (yaml | imported Playwright spec)
-> contracts (validate)
-> runtime (task x persona x seed matrix, session state machine)
-> [loop] driver.observe -> policy propose -> validate -> driver.act
-> seal evidence (file store, canonical hash)
-> evaluator (oracles, friction, findings, release gate)
-> reporter-html

## Files (one line each)

| File                         | Role                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- | -------- | ---- |
| src/index.mjs                | The only composition. CLI commands, wiring, no domain logic.           |
| src/contracts.mjs            | Vocabulary: schema versions, validation, ids. Leaf.                    |
| src/runtime.mjs              | Session state machine, run loop, sealing, file store.                  |
| src/driver.mjs               | The only file importing Playwright. Executes validated actions.        |
| src/persona-policy.mjs       | Deterministic persona sampling, perception filter.                     |
| src/hermes-action-policy.mjs | The only file calling hermes-transport.                                |
| src/evaluator.mjs            | Post-seal judgment from sealed evidence only.                          |
| src/spec-adapter.mjs         | IR -> StudySpec compile (extraction lives in playwright-spec-extract). |
| src/reporter-html.mjs        | Sealed artifacts -> HTML report.                                       |
| src/errors.mjs               | Provenance-tagged error base (infra                                    | contract | ux). |

## Invariants

1. A model never receives browser authority; it proposes one action.
2. A model never declares success; oracles decide from sealed evidence.
3. Failures keep provenance; infra errors never become UX findings.

## Import rules (enforced by test/architecture.test.mjs)

- contracts.mjs imports no sibling (qa-kit allowed).
- Playwright appears only in driver.mjs.
- hermes-transport appears only in hermes-action-policy.mjs.

## Shared workspace packages

- @persona-runtime/hermes-transport — hermes process transport (both apps).
- playwright-spec-extract — Playwright source -> IR (both apps).
- qa-kit — canonical hash / DOM quiet / secret literals (both apps).
```

- [ ] `.changeset/personaut-provenance.md`:

```md
---
"@lodado/personaut": patch
---

Unify internal errors under a provenance-tagged base (infra | contract | ux)
and document the single-composition architecture.
```

- [ ] 테스트 그린, 커밋: `docs: personaut architecture charter with provenance invariants`

---

## 최종 검증 (각 PR 공통 체크리스트)

- [ ] `cd apps/personaut && node --test test/*.test.mjs` 그린.
- [ ] `cd apps/playwright-spec-for-ai-agent && pnpm test` 그린.
- [ ] 양 앱 `pnpm build`(해당 시) + `npm pack --dry-run` 정상.
- [ ] `node bin/personaut.mjs help` 기동(빌드 후).
- [ ] changeset 파일 존재, **version 미적용**.
- [ ] AGENTS.md §2 매트릭스에서 스펙 컴파일/CLI 옵션 행 해당 여부 확인,
      해당 시 갱신.
