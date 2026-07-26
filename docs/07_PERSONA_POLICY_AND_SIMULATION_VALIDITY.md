# 07. Persona Policy와 Simulation Validity

## 1. 핵심 개념

페르소나는 “34세 마케터, 여행을 좋아함” 같은 이야기만이 아니다.

```text
Narrative Context
+ Behavioral Policy
+ Attention Policy
+ Abandonment Policy
+ Seeded Sampling
```

인구통계에서 행동 특성을 자동 추론하지 않는다.

금지:

```text
65세 → digital literacy 낮음
여성 → 위험 회피 높음
특정 국가 → 가격 민감
```

행동 값은 사용자 입력, preset, 실제 cluster data 중 하나에서 온다.

---

## 2. PersonaSpec

```ts
interface PersonaSpec {
  id: string;
  name: string;
  description: string;

  source:
    | { type: "preset"; presetId: string }
    | { type: "manual" }
    | {
        type: "observed_cluster";
        datasetId: string;
        clusterId: string;
        sampleSize: number;
      };

  narrative: {
    situation: string;
    motivation: string;
    priorKnowledge: string[];
    misconceptions?: string[];
  };

  policy: BehaviorPolicyDefinition;
  attention: AttentionPolicyDefinition;
  abandonmentRules: AbandonmentRule[];

  grounding: {
    domain?: string;
    productId?: string;
    dataWindow?: { from: string; to: string };
    knownUncertainties: string[];
  };
}
```

---

## 3. Probabilistic policy

고정 score만 쓰지 않고 분포를 지원한다.

```ts
type Distribution =
  | { type: "fixed"; value: number }
  | {
      type: "categorical";
      values: Array<{ value: number | string; probability: number }>;
    }
  | { type: "beta"; alpha: number; beta: number }
  | { type: "normal"; mean: number; stddev: number; min?: number; max?: number }
  | { type: "empirical"; samples: number[] };
```

```ts
interface BehaviorPolicyDefinition {
  retryPropensity: Distribution;
  backtrackPropensity: Distribution;
  abandonmentPropensity: Distribution;
  signupResistance: Distribution;
  priceSensitivity: Distribution;
  explorationDepth: Distribution;
  readingDepth: Distribution;
  errorRecoveryAttempts: Distribution;
  noActionPropensity: Distribution;
}
```

Study seed에서 session seed를 파생한다.

```text
sessionSeed = hash(studySeed, taskId, personaId, variant, repetitionIndex)
```

같은 seed에서는 policy sample이 재현되어야 한다.

---

## 4. Initial presets

### impatient_new_user

- skim
- 작은 no-progress budget
- signup 전 가치 요구
- 오류 재시도 적음
- secondary navigation 탐색 낮음

### careful_business_buyer

- security/privacy/pricing 탐색
- 긴 reading budget
- 높은 trust threshold
- trial보다 documentation/contact route 선호 가능

### low_domain_knowledge_user

- 용어 오해 가능
- 명확한 label 의존
- 복잡한 IA에서 backtrack 증가
- 제품 내부 약어를 사전 지식으로 갖지 않음

### exploratory_power_user

- 높은 exploration depth
- filter/settings 탐색
- 오류 복구 시도 많음
- shortcut 발견 가능

### price_sensitive_user

- 가격 페이지 탐색 확률 높음
- 가격 불투명 시 이탈
- signup/paywall 저항
- 무료 범위 우선

preset은 truth가 아니라 `uncalibrated default`다.

---

## 5. Attention Model

화면에 존재하는 것과 사용자가 인지하는 것을 구분한다.

```ts
interface AttentionPolicyDefinition {
  viewportOnly: boolean;
  maxCandidateElements: number;

  primaryCtaWeight: number;
  headingWeight: number;
  textGoalMatchWeight: number;
  visualSaliencyWeight: number;
  priorExpectationWeight: number;

  inspectBelowFoldProbability: Distribution;
  inspectSecondaryNavigationProbability: Distribution;
}
```

