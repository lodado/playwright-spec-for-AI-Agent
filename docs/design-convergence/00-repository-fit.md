# 00. 저장소 적합성 및 작업 원칙

## 목표

현재 `playwright-spec-for-AI-Agent` monorepo 안에 Design Convergence를 과분할 없이 추가하기 위한 경계와 순서를 고정한다.

## 현재 저장소 요약

- 루트는 `pnpm@10.33.0` workspace와 Turbo를 사용한다.
- dependency install은 workspace의 `minimumReleaseAge`, `blockExoticSubdeps`, `trustPolicy`를 우회하지 않는다.
- workspace 범위는 `apps/*`, `packages/*`다.
- published package는 `playwright-spec-for-ai-agent`, `@lodado/personaut`다.
- 루트 `packages/*`는 현재 모두 private workspace package다.
- 기존 public app 중 `playwright-spec-for-ai-agent`는 `.mjs` 중심이며 별도 `lint/typecheck` script 없이 `vitest run`을 gate로 사용한다.
- `CLAUDE.md`는 published package 변경 PR에 Changesets version bump를 요구한다. 신규 Design Convergence는 public release 전까지 private로 두므로 초기 phase에는 changeset을 만들지 않는다.

## 선행 조건

- Node.js 20 이상을 유지한다.
- 새 코드는 TypeScript를 사용한다.
- 기존 published packages의 API나 bundle에 Design Convergence를 섞지 않는다.
- Design Convergence가 공개 package가 되는 시점까지 `private: true`를 유지한다.

## 생성/수정 예정 파일

Phase 01에서는 아래 세 workspace와 공통 TypeScript 설정만 만든다.

```text
apps/design-convergence/
  package.json
  tsconfig.json
  src/

packages/design-convergence-shared/
  package.json
  tsconfig.json
  src/

packages/design-convergence-config/
  package.json
  tsconfig.json
  src/

tsconfig.base.json
```

`packages/design-convergence-figma`는 Figma 구현이 시작되는 Phase 02에서 생성한다.

보류할 package:

- `design-convergence-binding`
- `design-convergence-ai`
- `design-convergence-instrumentation`
- `design-convergence-browser`
- `design-convergence-comparison`
- `design-convergence-attribution`
- `design-convergence-patching`
- `design-convergence-verifier`
- `design-convergence-report`
- `design-convergence-github`

각 package는 해당 phase에서 두 번째 실제 사용자가 생기거나 package boundary가 테스트/배포 경계를 단순화할 때만 생성한다.

## 목표 dependency graph

```text
figma           -> shared
instrumentation -> shared
browser         -> shared, config
comparison      -> shared
ai              -> shared
binding         -> shared, figma, instrumentation, browser, ai
attribution     -> shared, browser, binding
patching        -> shared, config, ai, attribution
verifier        -> shared, config, browser, comparison, patching
report          -> shared, comparison, attribution, verifier
github          -> config, report, verifier
CLI app         -> phase packages; no package imports the CLI app
```

`A -> B`는 A가 B에 의존한다는 뜻이다. 실제 package를 만들 때 `pnpm` dependency graph와 `turbo` build graph에서 cycle이 없는지 확인한다. 공개 예정인 `@design-convergence/config`는 private runtime package에 의존하지 않는다.

`patching`과 `verifier`는 v0.1에서 **한 package로 시작**한다. 소비자가 CLI 하나뿐이고 함께 배포되며 verifier가 patching의 apply에 직접 의존하고, 지켜야 할 핵심 신뢰 경계는 `ai -> patching` 사이지 `patching -> verifier` 사이가 아니기 때문이다. 처리량/재사용 압력이 실제로 생기면 그때 분리한다.

**npm 이름(2026-07-30 확인):** unscoped `design-convergence`는 미점유이고 `@design-convergence` scope 하위 published package는 0개다. 계획대로 이름 확보를 Phase 10까지 미루면 선점당할 위험이 있다. 유지관리자는 code 작성 초기에 npm org `design-convergence` 예약(placeholder publish) 또는 기존 `@lodado/*` scope로의 통일 중 하나를 결정해야 한다. 이 저장소는 이미 `@lodado/personaut`와 unscoped `playwright-spec-for-ai-agent`를 함께 쓰므로 두 방식 모두 선례가 있다. 예약 자체는 publish 권한이 필요한 유지관리자 작업이다.

## 작은 체크박스 작업

