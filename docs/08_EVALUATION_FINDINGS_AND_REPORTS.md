# 08. Evaluation, Findings, Confidence, Reports

## 1. Evaluation pipeline

```text
Sealed Evidence
→ deterministic Functional Evaluator
→ behavioral metrics
→ evidence-grounded Behavioral Evaluator
→ friction points
→ deterministic candidate grouping
→ optional semantic merge
→ findings
→ validity constraints
→ human validation gate
→ report
```

---

## 2. Functional Evaluation

```ts
interface FunctionalEvaluation {
  schemaVersion: "functional-evaluation/0.1";

  status:
    | "success"
    | "partial"
    | "failure"
    | "runtime_error"
    | "manual_review";

  satisfiedOracleIds: string[];
  violatedOracleIds: string[];
  unknownOracleIds: string[];

  evidenceIds: string[];
  reasons: string[];
}
```

우선순위:

1. explicit success/failure oracle
2. runtime hard failure
3. action/time budget
4. unknown/manual review
5. AI semantic judge는 마지막

LLM은 DOM에 접근하지 않고 sealed semantic snapshot과 evidence ref만 본다.

---

## 3. Behavioral metrics

```ts
interface BehavioralMetrics {
  actionCount: number;
  uniquePageCount: number;
  uniqueActionTypeCount: number;

  backtrackCount: number;
  repeatedPageCount: number;
  failedInteractionCount: number;
  recoveryAttemptCount: number;
  noProgressActionCount: number;

  timeToFirstProgressMs?: number;
  timeToTerminalMs: number;

  abandonment?: {
    occurred: boolean;
    route?: string;
    reasonCode?: string;
  };
}
```

AI의 “망설임”은 실제 wall-clock pause로 직접 해석하지 않는다.
proxy:

- repeated page
- backtrack
- multiple candidate exploration
- failed interaction
- no-progress action
- route loop
- decision revision

---

## 4. Friction point

```ts
interface FrictionPoint {
  schemaVersion: "friction-point/0.1";

  id: string;
  sessionId: string;
  category:
    | "functional"
    | "behavioral"
    | "visual"
    | "business"
    | "accessibility"
    | "performance"
    | "security";

  observation: string;
  interpretation: string;

  severityCandidate: "critical" | "high" | "medium" | "low";

  route?: string;
  elementFingerprint?: string;
  oracleIds: string[];

  eventIds: string[];
  evidenceIds: string[];

  evaluatorConfidence: number;
}
```

근거가 없는 interpretation은 finding으로 승격하지 않는다.

---

## 5. Observation / Interpretation / Recommendation 분리

좋은 예:

```text
Observation
9개 세션 중 5개에서 업로드 API 200 이후 결과 화면으로 이동하지 않았다.
관련 event와 screenshot이 존재한다.

Interpretation
처리 완료 상태와 다음 CTA의 발견성이 낮을 가능성이 있다.

Recommendation
완료 상태에 결과 보기 CTA를 추가하고 viewport 내에서 시각적 우선순위를 높인다.
```

나쁜 예:

```text
UI가 직관적이지 않다. 현대적으로 바꿔야 한다.
```

---

## 6. Finding clustering

### 1차 deterministic candidate key

```text
category
+ normalized route
+ element fingerprint
+ oracle/failure code
+ terminal reason
```

### 2차 semantic merge

LLM은 candidate groups의 observation을 보고 merge 제안만 한다.

출력:

```ts
interface ClusterMergeDecision {
  sourceClusterIds: string[];
  merge: boolean;
  reason: string;
  supportingSharedSignals: string[];
}
```

code가 evidence overlap과 route/element compatibility를 다시 확인한 뒤 적용한다.

### 금지

- raw free-text embedding만으로 모든 finding을 합침
- 서로 다른 route/oracle failure를 한 UX issue로 뭉침
- recommendation similarity를 근거로 merge
- model wording 변화로 fingerprint 변경

---

## 7. Finding

```ts
interface Finding {
  schemaVersion: "finding/0.1";

  id: string;
  fingerprint: string;
  title: string;

  category: FrictionPoint["category"];
  severity: "critical" | "high" | "medium" | "low";

  maturity:
    | "exploratory_signal"
    | "reproduced_synthetic_finding"
    | "calibrated_behavioral_risk"
    | "human_validated_finding";

  observation: string;
  interpretation: string;
  recommendation?: string;

  affectedSessionIds: string[];
  affectedPersonaIds: string[];
  affectedTaskIds: string[];

  eventIds: string[];
  evidenceIds: string[];

  recurrenceRate: number;
  confidence: FindingConfidence;

  humanValidation: HumanValidationRequirement;
}
```

---

