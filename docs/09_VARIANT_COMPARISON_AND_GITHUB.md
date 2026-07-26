# 09. Variant Comparison과 GitHub PR Integration

## 1. 목적

절대 전환율을 예측하지 않고, 동일한 행동 집단에서 baseline과 candidate 사이의
상대적 behavioral regression을 찾는다.

```text
main/stable URL
vs
PR/preview URL
```

---

## 2. Comparison contract

```ts
interface VariantComparisonSpec {
  baseline: {
    id: string;
    baseUrl: string;
    revision?: string;
  };

  candidate: {
    id: string;
    baseUrl: string;
    revision?: string;
  };

  assignment: "paired" | "independent";
  counterbalanceOrder: boolean;

  metrics: Array<
    | "task_completion"
    | "action_count"
    | "backtrack"
    | "failed_interaction"
    | "abandonment"
    | "finding_recurrence"
    | "route_entropy"
  >;
}
```

기본은 `paired`.

---

## 3. Paired execution

동일:

- task
- persona definition
- sampled behavior policy
- seed
- viewport
- locale
- network profile
- account starting state

분리:

- BrowserContext
- model conversation
- cookie/storage
- evidence directory
- execution order

동일 sampled policy를 사용하되 candidate에서 baseline action replay를 강제하지 않는다.
각 variant에서 agent가 독립적으로 행동해야 한다.

---

## 4. Counterbalancing

실행 순서가 결과에 영향을 줄 수 있으므로 그룹을 나눈다.

```text
Group A
baseline → candidate

Group B
candidate → baseline
```

각 variant는 독립 context이지만 worker warm-up, model prompt order,
evaluation input order의 영향을 줄이기 위해 counterbalance한다.

pairwise LLM judge도 두 번 실행한다.

```text
baseline first
candidate first
```

결론이 다르면:

```text
comparisonStatus = unstable
winner = none
```

---

## 5. Metrics

```ts
interface VariantMetrics {
  completionRate: number;
  partialRate: number;
  failureRate: number;
  abandonmentRate: number;

  medianActionCount: number;
  medianBacktrackCount: number;
  medianFailedInteractionCount: number;

  routeEntropy: number;
  recurringFindingCount: number;
}
```

delta:

```ts
interface VariantDelta {
  completionDelta: number;
  abandonmentDelta: number;
  medianActionDelta: number;
  backtrackDelta: number;
  failedInteractionDelta: number;

  affectedPersonaIds: string[];
  confidence: FindingConfidence;
}
```

작은 sample에서 통계적 유의성을 과장하지 않는다.
bootstrap interval은 research mode에서만 제공해도 된다.

---

## 6. Comparison status

```ts
type ComparisonStatus =
  | "candidate_better"
  | "baseline_better"
  | "no_clear_difference"
  | "unstable"
  | "insufficient_evidence";
```

gate는 status 하나가 아니라 finding severity와 confidence를 사용한다.

---

## 7. Release gate

기본 정책:

```text
deterministic functional critical
→ fail

deterministic functional high
→ fail

behavioral critical + reproduced + stable
→ fail

behavioral high + reproduced
→ configurable fail/warn

medium/low
→ warn

uncalibrated single-session
→ never fail solely by itself

order/model unstable
→ manual review
```

팀별 YAML:

```yaml
releaseGate:
  failOn:
    - category: functional
      severity: critical
    - category: functional
      severity: high
    - category: behavioral
      severity: critical
      minimumMaturity: reproduced_synthetic_finding
      minimumConfidence: high

  warnOn:
    - category: behavioral
      severity: high
```

---

## 8. GitHub flow

```text
PR opened/updated
→ preview URL resolver
→ baseline resolver
→ study selector
→ run comparison
→ upload artifact
→ create/update Check
→ create/update summary comment
```

Preview resolver interface:

```ts
interface PreviewUrlResolver {
  resolve(input: PullRequestContext): Promise<{
    baselineUrl: string;
    candidateUrl: string;
    source: string;
  }>;
}
```

Vercel/Netlify/custom provider를 adapter로 둔다.
MVP는 explicit workflow input으로 URL을 받아도 된다.

---

## 9. Check output

```markdown
## Behavioral Release Check

**Result:** Warning

### Functional regression
No deterministic functional regression detected.

### Behavioral regression
Mobile first-time personas completed signup less often in the candidate.

| Metric | Baseline | Candidate | Delta |
|---|---:|---:|---:|
| Completion | 16/20 | 10/20 | -6 |
| Median actions | 7 | 12 | +5 |
| Backtracks/session | 0.8 | 2.1 | +1.3 |

### Main finding
The agreement section pushed the primary CTA below the initial viewport.

- Affected sessions: 8
- Affected personas: 3
- Maturity: reproduced_synthetic_finding
- Calibration: uncalibrated
- Model/order stability: mixed
- Human review: recommended
```

raw evidence는 GitHub comment에 전부 넣지 않고 artifact link와 stable ID를 제공한다.

---

## 10. Comment idempotency

PR update마다 새 comment를 만들지 않는다.

hidden marker:

```html
<!-- persona-runtime-check: study=signup-flow -->
```

기존 comment를 찾아 update한다.

finding fingerprint와 existing remediation `#15`의 publication fingerprint 원칙을 공유한다.

---

## 11. GitHub Check conclusion

mapping:

```text
success
neutral
failure
action_required
cancelled
timed_out
```

권장:

- no blocking finding → success
- warnings/uncalibrated → neutral
- blocking deterministic regression → failure
- manual human gate → action_required
- runtime infrastructure failure → neutral 또는 failure를 팀 설정으로 분리

제품 코드 failure와 test infrastructure failure를 같은 red X로 숨기지 않는다.

---

## 12. CI example

```yaml
name: Behavioral QA

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  behavioral:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      checks: write

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium

      - run: |
          pnpm persona-runtime compare ./studies/signup.yaml \
            --baseline="${BASELINE_URL}" \
            --candidate="${PREVIEW_URL}" \
            --output=.qa/run

      - uses: actions/upload-artifact@v4
        with:
          name: behavioral-qa
          path: .qa/run
```

credential은 GitHub secret/environment로 전달하고 command line에 노출하지 않는다.

---

## 13. Rollout

### Stage 1: Manual local compare

developer가 두 URL을 직접 입력한다.

### Stage 2: CI non-blocking

PR comment만 작성한다. Check는 neutral.

### Stage 3: Selected studies blocking

deterministic functional regression만 fail.

### Stage 4: Behavioral gate

충분히 반복되고 stable한 critical finding만 fail.

### Stage 5: Calibrated gate

실제 사용자 cluster와 교정된 high-confidence risk를 gate에 포함.

---

## 14. Acceptance Criteria

- 동일 sampled policy로 paired compare 가능.
- BrowserContext는 variant 간 분리.
- order counterbalancing 가능.
- reversed judge 결과 불일치 시 unstable.
- absolute conversion claim이 없음.
- GitHub comment는 idempotent update.
- artifact와 evidence link 제공.
- infrastructure failure와 product regression 구분.
- uncalibrated single-session은 단독 blocking 금지.
- existing finding fingerprint와 호환 가능한 stable key 사용.
