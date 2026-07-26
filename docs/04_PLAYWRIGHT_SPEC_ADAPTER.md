# 04. Playwright Spec Adapter

## 목적

기존 Playwright spec을 새 Runtime의 유일한 source of truth로 만들지 않는다.
대신 여러 입력 중 하나인 adapter로 만든다.

```text
Playwright Source
→ parser
→ PlaywrightScenarioIR
→ compiler
→ canonical StudySpec
```

---

## 1. Why an intermediate representation

parser 결과를 바로 `StudySpec`으로 사용하면 다음이 섞인다.

- Playwright syntax
- test fixture/mock 정보
- live safety policy
- behavioral task intent
- runtime environment
- evaluator oracle

따라서 `PlaywrightScenarioIR`을 둔다.

```ts
interface PlaywrightScenarioIR {
  schemaVersion: "qa-ir/0.1";

  source: {
    repositoryRelativePath: string;
    fileHash: string;
    testTitle: string;
    describeTitles: string[];
    sourceRange?: {
      startLine: number;
      endLine: number;
    };
  };

  annotations: {
    page?: string;
    scenario?: string;
    alwaysRun: boolean;
    liveSkip: boolean;
    livePolicy?: QaLivePolicy;
  };

  intent: {
    title: string;
    description?: string;
  };

  actions: ExtractedAction[];
  expectations: ExtractedExpectation[];
  fixtures: FixtureReference[];

  risk: {
    stagingMode: "read-only" | "interaction" | "auth" | "live-skip";
    liveRunPolicy: string;
    detectedMutationKinds: string[];
  };

  provenance: {
    parser: "legacy-regex" | "typescript-ast";
    parserVersion: string;
    abstractionVersion: string;
  };
}
```

---

## 2. Legacy parser strategy

현재 regex parser를 `legacy-regex`로 보존한다.

목적:

- 현재 사용자의 spec 동작 유지
- migration risk 축소
- golden fixture 재사용
- adapter 계약을 먼저 안정화

구현:

```text
packages/playwright-spec-adapter/src/legacy/
  parse-annotations.ts
  parse-test-blocks.ts
  parse-fixtures.ts
  parse-live-policy.ts
  parse-expectations.ts
  parser.ts
```

기존 script와 동일한 결과를 내도록 port한다.
동시에 모든 결과에 provenance와 stable ID를 추가한다.

---

## 3. AST parser roadmap

`typescript` compiler API 또는 `ts-morph`를 사용한다.
MVP block이 아니며 legacy parser와 병행한다.

지원 우선순위:

1. `test()` / `test.describe()`
2. `test.beforeEach()`
3. `test.extend()`
4. `test.each()`
5. imported helper의 locator/action trace
6. custom test alias
7. source map과 exact range

AST parser는 parser 선택 option으로 제공한다.

```yaml
playwrightImport:
  parser: legacy-regex
```

후속:

```yaml
playwrightImport:
  parser: typescript-ast
  fallback: legacy-regex
```

fallback이 발생하면 report에 경고를 남긴다.

---

## 4. Expectation abstraction

현재 rule-based abstraction을 먼저 적용한다.

```text
exact mock literal
→ semantic intent / flexible constraint
```

그 후 AI abstraction은 optional second pass다.

```text
raw expectation
→ deterministic rules
→ structured semantic expectation
→ optional model refinement
```

AI refinement가 deterministic rule보다 constraint를 약화시키면 적용하지 않는다.

예:

```ts
interface SemanticExpectation {
  id: string;
  kind: "visible" | "text" | "url" | "count" | "state" | "network" | "event";
  intent: string;
  constraints: ExpectationConstraint[];
  provenance: {
    sourceExpectationId: string;
    rule?: string;
    modelPromptVersion?: string;
  };
}
```

---

## 5. Safety policy compilation

현재 live policy를 새 action policy로 mapping한다.

