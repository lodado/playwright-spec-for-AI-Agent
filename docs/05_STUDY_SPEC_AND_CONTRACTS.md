# 05. StudySpec과 Versioned Contracts

## 1. 계약 우선순위

다음 순서가 source of truth다.

```text
JSON Schema
→ TypeScript type
→ runtime validator
→ documentation example
```

TypeScript type만 있고 runtime validation이 없는 상태를 허용하지 않는다.

권장 도구:

- Zod 또는 Valibot 중 저장소에서 하나 선택
- JSON Schema export
- explicit discriminated union
- unknown field policy 명시
- schema migration test

---

## 2. StudySpec

```ts
interface StudySpec {
  schemaVersion: "study-spec/0.1";

  study: {
    id: string;
    name: string;
    description?: string;
    tags?: string[];
  };

  product: ProductContext;
  environment: EnvironmentSpec;

  tasks: TaskSpec[];
  personas: PersonaSpec[];

  runtime: RuntimeConfig;
  evidence: EvidencePolicy;
  evaluation: EvaluationPolicy;

  comparison?: VariantComparisonSpec;

  provenance?: {
    source: "manual" | "playwright-spec" | "qa-ir" | "generated";
    sourceRefs?: string[];
    generatedAt?: string;
  };
}
```

---

## 3. EnvironmentSpec

```ts
interface EnvironmentSpec {
  baseUrl: string;
  startPath?: string;

  allowedOrigins: string[];
  blockedOrigins?: string[];

  viewport: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    isMobile?: boolean;
  };

  locale?: string;
  timezoneId?: string;

  auth?: AuthConfig;
  storageStatePath?: string;

  fixtures?: Record<string, string>;

  network?: {
    offline?: boolean;
    latencyMs?: number;
    downloadKbps?: number;
    uploadKbps?: number;
  };

  reset?: {
    beforeSessionCommand?: string;
    afterSessionCommand?: string;
  };
}
```

`beforeSessionCommand`는 local trusted mode에서만 지원한다.
Hosted mode에서 임의 shell command를 허용하지 않는다.

---

## 4. TaskSpec

```ts
interface TaskSpec {
  id: string;
  name: string;
  goal: string;
  context?: string;

  startPath?: string;
  startingState?: Record<string, unknown>;

  successOracles: Oracle[];
  failureOracles?: Oracle[];
  businessOracles?: Oracle[];

  safetyPolicy: ActionSafetyPolicy;

  maxActions: number;
  maxDurationMs: number;
  maxConsecutiveNoProgressActions: number;

  abandonmentAllowed: boolean;
  humanValidation?: HumanValidationPolicy;
}
```

---

## 5. Oracle

```ts
type Oracle =
  | {
      id: string;
      type: "url";
      operation: "equals" | "contains" | "matches";
      value: string;
    }
  | {
      id: string;
      type: "visible_text";
      operation: "contains" | "not_contains" | "matches";
      value: string;
    }
  | {
      id: string;
      type: "element";
      role?: string;
      name?: string;
      state: "visible" | "hidden" | "enabled" | "disabled" | "checked";
    }
  | {
      id: string;
      type: "network";
      method?: string;
      urlPattern: string;
      status?: number;
    }
  | {
      id: string;
      type: "event";
      name: string;
      properties?: Record<string, Primitive>;
    }
  | {
      id: string;
      type: "download";
      filenamePattern?: string;
      mimeType?: string;
    }
  | {
      id: string;
      type: "custom";
      evaluatorId: string;
      input?: Record<string, unknown>;
    };
```

custom evaluator는 registry allowlist로만 실행한다.
Study file에서 임의 code path를 import하지 않는다.

---

## 6. Session contract

```ts
interface SessionRecord {
  schemaVersion: "session/0.1";

  runId: string;
  sessionId: string;
  studyId: string;
  taskId: string;
  personaId: string;

  seed: number;
  variant?: string;
  model?: string;

  status:
    | "created"
    | "running"
    | "success"
    | "partial"
    | "failure"
    | "abandoned"
    | "runtime_error"
    | "manual_review";

  startedAt: string;
  completedAt?: string;

  sampledPolicy: SampledBehaviorPolicy;
  terminalReason?: TerminalReason;

  eventIds: string[];
  evidenceManifestId?: string;
}
```

---

## 7. Observation

```ts
interface Observation {
  schemaVersion: "observation/0.1";
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: string;

  page: {
    url: string;
    title: string;
    viewport: Viewport;
  };

  semantic: {
    visibleText: string[];
    headings: SemanticNode[];
    landmarks: SemanticNode[];
    interactiveElements: InteractiveElement[];
  };

  visual: {
    screenshotEvidenceId: string;
    occludedElementFingerprints?: string[];
  };

  runtime: {
    consoleIssues: RuntimeIssue[];
    networkFailures: RuntimeIssue[];
    pendingRequestCount: number;
    loadingIndicators: string[];
  };

  oracleSignals: {
    satisfied: string[];
    violated: string[];
    unknown: string[];
  };
}
```

원본 observation과 persona에게 전달되는 `PerceivedObservation`을 분리한다.

---

## 8. Action