- [ ] `apps/design-convergence`를 private CLI workspace로 추가한다.
- [ ] `packages/design-convergence-shared`에 versioned schemas, result/error utilities, redaction utilities를 둔다.
- [ ] `packages/design-convergence-config`에 config loading과 Zod validation을 둔다.
- [ ] Phase 02에서만 `packages/design-convergence-figma`를 추가한다.
- [ ] Phase 01에서는 root `pnpm-workspace.yaml`를 수정하지 않는다. Phase 03에서만 `examples/design-convergence-*` narrow glob을 추가한다.
- [ ] CLI skeleton이 실행되면 root `package.json`에 `pnpm design-convergence ...` 전달 script를 추가한다.

## 신뢰 경계

`design-convergence.config.ts`, case `prepare`, target app, formatter, build, lint, test는 모두 프로젝트 코드를 실행할 수 있다. 따라서 v0.1은 다음 두 모드를 구분한다.

- **Data-only:** 제한된 config 정적 파싱, fixture normalization, source indexing, 저장 artifact diff/report. 프로젝트 모듈이나 명령을 실행하지 않는다.
- **Operator-approved execution:** app/prepare/Playwright/verification/Git/GitHub. config의 필수 동의와 명시된 argv만 사용한다.

v0.1은 임의의 제3자 저장소를 host에서 안전하게 실행하는 sandbox라고 주장하지 않는다. 완전한 untrusted execution은 별도 OS 사용자, container 또는 VM 격리가 준비된 뒤에만 지원 범위로 올린다. 다만 실행 승인 여부와 무관하게 path containment, secret redaction, AI context 최소화, patch/worktree 정책은 항상 적용한다.

## 재사용 조사 결과

직접 재사용하는 것은 Node 20 stdlib, pnpm/Turbo/Changesets, Playwright/Vitest의 저장소 버전과 local `node:http` fixture 패턴이다. 아래 코드는 도메인 결합 때문에 import하지 않고 불변조건과 적대적 테스트만 참고한다.

