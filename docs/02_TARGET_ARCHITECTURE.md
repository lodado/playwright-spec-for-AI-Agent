# 02. 목표 아키텍처

## 1. 전체 데이터 흐름

```text
Input Adapters
├─ YAML / JSON Study
├─ Playwright Spec
├─ Existing QA IR
└─ Future: Storybook / PRD / Analytics
          │
          ▼
Canonical StudySpec
          │
          ▼
Study Compiler
├─ tasks
├─ oracles
├─ safety policy
├─ personas
└─ runtime matrix
          │
          ▼
Experiment Orchestrator
persona × task × seed × viewport × variant
          │
          ▼
Browser Worker
├─ Direct Playwright Driver
├─ Semantic Observer
├─ Visual Evidence
├─ Runtime Monitor
├─ Agent Policy
└─ Deterministic Oracle
          │
          ▼
Immutable Evidence Bundle
          │
          ├─ browser closes
          ▼
Evaluation Pipeline
├─ Functional Evaluator
├─ Behavioral Evaluator
├─ Validity Evaluator
├─ Finding Clusterer
└─ Human Validation Gate
          │
          ▼
Reports
├─ JSON
├─ Static HTML
├─ Markdown
└─ GitHub Check / Comment
          │
          ▼
Optional downstream
Analytics Calibration / Remediation #13~#23
```

---

## 2. 권장 모노레포 구조

```text
.
├─ apps/
│  ├─ persona-runtime-cli/
│  ├─ browser-worker/
│  └─ dashboard/                    # MVP 이후
│
├─ packages/
│  ├─ playwright-spec-for-ai-agent/ # 기존 npm package, 호환성 보존
│  ├─ contracts/
│  ├─ runtime-core/
│  ├─ study-compiler/
│  ├─ playwright-spec-adapter/
│  ├─ playwright-driver/
│  ├─ persona-policy/
│  ├─ model-gateway/
│  ├─ evaluator/
│  ├─ simulation-validity/
│  ├─ evidence-store-fs/
│  ├─ reporter-html/
│  ├─ reporter-github/
│  └─ hermes-legacy-provider/
│
├─ fixtures/
│  ├─ successful-onboarding/
│  ├─ hidden-cta/
│  ├─ signup-wall/
│  ├─ recoverable-error/
│  ├─ infinite-loading/
│  ├─ credit-exhausted/
│  └─ ambiguous-pricing/
│
├─ examples/
├─ docs/
├─ pnpm-workspace.yaml
└─ package.json                       # private workspace root
```

MVP에서는 package 수를 줄여도 된다.

첫 분리는 다음 여섯 개면 충분하다.

```text
contracts
playwright-spec-adapter
runtime-core
playwright-driver
persona-policy
evaluator
```

`simulation-validity`, `reporter-html`, `model-gateway`는 내부 folder로 시작한 뒤
책임이 안정되면 package로 분리해도 된다.

---

## 3. 의존성 방향

```text
contracts
  ▲
  ├─ runtime-core
  ├─ study-compiler
  ├─ playwright-spec-adapter
  ├─ persona-policy
  ├─ evaluator
  └─ reporters

runtime-core
  ▲
  ├─ playwright-driver
  ├─ persona-policy
  ├─ evaluator
  └─ orchestrator

apps/*
  └─ 모든 package를 조립
```

### 금지된 의존성

```text
contracts → Playwright
runtime-core → Hermes
runtime-core → OpenAI/Anthropic SDK
evaluator → live browser
persona-policy → reporter
playwright-spec-adapter → GitHub
```

`contracts`와 `runtime-core`는 provider/framework 독립이어야 한다.

---

## 4. 핵심 모듈 책임

### contracts

- versioned schemas
- runtime-neutral TypeScript types
- JSON serialization
- schema migration
- stable identifiers
- validation error format

### playwright-spec-adapter

- existing annotation parsing
- expectation parsing/abstraction
- fixture resolution
- live policy mapping
- `PlaywrightScenarioIR`
- IR → `StudySpec` compiler
- legacy regex parser
- future AST parser

### runtime-core

- study/session lifecycle
- state machine
- event append
- retry/timeout/cancellation
- deterministic orchestration
- terminal status
- no Playwright implementation detail

### playwright-driver

- Browser/Context/Page lifecycle
- semantic snapshot
- visible interactive element inventory
- screenshot/trace/video
- console/network/download monitoring
- action execution
- page stabilization
- origin/action guard

### persona-policy

- policy sampling
- attention filtering
- persona state reducer
- abandonment policy
- action decision prompt
- non-action/idle support
- seeded reproducibility

