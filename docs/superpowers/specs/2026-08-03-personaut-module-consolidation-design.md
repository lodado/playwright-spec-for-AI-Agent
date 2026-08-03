# Personaut 모듈 통합 + 공유 모듈 추출 설계

날짜: 2026-08-03
상태: 설계 승인 대기
범위: `apps/personaut` + 루트 `packages/@persona-runtime/*` + 양 앱 공유 모듈

## 목적

복잡성을 줄여 최대한 단순하게. personaut의 10개 워크스페이스 패키지를
playwright-spec-for-ai-agent 방식(앱 내부 파일, 조립 1개, 경계는 문서와
테스트로 강제)으로 재구성하고, 두 앱이 실제로 중복 구현 중인 코드를 공유
모듈로 추출한다.

## 실측 근거 (2026-08-03 확인)

1. **personaut CLI가 소스 실행 시 기동부터 깨져 있음.**
   `packages/playwright-spec-adapter/src/legacy/parser.mjs`가
   `../../../../apps/playwright-spec-for-ai-agent/scripts/dashboard-spec-parser.mjs`를
   재수출하는데 해당 파일이 존재하지 않음 (리네임됨). `src/index.mjs`가
   톱레벨에서 import하므로 CLI 전체가 기동 실패.
2. `qa-native` 쪽 `static-authority/index.mjs:2`도
   `../../scripts/playwright-spec-parser.mjs` 상대경로 import — 같은 유형의
   앱 경계 꿰맴.
3. `expectation-abstractor`가 양 앱에 복붙 후 드리프트
   (scripts `1.1.0` vs adapter `1.0.0`, 패턴 목록 상이).
4. persona-runtime 10개 패키지: 의존 그래프 완전 평면(전부 contracts만 바라봄),
   대부분 단일 index.mjs, 전부 private(발행 안 됨), personaut 빌드 시 esbuild로
   dist에 번들됨 → 패키지 경계가 배포에 무의미.
5. `reporter-github`, `provider-fixture`는 어디서도 import 안 됨 (죽은 코드,
   삭제는 보류).
6. `persona-policy`만 유일하게 TypeScript(tsc 빌드 필요), 나머지 전부 .mjs.
7. 스키마 버전 상수 중복은 1건: runtime-core:20
   `OBSERVATION_SCHEMA_VERSION = "observation/0.1"`이 contracts
   `OBSERVATION_VERSION`과 같은 값을 재정의(import 아님).
   `RUNTIME_SESSION_SCHEMA_VERSION = "runtime-session/0.1"`은 contracts
   `SESSION_VERSION = "session/0.1"`과 **다른 계약**이므로 통합 금지.
   INTERACTION_EVENT/EVIDENCE_MANIFEST는 이미 contracts에서 import한 별칭.
8. 앱 간 실중복 (공유 후보 검증 결과):
   - canonical hash: personaut contracts:43-72 vs qa-native contracts:141-150.
     qa-native 소비처 11곳.
   - DOM settle: personaut driver:417 quietMs 로직 vs qa-native
     `settleGatewayDom`(runtime/playwright.mjs). 회귀 역사(hydration settle,
     strict race)가 전부 이 레이어.
   - redaction: hermes-transport:338 `redactSensitiveText` vs qa-native
     evidence:233 자체 구현.
   - atomic 파일 쓰기: **공유 후보 아님** — qa-native는 plain `writeFileSync`
     사용. personaut 내부에서만 2벌(`atomicJson`/`atomicWrite`) 중복.
   - hermes-transport: 이미 공유 중 (유일한 기존 공유 패키지).

## 목표 구조

```
apps/personaut/
  bin/personaut.mjs
  src/
    index.mjs                 # CLI 조립 (유일한 composition, 기존)
    hermes-action-policy.mjs  # AI 액션 제안 (기존)
    contracts.mjs             # ← packages/contracts (811줄). 어휘·검증·버전 단일 소유
    runtime.mjs               # ← runtime-core (835줄). 상태기계·runStudy/runSession·봉인·atomic 쓰기 단일화
    driver.mjs                # ← playwright-driver (928줄). Playwright import 유일 지점
    persona-policy.mjs        # ← persona-policy TS→mjs+JSDoc (380줄). tsc 소멸
    spec-adapter.mjs          # ← IR→StudySpec 컴파일러만 (135줄). 파싱은 spec-extract로
    evaluator.mjs             # ← evaluator (975줄)
    reporter-html.mjs         # ← reporter-html (285줄)
  test/                       # 패키지별 테스트 합류, node --test 유지
  ARCHITECTURE.md             # 파이프라인 도식, 파일별 역할 1줄, invariant 3개, import 규칙

packages/                     # 워크스페이스 잔류 = 공유 3개 + design-convergence 가족
  hermes-transport/           # 기존 공유
  playwright-spec-extract/    # 신규 공유: Playwright 소스 → IR 추출까지만
    ast-parser.mjs            # ← scripts/playwright-ast-parser.mjs (479줄)
    spec-parser.mjs           # ← scripts/playwright-spec-parser.mjs (665줄)
    expectation-abstractor.mjs # 두 벌 병합(규칙 합집합), 버전 단일화
  qa-kit/                     # 신규 공유: subpath export 3개
    canonical.mjs             # canonicalJson/canonicalHash/stableId
    settle.mjs                # DOM quiet 메커니즘 (정책값은 앱별 주입)
    redact.mjs                # redaction 규칙 엔진 + 기본 규칙
```

### 경계 규칙