| 현재 파일                                                          | 참고할 검증된 패턴                                                        | 직접 의존하지 않는 이유                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/contracts/index.mjs`                                     | canonical hash, stable ID, versioned artifact                             | Personaut schema 전용, Zod/TypeScript 아님          |
| `apps/playwright-spec-for-ai-agent/packages/cli/qa-native.mjs`     | strict `parseArgs`, private path, symlink/no-follow, secret-safe error    | QA Native command/artifact 계약 전용                |
| `apps/playwright-spec-for-ai-agent/packages/evidence/index.mjs`    | 중앙 redaction, bounded/hashed artifact                                   | QA evidence contract 전용                           |
| `packages/playwright-driver/src/index.mjs`                         | isolated BrowserContext, viewport/locale/timezone, stabilization fixtures | raw locator/CDP/style extraction을 노출하지 않음    |
| `apps/playwright-spec-for-ai-agent/packages/remediation/index.mjs` | exact revision/hash, worktree, diff mutation, `shell:false` verifier      | QA IR/remediation contract 전용                     |
| `packages/reporter-html/src/index.mjs`                             | static HTML escaping/redaction                                            | behavioral report section 전용                      |
| `packages/reporter-github/src/index.mjs`                           | bounded GitHub argv/env와 infrastructure 분리                             | Design Convergence는 draft PR 생성 계약이 별도 필요 |

두 번째 공용 caller가 실제로 생기기 전에는 기존 코드를 억지로 generic safety package로 추출하지 않는다.

## 가정과 주요 위험

### 가정

- Node 20+, pnpm 10.33, Chromium, Git worktree를 사용할 수 있다.
- target feature는 clean commit에 있고 case data/font/image가 재현 가능하다.
- v0.1 Next.js target은 조건부 Babel integration을 수용한다.
- 첫 slice는 한 case, 한 Figma root, 한 visible element per binding이다.
- live Figma/AI/GitHub smoke는 credential이 있는 opt-in 환경에서만 실행한다.

### 위험과 대응

| 위험                                          | 계획상 대응                                                    |
| --------------------------------------------- | -------------------------------------------------------------- |
| Figma와 CSS 모델이 정확히 대응하지 않음       | approximation/unsupported를 명시하고 equal로 축약하지 않음     |
| 높은 AI confidence가 잘못된 DOM 경계를 가리킴 | static + runtime validation 전에는 `validated` 금지            |
| Next.js 기본 SWC와 Babel plugin 간극          | 조건부 Babel 범위를 문서화하고 SWC 지원을 주장하지 않음        |
| font/image/animation 때문에 diff가 흔들림     | stabilization 실패를 infrastructure로 분리                     |
| CSS/Tailwind attribution이 모호함             | ambiguity를 review-required로 남기고 auto-patch 금지           |
| shared component가 다른 case를 망침           | affected-first 이후 full-suite regression gate                 |
| AI context에 source/secret이 과다 노출됨      | candidate narrowing, byte budget, 중앙 redaction, no tools     |
| target command가 host를 손상시킴              | explicit operator approval; 완전 untrusted는 외부 sandbox 필요 |

## 첫 vertical slice

```text
Next.js pricing page
→ fixture-backed Figma Pricing Card
→ proposed manual binding + source preflight
→ exact Babel static validation and test-only attribute
→ Playwright runtime binding validation
→ computed style + layout box extraction
→ height/padding/background/radius/font-size/font-weight/text-color/border diff
→ terminal + schema-versioned JSON report
```

AI binding, source attribution, patching, HTML report, GitHub PR은 이 slice가 양방향(pass/mismatch) fixture로 통과하기 전 시작하지 않는다.

## Master prompt 기본안에서의 의도적 변경

| 기본안                                                        | 이 저장소의 결정                                                                     | 이유                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 별도 `design-convergence/` monorepo처럼 보이는 구조           | 기존 root 아래 `apps/design-convergence`, `packages/design-convergence-*`            | 이미 pnpm/Turbo/Changesets monorepo가 있음                             |
| `packages/config` 같은 generic directory                      | 모든 신규 directory에 `design-convergence-` prefix                                   | 기존 Personaut package와 충돌/혼동 방지                                |
| client/extractor/normalizer/diff 등을 처음부터 모두 package화 | phase별 현재 boundary만 생성하고 Figma/comparison 내부 module로 시작                 | speculative micro-package 방지                                         |
| `apps/report-viewer`                                          | v0.1 static HTML package만 구현                                                      | interactive app의 현재 use case 없음                                   |
| executable `config.ts` import                                 | v0.1은 `config.json` + Zod 검증(무실행); 제한된 TS-AST loader는 수요 확인 시 추가    | target repo code의 묵시적 실행을 코드 0줄로 방지                       |
| root `artifacts/`                                             | private `.design-convergence/{cache,artifacts,worktrees}`                            | accidental commit와 path policy 단순화                                 |
| transparent Next/SWC integration 기대                         | conditional Babel integration만 지원                                                 | first adapter가 Babel이라는 명시 요구와 현실적 Next 제약을 동시에 공개 |
| Recast/jscodeshift 중 하나를 미리 선택                        | instrumentation은 Babel plugin, static JSX patch는 Babel parse/generate + AST policy | 이미 필요한 Babel toolchain으로 현재 두 변환을 안전하게 해결           |

나머지 기본 기술(TypeScript, pnpm, Zod, Playwright, Babel parser/traverse, Vitest, Figma REST, Chromium, Git worktree)은 유지한다.

## 테스트 우선 절차

1. workspace 생성 전에 package naming과 private policy를 문서로 확정한다.
2. 첫 package마다 실패하는 최소 테스트를 먼저 추가한다.
3. 테스트는 feature별로 한 개의 fixture-backed happy path와 한 개의 boundary failure를 둔다.
4. 기존 MJS package의 테스트 구현체를 import하지 않는다.
5. 기존 패턴 중 재사용할 원칙만 차용한다.
   - schemaVersion을 저장 artifact에 포함한다.
   - validation failure는 path/provenance를 가진다.
   - browser/app evidence와 판단을 분리한다.

## 실제 검증 명령

아래 명령은 Phase 01에서 workspace가 생긴 뒤 실행한다.

```bash
pnpm --filter @design-convergence/shared test
pnpm --filter @design-convergence/config test
pnpm --filter design-convergence test
pnpm --filter design-convergence build
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

현재 문서 작성 시점에는 package가 없으므로 위 명령은 실행 대상이 아니다.

## 종료 게이트

- 신규 package가 모두 `private: true`다.
- published packages를 변경하지 않았다.
- Design Convergence 코드가 기존 MJS persona packages에 import로 결합하지 않는다.
- 첫 vertical slice 범위가 AI 없이 fixture/manual binding으로 제한된다.
- `.design-convergence/{cache,artifacts,worktrees}`를 runtime private root로 사용하고 저장소에 commit하지 않는다고 합의되어 있다.

## 다음 phase 진입 게이트

Phase 01로 진입하려면 다음 결정을 유지한다.

- config와 shared contract부터 만든다.
- app command 실행은 기본 자동 실행이 아니라 operator-approved execution으로 둔다.
- secret/path/provenance/error taxonomy를 나중으로 미루지 않는다.

## 의도적 보류

- AI provider adapter: Phase 05 전까지 만들지 않는다.
- GitHub PR 생성: Phase 09 전까지 만들지 않는다.
- package publish/changeset: private 개발 중에는 만들지 않는다.
- 전체 package 트리 선생성: 실제 import 경계가 필요할 때까지 보류한다.
