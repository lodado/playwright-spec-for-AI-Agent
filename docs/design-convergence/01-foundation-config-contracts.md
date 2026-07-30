# 01. 기초 구조, 설정, 계약

## 목표

Design Convergence의 TypeScript 기반 private CLI, shared schema, config parser를 만든다. 이 phase는 실행 위험 분류, secret redaction, path containment, provenance, error taxonomy를 먼저 고정한다.

## 선행 조건

- [00. 저장소 적합성](./00-repository-fit.md)의 package 경계를 따른다.
- 신규 workspace는 모두 `private: true`다.
- Figma live token, app start command, Playwright 실행은 아직 구현하지 않는다.

## 생성/수정 예정 파일

```text
apps/design-convergence/
  package.json
  tsconfig.json
  src/cli.ts
  src/logger.ts
  src/commands/run.ts
  test/cli.test.ts

packages/design-convergence-shared/
  package.json
  tsconfig.json
  src/index.ts
  src/schemas.ts
  src/errors.ts
  src/provenance.ts
  src/path-policy.ts
  src/redaction.ts
  test/*.test.ts

packages/design-convergence-config/
  package.json
  tsconfig.json
  src/index.ts
  src/define-config.ts
  src/load-config.ts
  src/schema.ts
  test/*.test.ts

tsconfig.base.json
```

루트 파일 변경은 최소화한다. `pnpm-workspace.yaml`는 이미 `apps/*`, `packages/*`를 포함하므로 수정하지 않는다.

의존성 변경은 `pnpm`으로만 수행해 `pnpm-lock.yaml`을 갱신한다. 기존 `package-lock.json`을 Design Convergence 작업의 lockfile로 사용하거나 `npm install`로 다시 쓰지 않는다.

각 package는 실제 import하는 `zod`, TypeScript/Node test tooling을 직접 선언한다. workspace hoist나 다른 app의 devDependency에 기대지 않는다. Babel/Next/Tailwind/CDP 관련 의존성은 해당 phase 전에는 설치하지 않는다.

## 계약 범위

### TypeScript와 versioned schemas

공통 `tsconfig.base.json`은 현재 `packages/persona-policy/tsconfig.json`의 검증된 방향을 따라 `ES2022`, `NodeNext`, `strict`, declaration 출력을 사용한다. NodeNext source import는 빌드 결과를 기준으로 `.js` 확장자를 사용한다. 각 package는 `build`, `typecheck`, `lint`, `test` script를 선언해 Turbo root gate에 포함한다. 별도 linter가 없는 현재 저장소에 사용하지 않는 ESLint/Prettier scaffold를 추가하지 않는다.

Phase 01은 **cross-cutting contract만** strict Zod로 고정한다. artifact별 스키마(`CanonicalStyleNode`, `DesignBinding`, `StyleDiff`, `RuntimeBindingValidation`, `DiffMetrics`, `PatchVerificationResult`)는 그것을 처음 산출하는 phase에서 `@design-convergence/shared`에 추가한다. 전 package가 아직 private이라 조기 고정의 유일한 이점인 하위호환이 성립하지 않고, 각 스키마의 올바른 shape는 해당 변환기를 구현하며 확정되기 때문이다.

Phase 01에서 고정하는 것:

- 저장 artifact **envelope**: `schemaVersion: 1` + provenance를 요구하고 unknown key를 거부하는 공통 wrapper. 개별 payload 스키마는 각 producing phase에서 이 envelope로 감싼다.
- `RuntimeErrorKind`: master prompt의 taxonomy를 문자열 union으로 고정한다.
- config 스키마(아래 Config schema coverage)와 provenance/path/redaction/secret policy.

아직 산출하지 않는 값에 placeholder나 silent default를 저장하지 않는다. 각 artifact 스키마는 도입 phase의 "생성/수정 예정 파일"에 `@design-convergence/shared` 항목으로 명시한다.

### 안전한 config 로딩 (JSON-first)

`design-convergence.config.ts`를 Node에서 import하면 target repository 코드를 실행하게 된다. v0.1 CLI loader는 코드를 전혀 실행하지 않는 **JSON config를 1차 형식으로** 사용한다.

- CLI는 `design-convergence.config.json`을 읽어 Zod로 검증한다. 인터프리터가 없으므로 임의 코드 실행 표면이 0이다.
- 파일 상단 `"$schema"`로 편집기 자동완성/검증을 제공한다.
- secret은 값이 아니라 참조로 쓴다: `"figma": { "accessToken": { "env": "FIGMA_ACCESS_TOKEN" } }`. loader는 이를 internal `SecretRef`로 보존하고 값으로 펼치지 않는다. 실제 REST/provider/GitHub boundary에서만 broker가 해석하므로 fixture/data-only command는 secret 없이 실행된다.
- redacted config hash에는 secret 값 대신 env 변수 이름과 고정 marker를 넣는다.

