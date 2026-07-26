# 01. 현재 저장소 감사와 재사용 지도

## 1. 기준 상태

```text
Repository: lodado/playwright-spec-for-AI-Agent
Version: 0.9.0
Base commit: b95a72ba29253e37e9567e6d57e8a6c6c60d592a
Release date: 2026-07-19
Runtime: Node.js >= 20
Package style: ESM
Test: Vitest
Browser peer: @playwright/test >= 1.40
Release: release-please + npm provenance
```

현재 제품의 공식 흐름:

```text
spec → abstract-ai → judge → review → slack
```

핵심 가치는 다음이다.

- Playwright spec을 그대로 staging에서 재생하지 않는다.
- `@qa-scenario`와 assertion에서 사용자 의도를 추출한다.
- mock literal을 live semantic intent로 추상화한다.
- Hermes가 staging을 브라우징한다.
- `pass / fail / manual_review / skip`을 반환한다.
- 위험한 billing/subscription mutation을 live policy로 차단한다.
- 각 Hermes 실행은 ephemeral home에서 stateless하게 시작한다.

---

## 2. 현재 구조의 강점

### Playwright spec이 QA intent source가 되어 있음

이미 annotation과 assertion을 통해 테스트 작성자의 의도를 구조화한다.

```text
@qa-page
@qa-scenario
@qa-live-policy
@qa-fixture
@qa-always-run
@qa-live-skip
```

이 메타데이터는 새 Runtime의 `StudySpec`을 자동 생성하는 좋은 입력이다.

### Live safety policy가 존재함

현재 정책:

```text
readonly
safe-interaction
safe-interaction-no-confirm
mock-judgment
subscription-mutation
auth-mock
skip
```

이는 새 Runtime의 `ActionSafetyPolicy`로 변환할 수 있다.

### mock literal abstraction이 구현되어 있음

예:

```text
"98 pts"
→ numeric score with unit

정확한 날짜
→ equivalent date display

정확한 credit 수치
→ numeric credit balance
```

이 로직은 `Playwright Spec Adapter`의 주요 자산이다.

### manual_review가 제품 철학에 포함되어 있음

불확실한 상황을 억지로 fail/pass로 만들지 않는 정책은 새 Runtime에서도 유지한다.

### stateless run과 secret redaction이 이미 고려되어 있음

Hermes runner의 ephemeral home, memory toolset disable, 출력 redaction은
새 model provider와 worker isolation 설계에 참고한다.

### 테스트가 존재함

현재 `scripts/__tests__`에는 parser, abstractor, filter, config, judge,
Hermes runner, normalization 관련 테스트가 존재한다.
마이그레이션 시 golden compatibility suite의 기반이 된다.

---

## 3. 현재 구조의 한계

### CLI가 script dispatcher임

현재 bin은 command를 개별 `.mjs`로 `spawnSync`한다.

이 구조는 다음 요구에 맞지 않는다.

- 장기 session lifecycle
- cancellation
- multi-session concurrency
- event stream
- evidence persistence
- resumable execution
- model usage/cost accounting
- browser worker isolation

### Hermes가 여러 책임을 함께 가짐

현재 judge 흐름에서는 Hermes가 브라우징, 행동, 관찰, 판단을 함께 수행한다.

새 Runtime에서는 반드시 분리한다.

```text
Browser Driver
Agent Policy
Evidence Collector
Oracle Evaluator
Independent Judge
```

Hermes는 제거 대상이 아니라 optional provider/legacy adapter다.

### parser가 regex 기반임

현재 parser는 `test()`, `test.describe()`, braces를 regex/depth scan으로 찾는다.
MVP compatibility에는 충분하지만 장기적으로 다음 형태에 취약하다.

```ts
test.each(...)
test.extend(...)
customTest(...)
imported helper assertions
template literal braces
non-standard callback shape
```

따라서 legacy parser를 보존하면서 AST parser를 별도 구현한다.

### artifact 구조가 페이지 단위 pipeline에 묶여 있음

새 Runtime은 다음 차원을 지원해야 한다.

```text
study
× task
× persona
× seed
× model
× viewport
× variant
```

기존 `{page}-qa-spec-live.md` 중심 layout을 canonical artifact store로 재사용하지 않는다.

### 결과가 실행 evidence graph가 아님

현재 markdown evidence는 문자열 목록에 가깝다.
새 Runtime에서는 every claim이 event/evidence ID를 참조해야 한다.