pipeline:

```text
Full Observation
→ visibility filter
→ saliency/semantic scoring
→ persona attention weights
→ seeded selection
→ PerceivedObservation
```

원본 observation은 evidence에 남기고, perceived set도 별도로 기록한다.
그래야 “CTA는 실제로 있었지만 이 persona에게 노출되지 않았다”를 재현할 수 있다.

---

## 6. Non-action support

LLM agent가 무엇이든 클릭하려는 성향을 줄이기 위해 다음을 first-class action으로 둔다.

- `observe_more`
- `ignore`
- `idle`
- `defer`
- `abandon`

단, 무한 loop를 막는다.

```text
maxConsecutiveNonProgressActions
maxIdleDuration
maxObserveMoreCount
```

---

## 7. Persona state reducer

일부 state는 AI가 아니라 코드가 갱신한다.

```ts
interface PersonaRuntimeState {
  perceivedProgress: number;
  frustration: number;
  trust: number;
  perceivedValue: number;
  confidence: number;

  noProgressCount: number;
  recoveryAttempts: number;
  backtrackCount: number;

  knownFacts: string[];
  uncertainties: string[];
}
```

예:

```text
success oracle 일부 충족
→ progress 증가

동일 route 반복
→ noProgress 증가

failed click
→ frustration 증가

연속 5xx
→ trust 감소

명확한 오류 후 복구 성공
→ progress/trust 일부 회복
```

AI가 숫자를 마음대로 출력해 state를 덮어쓰지 않는다.

---

## 8. Abandonment policy

```ts
interface AbandonmentDecision {
  shouldAbandon: boolean;
  reasonCode:
    | "no_progress"
    | "unexpected_signup"
    | "low_perceived_value"
    | "trust_failure"
    | "price_uncertainty"
    | "repeated_error"
    | "action_budget"
    | "time_budget"
    | "persona_choice";

  deterministicSignals: string[];
  sampledProbability?: number;
}
```

결정 순서:

1. hard budget
2. safety blocker
3. deterministic abandonment rule
4. sampled policy
5. action model choice

---

## 9. BehavioralFingerprint

모든 세션 종료 후 생성한다.

```ts
interface BehavioralFingerprint {
  sessionId: string;

  actionCount: number;
  actionTypeRates: Record<string, number>;
  uniqueActionTypeCount: number;

  routeSequence: string[];
  routeEntropy: number;

  firstActionType?: string;
  firstActionTargetFingerprint?: string;

  backtrackRate: number;
  retryRate: number;
  failedInteractionRate: number;
  noActionRate: number;

  abandonmentOccurred: boolean;
  abandonmentRoute?: string;
  abandonmentReasonCode?: string;

  errorReactionVector: {
    retry: number;
    backtrack: number;
    ignore: number;
    abandon: number;
  };

  progressCurve: number[];
  frustrationCurve: number[];
  trustCurve: number[];

  goalDirectednessScore: number;
}
```

---

## 10. Population diversity

```ts
interface PopulationDiversityReport {
  sessionCount: number;
  personaCount: number;

  intraPersonaDistance: number | "not_available";
  interPersonaDistance: number | "not_available";
  personaSeparability: number | "not_available";

  routeEntropy: number;
  actionEntropy: number;
  clusterCoverage: number;

  homogenizationRisk: "low" | "medium" | "high" | "unknown";
  warnings: string[];
}
```

초기 거리 계산:

- normalized action type vector cosine distance
- route n-gram Jaccard distance
- outcome/abandonment categorical distance
- backtrack/retry/action count standardized distance

복잡한 embedding clustering은 후속이다.

---

## 11. Validity risk detectors

### Hyperactivity

위험 신호:

- 모든 세션이 maxActions 근처
- 실제 사람이 이탈할 법한 blocker 뒤에도 계속 시도
- no-action/abandon이 전혀 없음
- recovery attempts가 preset policy 범위를 초과
- irrelevant navigation 증가

