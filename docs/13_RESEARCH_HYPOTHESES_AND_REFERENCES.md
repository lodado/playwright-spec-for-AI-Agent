# 13. Research Hypotheses and References

## 목적

논문을 장식용으로 인용하지 않는다.
각 연구 가설을 구현 가능한 contract, metric, test로 변환한다.

이 문서의 가설은 “논문이 우리 제품을 증명했다”는 뜻이 아니다.
우리 시스템이 반증 가능하게 검사해야 할 위험을 정의한다.

---

## 1. UXAgent — synthetic testing is an early study-design tool

**Paper**

`UXAgent: A System for Simulating Usability Testing of Web Design with LLM Agents`  
Lu et al., 2025, arXiv:2504.09407

### 가져올 것

- persona generator
- interactive browser connector
- video replay
- agent interview
- large-scale synthetic study

### 제품 가설

> Synthetic user sessions are more defensible as pre-human-study risk discovery than as a replacement for human research.

### 구현 요구

- report에 `recommendedUse`
- `humanValidationRequirement`
- default finding maturity = exploratory
- 실제 전환/선호 주장 금지
- session replay 제공

---

## 2. AgentA/B — interactive agents for relative version comparison

**Paper**

`AgentA/B: Automated and Scalable Web A/B Testing with Interactive LLM Agents`  
Wang et al., 2025, arXiv:2504.09723

### 가져올 것

- real webpage multi-step interaction
- persona population
- baseline/candidate experiment
- behavior metric comparison

### 제품 가설

> Synthetic agents may be useful for relative regression direction even when their absolute human fidelity is imperfect.

### 구현 요구

- paired baseline/candidate
- task completion, path length, backtrack, abandonment delta
- relative claims only
- same sampled policy and environment
- execution order counterbalancing
- model/seed stability

---

## 3. UXCascade — aggregation and evidence drill-down

**Paper**

`UXCascade: Scalable Usability Testing with Simulated User Agents`  
Holter et al., 2026, arXiv:2601.15777

### 가져올 것

- multi-level analysis
- persona/goal/outcome pattern overview
- issue drill-down
- reasoning/evidence linkage
- interface edit and iterative assessment

### 제품 가설

> The value of many synthetic sessions depends more on structured aggregation and traceability than on producing more raw agent text.

### 구현 요구

- friction → finding hierarchy
- finding → session → event → evidence drill-down
- deterministic candidate clustering
- top-down report
- code recommendation is separated from observation
- full trajectory re-run after fixes

---

## 4. Beyond Cooperative Simulators — cooperative and homogeneous simulators

**Paper**

`Beyond Cooperative Simulators: Generating Realistic User Personas for Robust Evaluation of LLM Agents`  
Chopra et al., 2026, arXiv:2605.12894

### 핵심 위험

Baseline LLM user simulators can be overly cooperative and homogeneous.
Persona Policies are proposed as a control layer for behavioral variation.

### 제품 가설

> Behavior-policy personas will produce broader and more realistic failure coverage than narrative-only role prompts.

### 구현 요구

- `BehaviorPolicyDefinition`
- probabilistic policy
- non-action/abandon
- policy-only vs narrative-only benchmark
- persona separability
- excessive cooperation risk
- directive amplification experiment

---

## 5. OmniBehavior — hyperactivity, homogenization, positive-average bias

**Paper**

`Towards Real-world Human Behavior Simulation: Benchmarking Large Language Models on Long-horizon, Cross-scenario, Heterogeneous Behavior Traces`  
Chen et al., 2026, arXiv:2604.08362

### 핵심 위험

- hyper-activity
- persona homogenization
- positive-average / Utopian bias
- long-tail behavior loss
- real long-horizon behavior fidelity limits

### 제품 가설

> A synthetic population must be evaluated for diversity and activity bias; persona labels alone are not evidence of behavioral diversity.

### 구현 요구

- BehavioralFingerprint
- route/action entropy
- intra/inter persona distance
- hyperactivity heuristic
- positivity/excessive cooperation warning
- uncalibrated label
- domain transfer warning
- long-horizon support deferred until short-task validity is measurable