- `playwright-spec-extract`는 추출(IR)까지만. IR 해석(StudySpec /
  BehavioralSpec 컴파일)은 각 앱 소유.
- `qa-kit/settle`은 메커니즘만 공유, quietMs/cap 등 정책값은 앱별 주입.
  공유 = 결합이므로 양 앱 골든 테스트가 변경 게이트.
- `qa-kit/redact`는 엔진과 기본 규칙만. qa-native 설계 규칙 5번(컨텍스트별
  보안 파서 분리, 만능 sensitive-key 정규식 금지) 유지 — URL/헤더/JSON/텍스트
  파서는 각 앱에 남김.
- personaut 내부: contracts는 import 0(leaf), Playwright import는 driver만,
  hermes 호출은 hermes-action-policy만. 소형 import-방향 테스트로 강제.
- design-convergence 가족(6개)은 별개 제품 — 이번 범위에서 안 엮음.

### 빌드 축소 (personaut) — 직발행 불가 확정

- 평탄화 후에도 private 워크스페이스 의존(hermes-transport, spec-extract,
  qa-kit)이 남음 → npm에 없는 deps라 src 직발행 시 설치 깨짐. **esbuild
  prepack 번들 유지.**
- 제거: tsc(persona-policy .mjs 전환으로), `pnpm --filter` 선행 빌드.
- 유지: prepack esbuild 한 줄 + `--sourcemap` 추가 (스택트레이스 원본 라인).
- 테스트·개발은 src 직접 실행(node --test는 빌드 불필요). CLI 스모크만
  `pnpm build` 선행.

### 에러 provenance 통일 (personaut)

- 공통 base 에러 + `provenance: "infra" | "contract" | "ux"` 태그.
- `RuntimeCoreError`/`EvaluatorError`/`ContractValidationError` 승계.
- "인프라 에러는 UX finding으로 둔갑 금지" invariant를 타입으로 강제.

## PR 순서

각 PR 독립적으로 그린 유지. 발행 패키지 변경 시 changeset 필수.

### PR-1: `playwright-spec-extract` 공통화 (사고 수리)

1. 패키지 생성, scripts 파서 2개 이동, abstractor 두 벌 병합.
2. 양 앱 workspace import 전환. 4단 상대경로 재수출 2곳 삭제
   (adapter `legacy/parser.mjs`, static-authority의 scripts 참조).
3. 게이트: personaut CLI 기동 스모크(현재 깨진 것 복구 확인), 양쪽 테스트
   그린, abstractor 동등성 테스트(양쪽 기존 출력 보존), 양쪽
   `npm pack --dry-run` 번들 인라인 확인.
4. changeset: `@lodado/personaut` patch(기동 fix),
   `playwright-spec-for-ai-agent` patch.

### PR-2: personaut 평탄화 + 빌드 소멸

1. 루트 패키지 7개 → `apps/personaut/src/*.mjs` 이동. persona-policy
   TS→mjs+JSDoc. 테스트 `test/` 합류.
2. `OBSERVATION_SCHEMA_VERSION` 재정의를 contracts import 별칭으로 교체
   (다른 버전 상수는 값 그대로 유지 — 해시 회귀 방지).
3. atomic 쓰기 personaut 내부 단일화(runtime.mjs 한 벌).
4. 빌드 축소(위 절), import-방향 테스트 추가.
5. 루트에서 이동된 빈 패키지 디렉토리 정리. reporter-github/provider-fixture
   삭제는 보류(별도 결정).
6. 게이트: node --test 그린(이주 전후 케이스 수 동일), CLI run 스모크 1회,
   `npm pack --dry-run` 레이아웃 확인.
7. changeset: `@lodado/personaut` patch.

### PR-3: `qa-kit` 추출

1. canonical 먼저(순수함수, 위험 0) → settle(골든 테스트 동반) → redact 엔진.
2. 양 앱 소비 전환. settle 정책값 주입 인터페이스 확인.
3. 게이트: 양쪽 테스트 그린, settle 골든 테스트(기존 타이밍 행동 보존),
   증거 해시 회귀 테스트(canonical 전환 전후 동일 해시).
4. changeset: 두 발행 패키지 patch.

### PR-4: provenance + ARCHITECTURE.md

1. 에러 base 통일(위 절).
2. `apps/personaut/ARCHITECTURE.md` 작성.
3. 게이트: 테스트 그린 + provenance가 리포트/stderr에 노출되는 케이스 1개.
4. changeset: `@lodado/personaut` patch.

## 명시적 보류 (이번 범위 아님)

- reporter-github / provider-fixture 삭제 (죽은 코드, 사용자 결정 대기).
- atomic 쓰기의 qa-native 이식 (행동 변경).
- run 실패 분류 실측(fail-loud vs 인프라 vs 로직) — 다음 단순화 표적 선정용.
- design-convergence 가족과의 공유.

## 리스크

- **abstractor 병합**: 의미 드리프트 2벌 → 단순 덮어쓰기 금지. 규칙 합집합
  - 양쪽 출력 동등성 테스트가 필수 게이트.
- **settle 공유**: 타이밍 행동 결합. 골든 테스트 없이 병합 금지.
- **redact 공유**: 보안 코드. 엔진만 공유, 컨텍스트 파서 유지. 축소 방향
  변경(규칙 제거)은 이번 범위 금지.
- **발행 레이아웃**: prepack 번들이 workspace dep을 인라인하는지 PR-1/PR-2
  각각 `npm pack --dry-run`으로 확인. AGENTS.md §2 동기화 매트릭스 해당 행
  점검(스펙 컴파일 경로 변경).