```ts
interface ActionSafetyPolicy {
  allowRead: true;
  allowNavigation: boolean;
  allowClick: boolean;
  allowTyping: boolean;
  allowFileUpload: boolean;
  allowStateMutation: boolean;
  allowExternalOrigin: boolean;

  forbiddenActions: Array<
    | "payment"
    | "subscription_change"
    | "account_delete"
    | "data_delete"
    | "send_message"
    | "confirm_destructive"
  >;

  stopBeforeConfirmation: boolean;
}
```

예시:

```text
readonly
→ navigation/read only, click=false

safe-interaction
→ safe click/type allowed, destructive=false

safe-interaction-no-confirm
→ open dialog allowed, confirm=false

subscription-mutation
→ behavioral live execution blocked by default

auth-mock
→ imported task manual_review/skip unless explicit safe auth environment exists

skip
→ no task generated or task marked disabled
```

---

## 6. IR to StudySpec compiler

```ts
interface CompilePlaywrightIRToStudyOptions {
  baseUrl: string;
  defaultViewport: Viewport;
  defaultPersonas: string[];
  includeAlwaysRun: boolean;
  includeBlockedAsManualReview: boolean;
}

function compilePlaywrightIRToStudy(
  ir: PlaywrightScenarioIR[],
  options: CompilePlaywrightIRToStudyOptions,
): StudySpec;
```

mapping:

```text
test title
→ TaskSpec.name

scenario/describe intent
→ TaskSpec.goal/context

expectations
→ successOracles

live policy
→ safetyPolicy

fixture
→ environment.fixtures

page/target path
→ startPath

blocked policy
→ disabled/manual_review metadata
```

---

## 7. What cannot be inferred automatically

다음은 사용자가 보완해야 한다.

- 실제 사용자의 목표
- abandonment allowed 여부
- persona choice
- maxActions
- business oracle
- 실서비스 로그인 계정 상태
- 테스트 데이터 reset
- candidate/baseline URL
- 실제 개인정보/결제 안전 정책

compiler는 unknown을 숨기지 않는다.

```ts
interface CompileWarning {
  code:
    | "MISSING_USER_GOAL"
    | "MISSING_TARGET_PATH"
    | "MOCK_ONLY_EXPECTATION"
    | "BLOCKED_MUTATION"
    | "AUTH_STATE_UNRESOLVED"
    | "FIXTURE_NOT_PORTABLE";

  sourceRef: string;
  message: string;
  suggestedResolution: string;
}
```

---

## 8. CLI

```bash
persona-runtime import-playwright \
  --spec-dir=tests/e2e/pricing \
  --page=pricing \
  --output=studies/pricing.generated.yaml
```

검토 후 실행:

```bash
persona-runtime validate studies/pricing.generated.yaml
persona-runtime run studies/pricing.generated.yaml
```

generated file에는 provenance를 남긴다.

```yaml
generated:
  adapter: playwright-spec
  sourceCommit: b95a72...
  generatedAt: 2026-07-26T...
  warnings:
    - MISSING_USER_GOAL
```

---

## 9. Tests

### Compatibility

- current parser fixtures produce equivalent IR
- annotation precedence
- nested describe fixture precedence
- live policy precedence
- skip/always-run behavior
- mock detection
- subscription mutation detection

### Compiler

- expectation → oracle
- policy → safety
- path → environment
- blocked flow → manual review metadata
- unknown fields produce warning
- stable IDs do not include timestamp/model wording

### Fuzz/edge

- braces in template literal
- comments inside test body
- nested describe
- duplicate titles
- same test in multiple files
- Windows path
- Unicode title
- imported fixture path traversal

---

## 10. Acceptance Criteria

- 기존 parser test가 adapter package에서 통과한다.
- 기존 CLI가 wrapper를 통해 동일 결과를 낸다.
- IR은 JSON serialize 가능하다.
- IR은 source path/hash/range provenance를 가진다.
- StudySpec compiler가 warning을 숨기지 않는다.
- dangerous live policy는 자동 완화되지 않는다.
- mock literal abstraction이 semantic strength를 약화시키지 않는다.
- parser implementation을 runtime-core가 알지 못한다.