---

## 6. LLM-as-a-Judge position bias

**Paper**

`Judging the Judges: A Systematic Study of Position Bias in LLM-as-a-Judge`  
Shi et al., 2024/2025, arXiv:2406.07791

### 핵심 위험

Pairwise LLM evaluation may change based on candidate order.

### 제품 가설

> A/B conclusions that reverse when input order is swapped are not reliable release decisions.

### 구현 요구

- baseline-first evaluation
- candidate-first evaluation
- repetition stability
- position consistency
- no winner on inconsistency
- pointwise evidence metrics before pairwise model judgment

---

## 7. Falsifiable hypotheses

### H1 — Evidence-grounded policy beats narrative-only persona

Conditions:

```text
generic agent
narrative persona
behavior policy persona
calibrated persona
```

Metrics:

- outcome distribution similarity
- next action agreement
- route similarity
- abandonment location
- error reaction
- diversity coverage

### H2 — Strong directives amplify behavior

Conditions:

```text
strong adjective narrative
neutral narrative
policy only
```

Metrics:

- abandon rate
- retry rate
- action count
- model variance
- extreme behavior frequency

### H3 — Persona descriptions may homogenize

Metrics:

- intra-persona distance
- inter-persona distance
- persona separability
- route/action entropy
- cluster coverage

Fail signal:

```text
inter-persona distance ≈ intra-persona distance
```

### H4 — LLM agents over-act

Metrics:

- action count
- no-action rate
- abandonment rate
- irrelevant exploration
- recovery attempts
- goal-directedness

Without human reference, output is risk, not fact.

### H5 — Outcome match does not imply trajectory match

Separate:

- final outcome
- first action
- next action
- route
- error reaction
- abandonment

### H6 — Fidelity is domain-specific

Profile layers:

```text
global prior
domain profile
product calibration
```

Cross-domain reuse emits warning.

### H7 — Variant comparison is order-sensitive

Execute:

```text
baseline → candidate
candidate → baseline
```

Judge:

```text
baseline first
candidate first
```

Inconsistent result = unstable.

### H8 — Model agreement is necessary but insufficient

Report separately:

- evidence
- recurrence
- seed stability
- model agreement
- calibration
- order consistency
- human validation

### H9 — Best initial use is early risk detection

Finding maturity:

```text
exploratory_signal
reproduced_synthetic_finding
calibrated_behavioral_risk
human_validated_finding
```

---

## 8. Research validation harness

```text
fixtures/behavioral-validation/
  hidden-cta
  signup-wall
  recoverable-error
  ambiguous-pricing
  no-visible-value
  distracting-actions
```

Conditions:

```text
generic
narrative
policy
policy + multiple seeds
multiple models
human reference when available
```

Result contract:

```ts
interface SimulationBenchmarkResult {
  condition: string;

  outcomeAgreement?: number;
  nextActionAgreement?: number;
  routeSimilarity?: number;
  abandonmentSimilarity?: number;
  errorReactionSimilarity?: number;

  diversityCoverage: number;
  hyperactivityRisk: "low" | "medium" | "high" | "unknown";
}
```

---

## 9. What not to implement from papers yet

MVP에서 제외:

- 대규모 persona evolutionary search
- model fine-tuning
- 1,000+ agent population
- 개인 단위 human twin
- long-horizon life simulation
- actual market prediction
- think-aloud chain-of-thought storage
- automatic UI optimization loop

먼저 short-horizon browser task에서 evidence와 validity가 작동해야 한다.

---

## 10. Research-driven acceptance criteria

- 연구 가설마다 metric 또는 test가 있다.
- persona label만으로 diversity를 주장하지 않는다.
- cooperative/hyperactive risk를 report한다.
- A/B input order를 뒤집는다.
- 실제 reference가 없으면 human agreement를 생성하지 않는다.
- synthetic session 수를 실제 사용자 수처럼 표현하지 않는다.
- human validation boundary가 결과에 포함된다.
- 논문 결과를 제품 성능 보장으로 과장하지 않는다.
