# 00. 결정, 범위, 제품 원칙

## 1. Architecture Decision

### 결정

기존 `lodado/playwright-spec-for-AI-Agent` 저장소를 유지하고 모노레포로 전환한다.

현재 npm 패키지 `playwright-spec-for-ai-agent`는 compatibility package로 보존한다.
새 `Persona Runtime`은 같은 저장소 안에서 독립 코어로 구현한다.

### 선택하지 않은 대안

#### 기존 `scripts/*.mjs`에 계속 기능 추가

선택하지 않는다.

현재 구조는 `spec`, `abstract-ai`, `judge`, `review`, `slack`, `nightly`를
각각 별도 스크립트로 spawn하는 단순 파이프라인에 적합하다.
새 시스템에 필요한 session lifecycle, concurrency, cancellation, evidence store,
model gateway, multi-session aggregation에는 맞지 않는다.

#### 완전히 새 저장소 생성

현재는 선택하지 않는다.

새 프로젝트는 기존 프로젝트의 문제 정의와 자산을 직접 계승한다.
저장소를 나누면 QA IR, live policy, expectation abstraction, issue roadmap,
README 서사와 사용자가 분산된다.

### 재검토 조건

다음 조건이 실제로 생기면 별도 저장소 또는 별도 비공개 SaaS 저장소를 검토한다.

- SaaS 코드가 오픈소스 런타임보다 훨씬 커진다.
- 멀티테넌시·과금·조직 권한·운영 인프라가 공개 런타임과 분리되어야 한다.
- 기업용 온프레미스 배포와 공개 npm 릴리스의 보안 정책이 충돌한다.
- 팀과 릴리스 주기가 완전히 분리된다.

오픈소스 Runtime 자체는 현재 저장소에 남긴다.

---

## 2. 제품이 답해야 할 질문

```text
기능이 실제로 작동하는가?
사용자가 목표를 달성할 수 있는가?
어디서 반복적으로 막히는가?
어떤 행동 정책에서 문제가 더 심한가?
이전 버전보다 나빠졌는가?
판단을 뒷받침하는 실행 증거가 있는가?
AI 사용자 결과를 어디까지 믿어도 되는가?
사람 검증이 필요한가?
```

## 3. 제품이 답하지 않는 질문

```text
실제 전환율은 정확히 몇 퍼센트가 될 것인가?
실제 고객 중 몇 퍼센트가 디자인을 좋아할 것인가?
AI 사용자가 실제 사용자 전체를 대체할 수 있는가?
특정 연령·성별·문화 집단이 반드시 어떻게 행동할 것인가?
```

결과 문구는 상대적·증거 기반으로 제한한다.

허용:

> candidate 버전에서 낮은 도메인 지식 그룹의 과업 중단이 baseline보다 반복적으로 증가했다.

금지:

> 실제 고객 전환율이 12% 감소할 것이다.

---

## 4. 핵심 설계 원칙

### 4.1 Evidence precedes judgment

판정 전에 evidence가 먼저 완성되어야 한다.

```text
Execution Agent
→ immutable Evidence Bundle
→ browser termination
→ deterministic oracle
→ independent browserless Judge
```

Judge는 browser tool, repository write, credential을 받지 않는다.

### 4.2 Code owns workflow, AI owns localized reasoning

코드가 담당할 것:

- 단계 순서
- 상태 전이
- timeout
- retry 한도
- origin 및 action safety
- oracle
- evidence linkage
- schema validation
- severity rule
- publication gate

AI가 담당할 것:

- 현재 observation에서 다음 사용자 행동 후보 선택
- 관찰된 세션의 제한된 해석
- 이미 생성된 friction point의 semantic clustering 보조
- 근거가 연결된 추천안 작성

AI가 workflow authority가 되어서는 안 된다.

### 4.3 Functional과 Behavioral을 분리한다

```text
Functional failure
API 500, 페이지 crash, 목표 상태 미생성

Behavioral friction
기능은 성공했지만 다음 행동을 발견하지 못함

Business friction
가치를 경험했지만 가격·업그레이드 경로가 끊김
```

한 finding은 primary category 하나를 가진다.

### 4.4 실패와 이탈은 정상 결과다

Behavioral Agent는 반드시 성공할 필요가 없다.

- `abandoned`
- `partial`
- `failure`

는 제품 결함이 아닐 수도 있으며, persona policy가 허용하는 정상 세션 결과다.

### 4.5 Behavioral non-healing

자동화 안정성을 위한 locator fallback과 사용자 발견성을 분리한다.

- executor는 같은 visible element의 locator 변화는 복구할 수 있다.
- persona는 숨겨진 DOM, offscreen control, 보이지 않는 selector를 검색하지 않는다.
- 사용자에게 보이지 않은 요소를 agent가 DOM으로 찾아 성공하면 세션은 오염된 것으로 본다.

### 4.6 Deterministic evaluation before model judgment

URL, DOM state, event, network, console, download, storage state 등으로 판정 가능한 것은
AI에게 맡기지 않는다.

### 4.7 Versioned contracts at every boundary

다음 객체는 모두 `schemaVersion`을 가진다.

- QA IR
- StudySpec
- Session Record
- Observation
- InteractionEvent
- Evidence Manifest
- Functional Evaluation
- Behavioral Evaluation
- Finding
- Simulation Validity Report
- Variant Comparison Report

### 4.8 Human validation is a first-class output

다음 중 하나를 결과에 포함한다.

```text
exploration_only
release_warning
human_review_required
human_validation_required
decision_support
```

---

## 5. MVP 범위

### 포함

- URL 또는 Playwright spec에서 StudySpec 생성
- direct Playwright browser runtime
- semantic + visual + runtime observation
- 제한된 action schema
- 세션별 isolated BrowserContext
- 행동 policy preset 3~5개
- seeded policy sampling
- success/failure/abandonment
- evidence manifest와 hash
- deterministic oracle
- browserless functional/behavioral evaluator
- BehavioralFingerprint
- diversity 및 hyperactivity risk
- finding clustering
- JSON + static HTML report

### 제외

- 완성형 SaaS dashboard
- 결제·조직·RBAC
- 수백 browser 동시 실행
- 개인 단위 digital twin
- 실제 전환율 예측
- Figma 자동 테스트
- 모바일 네이티브 앱
- 자동 코드 수정
- 자동 Draft PR 게시
- 모든 LLM provider 지원
- 학습 기반 click policy
- 실제 production traffic에서 destructive flow

---

## 6. 장기 확장

MVP 이후 순서는 다음과 같다.

1. baseline/candidate behavioral regression
2. GitHub PR Check
3. PostHog/session replay 기반 cluster calibration
4. multi-user journey
5. Storybook/Figma adapter
6. code-aware diagnosis
7. 기존 remediation epic `#13~#23`과 연결
8. 검증된 Issue 또는 Draft PR

자동 수정은 실행·증거·판정·진단·코드 위치·patch verification이 분리된 뒤에만 진행한다.