`@design-convergence/config`는 published package로서 Zod 스키마, `z.infer` TypeScript 타입, `defineConfig` identity helper를 export한다. 사용자가 TS로 config를 작성하고 싶으면 자신의 빌드로 JSON을 생성해 CLI에 넘긴다. **제한된 TypeScript AST loader(리터럴 + `process.env.NAME`만 해석)는 JSON이 실제로 불충분하다는 수요가 확인될 때까지 보류한다.** 인터프리터 구현·테스트 비용이 지키는 것은 data-only 모드의 무실행 보장 하나뿐이고(operator-approved 모드는 어차피 대상 repo의 babel/prepare/app 코드를 실행한다), JSON이 같은 보안 속성을 코드 0줄로 제공하기 때문이다.

### Config schema coverage

- `project`, `app`, `figma`, `instrumentation`, `comparison`, `patching`, `verification`, `cases`를 Phase 01에서 검증한다.
- `comparison`은 tolerance, severity weights/thresholds, font aliases, known `ignoredProperties`만 허용하고 typo/unknown property를 거부한다.
- AI/GitHub 설정은 optional discriminated section이며 사용 command가 호출될 때 필요한 secret ref와 repository identity를 요구한다.
- relative `rootDir`, `prepare`, binding/artifact paths는 config directory 기준으로 한 번만 resolve한다.
- case ID 중복, 빈 case 목록, 유효하지 않은 viewport/device scale, absolute route, missing Figma root node ID를 거부한다.
- 기본 attribute/tolerance/severity weight와 `cursor`/`caret-color` ignore처럼 QA 동작을 설명하는 safe default는 schema와 문서에 명시한다.
- token, project-code 실행 동의, allowed/forbidden path, verification command, Git remote처럼 보안에 영향을 주는 값은 default를 만들지 않는다.

### Error taxonomy

모든 실패는 아래 중 하나를 가진다.

```text
configuration
figma-auth
figma-fetch
source-index
binding-proposal
binding-static-validation
binding-runtime-validation
instrumentation
application-startup
page-setup
style-extraction
normalization
diff
source-attribution
patch-generation
patch-application
verification
report-generation
github
```

Infrastructure failure와 product mismatch를 같은 failure로 합치지 않는다. Figma cache read/write 실패는 별도 kind를 만들지 않고 `figma-fetch`로 분류하되(캐시는 fetch의 최적화 계층이므로), cache miss 자체는 실패가 아니라 provenance로 기록한다.

### Path policy

- config 기준 상대 경로만 허용한다.
- project root 밖 path traversal을 거부한다.
- symlink가 project root 밖으로 나가면 거부한다.
- artifact path는 상대 경로로 저장한다.
- `allowedGlobs`와 `forbiddenGlobs`는 patch phase 전에도 config validation에서 shape만 검증한다.
- runtime output은 `.design-convergence/{cache,artifacts,worktrees}` 아래로 제한하고 private directory/file mode, atomic exclusive write, symlink 거부를 테스트한다.

### Secret policy

- `FIGMA_ACCESS_TOKEN`, cookie, authorization header, password, token 형태 환경변수 이름을 redaction 대상으로 둔다.
- config loader는 secret 값을 로그에 쓰지 않는다.
- AI prompt input을 만드는 phase 전에도 redaction utility를 shared에 둔다.
- 보안 민감 필드는 silent default를 만들지 않는다.

### Provenance policy

각 저장 artifact에는 최소 provenance를 포함한다.

```text
schemaVersion
createdAt
toolVersion
configHash
gitCommit 또는 unavailable reason
source kind: fixture | figma-rest | browser | manual | generated
```

### Command와 실행 승인 policy

- `execution.allowProjectCode`는 필수 boolean이며 보안상 default를 만들지 않는다.
- `app.command`의 단순 문자열 예시(`"pnpm dev"`)는 공백으로 나뉘는 안전한 token만 허용한다. quote, escape, shell metacharacter가 필요한 명령은 `{ executable, args: string[] }`로 작성한다.
- 내부 표현은 항상 `{ executable, args }`이고 향후 실행은 `spawn(..., { shell: false })`만 사용한다.
- `prepare`는 root-contained module path로만 저장하며 이 phase에서는 import하지 않는다.

### Logging policy