### model-gateway

- structured output
- provider abstraction
- timeout/retry
- usage/cost metadata
- model role separation
- prompt versioning

### evaluator

- deterministic oracle evaluation
- functional outcome
- behavioral metrics
- friction extraction
- finding clustering
- severity and confidence
- browserless execution

### simulation-validity

- BehavioralFingerprint
- diversity report
- seed stability
- model agreement
- hyperactivity risk
- persona homogenization risk
- order consistency
- calibration level
- human validation requirement

### reporters

- JSON canonical result
- static HTML
- Markdown summary
- GitHub Check
- artifact links and redaction

---

## 5. Runtime state machine

```text
CREATED
  ↓
VALIDATED
  ↓
QUEUED
  ↓
STARTING_BROWSER
  ↓
RUNNING
  ├─ OBSERVING
  ├─ DECIDING
  ├─ ACTING
  └─ VERIFYING
  ↓
TERMINAL
  ├─ SUCCESS
  ├─ PARTIAL
  ├─ FAILURE
  ├─ ABANDONED
  ├─ RUNTIME_ERROR
  └─ MANUAL_REVIEW
  ↓
EVIDENCE_SEALED
  ↓
EVALUATED
  ↓
REPORTED
```

세션은 `EVIDENCE_SEALED` 이후 수정하지 않는다.
후속 evaluation은 새 result object를 생성한다.

---

## 6. Role separation

```text
Study Compiler
- 무엇을 테스트할지 정의

Persona Policy
- 이 사용자가 계속할지, 무엇에 주목할지 결정

Action Model
- perceived observation에서 한 행동 선택

Browser Executor
- 허용된 행동을 정확히 수행

Oracle Evaluator
- 목표 상태를 deterministic하게 확인

Evidence Sealer
- artifact manifest와 hash 생성

Behavioral Evaluator
- 이미 끝난 세션을 evidence 기반으로 해석

Skeptic / Validity Evaluator
- 결과가 과장되거나 불안정하지 않은지 검사

Reporter
- 허용된 수준의 주장만 렌더링
```

동일 모델을 여러 역할에 사용할 수는 있지만, logical role과 prompt,
input capability, output contract는 분리한다.

---

## 7. Deployment modes

### Local CLI

```text
developer machine
→ local/staging URL
→ filesystem evidence
→ static HTML
```

첫 MVP의 주력이다.

### CI Worker

```text
GitHub Action
→ Preview URL
→ ephemeral browser worker
→ artifact upload
→ GitHub Check
```

### Hosted SaaS

```text
API
→ queue
→ isolated browser worker
→ object storage / database
→ dashboard
```

MVP core가 SaaS database에 의존하지 않아야 한다.

---

## 8. Extension points

```ts
interface StudyInputAdapter {
  compile(input: unknown): Promise<StudySpec>;
}

interface BrowserDriver {
  start(environment: EnvironmentSpec): Promise<BrowserSession>;
  observe(session: BrowserSession): Promise<Observation>;
  execute(session: BrowserSession, action: BrowserAction): Promise<ActionResult>;
  close(session: BrowserSession): Promise<void>;
}

interface ModelProvider {
  generateStructured<T>(request: StructuredModelRequest<T>): Promise<ModelResult<T>>;
}

interface EvidenceStore {
  put(record: EvidenceRecord): Promise<EvidenceRef>;
  seal(runId: string): Promise<EvidenceManifest>;
}

interface Evaluator<I, O> {
  evaluate(input: I): Promise<O>;
}

interface Reporter<I> {
  render(input: I): Promise<ReportArtifact[]>;
}
```

---

## 9. Architecture invariants

1. browser를 닫기 전에 judge를 실행하지 않는다.
2. browser agent는 repository write capability를 받지 않는다.
3. judge는 browser capability를 받지 않는다.
4. evidence ID 없는 observation claim은 finding이 될 수 없다.
5. deterministic oracle이 가능한 판정은 model에 위임하지 않는다.
6. hidden element는 behavioral perceived observation에 포함하지 않는다.
7. LLM output은 schema validation 전에는 state에 적용하지 않는다.
8. 모든 action은 origin/action safety gate를 통과한다.
9. 실제 사용자 reference가 없으면 `uncalibrated`다.
10. A/B 순서 일관성이 없으면 winner를 선언하지 않는다.
11. 기존 CLI compatibility suite가 깨진 PR은 merge하지 않는다.
12. remediation은 evidence/diagnosis 계약을 통해서만 연결한다.