---

## 4. 파일별 처리 방침

| 현재 파일/영역 | 처리 | 목표 위치 |
|---|---|---|
| `bin/playwright-spec-for-ai-agent.mjs` | 그대로 보존 후 package 이동 | `packages/playwright-spec-for-ai-agent/bin/` |
| `scripts/dashboard-spec-parser.mjs` | legacy parser로 추출 | `packages/playwright-spec-adapter/src/legacy/` |
| `scripts/expectation-abstractor.mjs` | 적극 재사용 | `packages/playwright-spec-adapter/src/expectation/` |
| `scripts/spec-live-filter.mjs` | policy compiler 입력으로 재사용 | `packages/playwright-spec-adapter/src/policy/` |
| `scripts/qa-spec-artifacts.mjs` | legacy artifact loader로 보존 | compatibility package |
| `scripts/page-qa-paths.mjs` | 기존 CLI 전용 유지 | compatibility package |
| `scripts/run-hermes-page-judge.mjs` | legacy flow 유지 | `packages/hermes-legacy-provider/` 또는 기존 package |
| `scripts/hermes-runner.mjs` | provider adapter 참고 및 legacy 유지 | `packages/model-provider-hermes/` 이후 |
| `scripts/slack-page-qa-report.mjs` | legacy reporter 유지 | 기존 package |
| `scripts/__tests__/*` | golden/compatibility test로 이동 | `tests/compat/` |
| `examples/*` | source fixture로 재사용 | `examples/playwright-import/` |
| release-please config | multi-package 준비 | root release config |
| npm package name | 변경 금지 | `playwright-spec-for-ai-agent` |

---

## 5. 재사용 계약

### 반드시 재사용

- annotation semantics
- live policy semantics
- fixture precedence
- mock expectation abstraction
- `manual_review`
- stateless execution 철학
- secret redaction
- npm CLI behavior
- current config precedence
- existing artifact output compatibility

### 설계만 참고하고 새로 구현

- browser runtime
- session state
- observation/action model
- evidence store
- model gateway
- persona policy
- evaluation
- finding clustering
- HTML report
- variant comparison
- GitHub Check

### core에서 분리

- Hermes-specific prompt
- Hermes CLI output scraping
- page-based artifact path
- Slack-only report model
- regex parser as canonical parser
- browser와 judge의 결합

---

## 6. 호환성 기준

마이그레이션 전후 다음이 동일해야 한다.

```bash
npx playwright-spec-for-ai-agent spec --page=pricing
npx playwright-spec-for-ai-agent abstract-ai --page=pricing
npx playwright-spec-for-ai-agent judge --page=pricing
npx playwright-spec-for-ai-agent review --page=pricing
npx playwright-spec-for-ai-agent slack --page=pricing
npx playwright-spec-for-ai-agent nightly --page=pricing
```

동일성 검증:

- exit code
- 생성 artifact 이름
- JSON required field
- config precedence
- annotation parsing
- live policy classification
- secret redaction
- Hermes stateless home cleanup
- skip/manual-review behavior

Markdown 문장 전체 byte equality는 요구하지 않아도 되지만,
JSON 구조와 핵심 verdict는 golden test로 고정한다.

---

## 7. 기존 remediation 이슈와 관계

현재 open epic `#13`과 하위 `#14~#23`은 evidence-driven remediation을 설계한다.

```text
real browser failure
→ immutable evidence
→ independent judgment
→ diagnosis
→ code location
→ issue/patch
→ verification
→ Issue or Draft PR
```

새 Behavioral Runtime은 이 roadmap을 대체하지 않는다.
오히려 upstream producer가 된다.

공유해야 할 canonical contract:

- `EvidenceBundle`
- `JudgeResult`
- `FailureDiagnosis` 입력
- `RunIdentity`
- `RepositoryRevision`
- `PublicationFingerprint`에 사용할 stable finding key

금지:

- Persona Runtime 전용 EvidenceBundle을 별도로 만든 뒤 remediation용으로 다시 변환
- Browser agent가 곧바로 repository patch를 생성
- Synthetic finding만으로 자동 Draft PR 생성

초기 Behavioral MVP의 finding은 기존 remediation pipeline에서 기본적으로
`Issue recommendation`까지만 갈 수 있고, patch eligibility는 별도 gate를 통과해야 한다.