실제 human reference가 없으면 “검출된 사실”이 아니라 `risk heuristic`으로 표시한다.

### Excessive cooperation

- 모든 signup/privacy 요청을 수용
- 모든 required field를 추측해서 채움
- 불명확한 제품 가치에도 계속 진행
- 도움말/외부 문서를 비정상적으로 끝까지 탐색

### Persona homogenization

- persona 간 거리와 persona 내부 거리 차이가 작음
- route cluster가 하나
- 모든 persona의 outcome/action count가 거의 동일
- model 교체 효과가 persona 효과보다 큼

### Positivity/Utopian bias

- 부정/무시/이탈 반응이 거의 없음
- 모든 제품 copy를 사실로 받아들임
- trust가 오류에도 거의 감소하지 않음

### Directive amplification

강한 narrative adjective가 행동을 극단화하는지 실험한다.

```text
A: "매우 성급한 사용자"
B: 중립 narrative + 같은 policy
C: policy only
```

B/C 대비 A가 지나치게 극단적이면 warning.

---

## 12. SimulationValidityReport

```ts
interface SimulationValidityReport {
  schemaVersion: "simulation-validity/0.1";

  calibration:
    | {
        level: "uncalibrated";
        reason: string;
      }
    | CalibrationReport;

  stability: {
    seedVariance: number | "not_available";
    modelAgreement: number | "not_available";
    orderConsistency: number | "not_available";
  };

  diversity: PopulationDiversityReport;

  detectedRisks: Array<
    | "hyperactivity"
    | "excessive_cooperation"
    | "positivity_bias"
    | "directive_amplification"
    | "persona_homogenization"
    | "domain_transfer"
    | "position_bias"
    | "insufficient_sample"
  >;

  recommendedUse:
    | "exploration_only"
    | "release_warning"
    | "human_review_required"
    | "human_validation_required"
    | "decision_support";

  forbiddenInterpretations: string[];
}
```

---

## 13. Calibration

실제 데이터가 없는 경우 무조건:

```text
calibration.level = uncalibrated
```

존재하지 않는 agreement 숫자를 생성하지 않는다.

후속 human reference:

```ts
interface HumanReferenceDataset {
  id: string;
  productId: string;
  domain: string;
  sampleSize: number;
  collectedAt: { from: string; to: string };

  features: {
    routeSequences: boolean;
    actionEvents: boolean;
    errors: boolean;
    outcomes: boolean;
    abandonment: boolean;
    device: boolean;
  };

  privacy: {
    containsDirectIdentifiers: false;
    aggregationLevel: "session" | "cluster";
  };
}
```

비교 지표:

- outcome distribution
- action type distribution
- route distribution
- next-action agreement
- abandonment location
- error reaction
- action count

개인 복제보다 cluster distribution을 우선한다.

---

## 14. Human validation gate

다음은 기본적으로 사람 검증이 필요하다.

- 결제/가격 정책 변경
- auth/privacy
- 의료·법률·금융
- 민감 인구 집단 주장
- 실제 전환율·선호도 주장
- accessibility critical finding
- model/seed/order instability
- weak/uncalibrated data에서 high severity
- 감정·브랜드 신뢰 해석

---

## 15. Acceptance Criteria

- persona 속성이 prompt 문장에만 존재하지 않는다.
- seeded policy sampling이 재현된다.
- `idle/ignore/abandon`이 실제 action으로 가능하다.
- full/perceived observation이 구분된다.
- BehavioralFingerprint가 생성된다.
- route/action diversity가 계산된다.
- 실제 데이터가 없으면 uncalibrated다.
- persona homogenization warning이 있다.
- hyperactivity는 risk heuristic으로 표현된다.
- demographic stereotype mapping이 없다.
- validity report가 HTML 최상단에 표시된다.