```ts
type BrowserAction =
  | { type: "click"; elementId: string; reasonCode: string }
  | { type: "type"; elementId: string; valueRef: string; reasonCode: string }
  | { type: "select"; elementId: string; value: string; reasonCode: string }
  | { type: "scroll"; direction: "up" | "down"; amount: "small" | "medium" | "large"; reasonCode: string }
  | { type: "back"; reasonCode: string }
  | { type: "wait"; durationMs: number; reasonCode: string }
  | { type: "observe_more"; reasonCode: string }
  | { type: "ignore"; elementId?: string; reasonCode: string }
  | { type: "idle"; durationMs: number; reasonCode: string }
  | { type: "finish"; reasonCode: string }
  | { type: "abandon"; reasonCode: string };
```

민감한 입력 값은 action JSON에 평문 저장하지 않는다.
`valueRef`가 secret/fixture store를 참조한다.

---

## 9. InteractionEvent

```ts
interface InteractionEvent {
  schemaVersion: "interaction-event/0.1";
  id: string;
  sessionId: string;
  index: number;
  timestamp: string;

  observationId: string;
  action: BrowserAction;

  result: {
    status: "success" | "failure" | "no_change" | "blocked";
    message?: string;
  };

  urlBefore: string;
  urlAfter: string;

  evidenceIds: string[];

  derivedSignals: {
    progressChanged: boolean;
    backtrack: boolean;
    repeatedPage: boolean;
    failedInteraction: boolean;
    noProgress: boolean;
  };
}
```

---

## 10. Evidence manifest

```ts
interface EvidenceManifest {
  schemaVersion: "evidence-manifest/0.1";
  id: string;
  runId: string;
  sessionId: string;

  createdAt: string;
  sealedAt: string;

  repositoryRevision?: string;
  studyHash: string;
  policyHash: string;

  entries: EvidenceEntry[];

  manifestHash: string;
  redactionSummary: {
    redactedCount: number;
    rulesVersion: string;
  };
}
```

각 entry:

```ts
interface EvidenceEntry {
  id: string;
  type:
    | "screenshot"
    | "semantic_snapshot"
    | "trace"
    | "video"
    | "console_issue"
    | "network_failure"
    | "download"
    | "oracle_result"
    | "action_result";

  relativePath?: string;
  contentHash: string;
  byteSize?: number;
  metadata: Record<string, unknown>;
}
```

seal 후 entry 수정 금지.

---

## 11. ID strategy

stable ID와 run ID를 구분한다.

```text
studyId
- 사람이 지정하거나 normalized content hash

taskId
- study + explicit task id

expectationId
- source path + test title + normalized expectation

elementFingerprint
- role + accessible name + stable DOM attributes + route

sessionId
- run + task + persona + seed + variant

eventId
- session + sequence

evidenceId
- session + type + sequence + content hash
```

timestamp나 model wording을 failure fingerprint에 포함하지 않는다.

---

## 12. Example Study

```yaml
schemaVersion: study-spec/0.1

study:
  id: hidden-cta-onboarding
  name: Hidden CTA onboarding evaluation

product:
  description: PDF 문서를 업로드하고 OCR 결과를 제공하는 SaaS

environment:
  baseUrl: http://127.0.0.1:4173
  startPath: /ko
  allowedOrigins:
    - http://127.0.0.1:4173
  viewport:
    width: 390
    height: 844
    isMobile: true

tasks:
  - id: upload-and-view-result
    name: Upload PDF and view result
    goal: 무료 범위에서 PDF를 업로드하고 추출 결과를 확인한다
    startPath: /ko
    maxActions: 20
    maxDurationMs: 120000
    maxConsecutiveNoProgressActions: 4
    abandonmentAllowed: true
    successOracles:
      - id: result-visible
        type: element
        role: heading
        name: 추출 결과
        state: visible
    safetyPolicy:
      allowRead: true
      allowNavigation: true
      allowClick: true
      allowTyping: true
      allowFileUpload: true
      allowStateMutation: true
      allowExternalOrigin: false
      forbiddenActions:
        - payment
        - account_delete
        - data_delete
      stopBeforeConfirmation: true

personas:
  - preset: impatient_new_user
  - preset: careful_business_buyer
  - preset: low_domain_knowledge_user

runtime:
  seeds: [101, 202, 303]
  concurrency: 2
  modelRoles:
    action: default
    evaluator: default

evidence:
  screenshot: every_action
  trace: true
  video: on_failure
  semanticSnapshot: every_action

evaluation:
  minimumRecurrenceForFinding: 2
  validityReport: true
```

---

## 13. Schema migration

```ts
interface ContractMigrator<TFrom, TTo> {
  from: string;
  to: string;
  migrate(value: TFrom): TTo;
}
```

원칙:

- patch-level schema 변경은 backward compatible
- field rename은 read old/write new
- unknown enum은 reject 또는 manual_review
- migration 결과에 warning 기록
- evidence contract migration은 원본 hash를 보존하고 derived copy 생성

---

## 14. Acceptance Criteria

- 모든 public object에 `schemaVersion`이 있다.
- JSON round-trip이 가능하다.
- validation error가 path와 code를 가진다.
- unknown custom evaluator를 실행하지 않는다.
- secret input은 event artifact에 평문 저장되지 않는다.
- evidence manifest는 seal 후 immutable하다.
- stable ID는 model output wording에 의존하지 않는다.
- schema migration golden test가 있다.