## 8. Severity rules

### Critical

- core task 완전 차단
- data loss/security risk
- auth/payment 핵심 상태 오류
- 대부분 population에서 반복
- deterministic failure evidence

### High

- core task completion 크게 저하
- 반복 abandonment
- recovery 경로 없음
- 여러 persona/seed에서 반복

### Medium

- 과업은 가능하지만 상당한 추가 행동
- 특정 viewport/persona에 집중
- 반복 confusion/backtrack

### Low

- 작은 friction
- copy/hierarchy improvement
- task outcome 영향 작음

LLM severity suggestion과 deterministic rule이 충돌하면 더 높은 쪽을 자동 채택하지 않는다.
rule reason과 human review를 표시한다.

---

## 9. Confidence decomposition

```ts
interface FindingConfidence {
  evidenceConfidence: number;
  recurrenceConfidence: number;
  seedStability: number | "not_available";
  modelAgreement: number | "not_available";
  calibrationConfidence: number | "not_available";
  orderConsistency: number | "not_available";

  overall: "low" | "medium" | "high";
  limitations: string[];
}
```

규칙:

- evidence 없음 → finding 금지
- 단일 session → recurrence high 금지
- 단일 model → modelAgreement unavailable
- uncalibrated → 실제 사용자 예측 표현 금지
- order inconsistency → A/B winner 금지
- model agreement 높음 ≠ human validation

---

## 10. Finding maturity

```text
single synthetic session
→ exploratory_signal

multiple seeds/personas에서 재현
→ reproduced_synthetic_finding

human reference와 패턴 일치
→ calibrated_behavioral_risk

실제 사용자 테스트/운영 데이터 확인
→ human_validated_finding
```

단계를 건너뛰지 않는다.

---

## 11. Independent judge

Judge input:

- StudySpec subset
- task/oracle
- session summary
- events
- semantic snapshots
- screenshot refs 또는 approved image inputs
- runtime issues
- manifest verification result

Judge가 받지 않는 것:

- live browser
- credential
- repository write
- code patch tool
- unbounded raw repo
- agent hidden chain-of-thought

Judge output은 structured schema로 검증한다.

---

## 12. HTML report

최상단:

```text
Study status
Simulation calibration
Recommended use
Population diversity
Seed/model/order stability
Human validation requirement
```

섹션:

1. Executive Summary
2. Limitations / Validity
3. Outcome Distribution
4. Repeated Findings
5. Persona Comparison
6. Variant Comparison
7. Session Timeline
8. Evidence Viewer
9. Runtime Issues
10. Cost / Model Usage
11. Model Card

Finding card:

```text
[High] 업로드 완료 후 결과 진입 경로 미발견

Maturity
reproduced_synthetic_finding

Occurrence
5 / 9 sessions

Affected
3 personas, mobile viewport

Observation
...

Interpretation
...

Evidence
Session 01 Event 08
Session 04 Event 06
Session 07 Event 11

Confidence
Evidence: High
Recurrence: Medium
Calibration: Unavailable
```

---

## 13. Session timeline

각 step:

- URL
- perceived elements
- action
- result
- progress change
- before/after screenshot
- console/network issue
- persona state delta
- oracle delta

내부 chain-of-thought는 저장/표시하지 않는다.
대신 짧은 structured `reasonCode`와 사용자에게 보인 정보만 기록한다.

---

## 14. JSON and Markdown reports

Canonical source는 JSON이다.

```text
summary.json
findings.json
validity.json
variant-comparison.json
```

HTML과 Markdown은 canonical JSON에서 렌더링한다.
Markdown parser가 business logic을 갖지 않는다.

---

## 15. Report wording policy

허용:

- “테스트한 15개 synthetic session 중 7개에서 반복됨”
- “candidate에서 baseline보다 backtrack이 증가함”
- “모델 간 합의가 낮아 불확실”
- “실제 사용자 데이터로 교정되지 않음”

금지:

- “실제 사용자 70%가 이탈한다”
- “이 디자인을 고객이 싫어한다”
- “전환율이 확실히 상승한다”
- “AI가 사용자 연구를 대체한다”

---

## 16. Acceptance Criteria

- functional evaluation은 oracle 우선이다.
- judge는 sealed evidence만 읽는다.
- finding은 event/evidence ID를 가진다.
- observation/interpretation/recommendation이 분리된다.
- clustering은 deterministic candidate 단계가 있다.
- confidence가 단일 숫자로 숨겨지지 않는다.
- finding maturity가 표시된다.
- uncalibrated 결과에서 실제 사용자 주장 금지.
- HTML에서 session evidence까지 drill-down 가능.
- report는 secret과 private absolute path를 노출하지 않는다.