- 같은 event object에서 human-readable 기본 출력과 JSON log를 렌더링한다.
- `verbose`와 `quiet`는 표현만 바꾸고 evidence나 판정을 바꾸지 않는다.
- case/binding/run ID와 error kind를 구조화하고 access token, cookie, authorization header, full environment는 중앙 redactor를 통과하지 않으면 기록하지 않는다.

## 작은 체크박스 작업

- [ ] `@design-convergence/shared` package 생성.
- [ ] `@design-convergence/config` package 생성.
- [ ] `design-convergence` private CLI package 생성.
- [ ] JSON config loader와 Zod 기반 config validation, `defineConfig` identity helper 작성. (제한된 TS-AST loader는 보류.)
- [ ] root `package.json`에 `design-convergence` 전달 script를 추가하고 Node `parseArgs`로 unknown option을 거부한다.
- [ ] duplicate case ID를 실패시키는 테스트 작성.
- [ ] invalid viewport dimension을 실패시키는 테스트 작성.
- [ ] missing Figma node ID를 실패시키는 테스트 작성.
- [ ] relative path resolution 테스트 작성.
- [ ] project root 밖 path traversal 거부 테스트 작성.
- [ ] redaction 테스트 작성.
- [ ] error taxonomy가 임의 문자열을 받지 않는 테스트 작성.
- [ ] unknown key/잘못된 타입 config와 shell metacharacter command를 거부하는 테스트 작성.
- [ ] `execution.allowProjectCode` 누락을 실패시키는 테스트 작성.
- [ ] human/JSON log 모두에서 secret이 제거되는 테스트 작성.
- [ ] CLI `run --case <id>`는 아직 runtime을 실행하지 않고 config/case 선택까지만 검증한다.

## 테스트 우선 절차

1. `loadConfig` 테스트를 먼저 작성한다.
2. config fixture에는 최소 `pricing-desktop` case를 둔다.
3. 실패 테스트를 먼저 둔다.
   - duplicate case IDs
   - viewport width/height 0 이하
   - missing `figma.rootNodeId`
   - path traversal in `prepare`
   - redaction 대상 값이 serialized log에 남는 경우
   - config JSON의 unknown key와 잘못된 타입
   - command 안의 `;`, `&&`, pipe, redirect, command substitution
4. 구현은 테스트를 통과하는 최소 필드만 지원한다.
5. app command 실행, Figma REST fetch, Playwright 실행은 stub으로도 넣지 않는다. Figma network는 Phase 02, conditional example build는 Phase 03, app/prepare/Playwright 실행은 Phase 04에서 추가한다.

## 실제 검증 명령

Phase 01 구현 후 실행한다.

```bash
pnpm --filter @design-convergence/shared test
pnpm --filter @design-convergence/config test
pnpm --filter design-convergence test
pnpm --filter design-convergence build
```

root 전체 gate는 Design Convergence workspace가 최소 build script를 가진 뒤 실행한다.

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

## 명령 실행 위험 구분

### Data-only 명령

- config 파일 로드
- schema validation
- path containment check
- config hash 생성
- fixture JSON 읽기

이 명령은 네트워크와 target app command를 실행하지 않는다.

### Operator-approved execution 명령

- `app.command`
- `readyURL` polling
- Figma REST fetch
- Playwright browser 실행
- Git worktree 생성
- patch verification command
- GitHub PR 생성

config에 문자열이 있더라도 자동 실행하지 않는다. `execution.allowProjectCode: true`와 실행 계열 command가 함께 있어야 한다.

## 종료 게이트

- config parser가 Zod로 모든 Phase 01 필드를 검증한다.
- config source(JSON) 자체는 실행되지 않으며, 잘못된 타입/unknown key/실행 가능한 형식은 거부된다.
- duplicate case ID, invalid viewport, missing Figma root node ID가 실패한다.
- secret redaction/path containment/provenance/error taxonomy 테스트가 있다.
- CLI가 선택한 case를 deterministic하게 식별한다.
- 어떤 코드도 target app command, network, Git write를 실행하지 않는다.

## 다음 phase 진입 게이트

Phase 02로 가려면 다음 artifact 위치와 source kind를 config에서 표현할 수 있어야 한다.

```text
fixtures/design-convergence/figma/<case-id>.raw.json
.design-convergence/artifacts/<run-id>/<case-id>/
```

## 의도적 보류

- schema shape는 Phase 01에서 고정하되 각 Figma/browser 변환기의 실제 지원은 Phase 02~04로 나눈다.
- AI provider abstraction은 Phase 05에서 만든다.
- `prepare` module 실행은 Phase 04에서 Playwright runner와 함께 다룬다.
- package publish metadata와 changeset은 공개 릴리스 전까지 보류한다.
