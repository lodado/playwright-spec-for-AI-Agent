# qa-native Cohesion Refactor Implementation Plan (adaptive FAIL 0 + 아키텍처 단일화)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** adaptive 원샷 judge FAIL 0을 달성하고, 2~4벌씩 분산된 프로토콜 규칙(관측 대기·action 어휘·artifact 형태·진단)을 단일 소스로 수렴시켜 AGENTS.md §2 동기화 매트릭스를 11행 → 4행으로 줄인다.

**Architecture:** 역할 헌장(아래) 기준으로 각 패키지의 책임을 고정한다 — `contracts` = 어휘와 데이터 형태(ACTION_SPECS, AUDIT_ARTIFACT_SHAPE), `core` = 판정 규칙(milestoneCompletionRule, 관측 대기 정책), `provider-playwright` = 실행만, `evidence` = 무결성 프리미티브, `cli/qa-native-adaptive-evidence` = 무결성 검증만(의미론은 import). 소비처는 규칙을 재구현하지 않고 조회한다. 리팩터 PR(3~5)은 행동 불변 — verdict가 baseline에서 변하면 즉시 회귀 취급.

**Tech Stack:** pnpm monorepo, `.mjs` ESM (타입체크·린트 없음), vitest (`cd apps/playwright-spec-for-ai-agent && pnpm test`), Changesets.

**원문 플랜과의 의도적 편차:** 원문은 ACTION_SPECS를 core에 두라 했지만, `contracts/index.mjs`의 `validateAdaptiveActionParameters`(현재 :1577)가 spec을 소비해야 하므로 core에 두면 contracts→core 순환 의존이 생긴다. contracts는 leaf 패키지("practically everything"이 import)이므로 ACTION_SPECS·AUDIT_ARTIFACT_SHAPE는 **contracts**에 둔다. 관측 대기 **정책**(얼마나/무엇을 기다릴지)은 core, 브라우저 **실행**은 provider — 원문 그대로.

## Global Constraints

- 검증 게이트: `cd apps/playwright-spec-for-ai-agent && pnpm test` (vitest run). 실제 출력 보고 없이 done 선언 금지.
- 모든 published 패키지 변경 PR은 changeset 필수 (`playwright-spec-for-ai-agent`). `pnpm changeset version` 적용까지 커밋. **주의: version-bump된 PR을 main에 머지하면 npm 자동 발행** — 발행 보류 시 changeset 미적용 상태로 쌓기만 한다 (사람 결정).
- Evidence는 절대 삭제 금지; 실패 경로는 `<run-dir>.invalid` 격리 (AGENTS.md §3-2).
- validator 수용은 runtime 수용의 필요조건 — validator는 runtime보다 관대할 수 있어도 엄격해선 안 됨 (AGENTS.md §3-6).
- 모든 element-level 대기는 node timeout 예산 아래로 bounded, 실패는 관측된 사실로 끝나야 하며 run-killing timeout이 되면 안 됨 (AGENTS.md §2 timing row).
- 타이밍 변경의 유일한 유효 판정은 소비 repo(Deep-Agent develop-11) no-DEBUG 반복 원샷 — `DEBUG=pw:api`·`QA_NATIVE_TRACE_TIMING=1`은 race를 가릴 수 있음.
- 소스는 `.mjs`, 파일당 800줄 상한(기존 초과 파일은 새로 늘리지 않기), 기존 코드의 idiom·주석 밀도 따르기.
- AGENTS.md 파일 참조는 `packages/__tests__/agents-md-refs.test.mjs`가 검사 — 경로 이동 시 반드시 갱신.
- contracts 필드 변경 = schemaVersion bump + 구 artifact 재판독 호환 + HMAC 표면 리뷰 (매트릭스 "contracts fields" row).

## 완료 정의 (측정 가능)

1. 소비 repo 원샷: strict 5연속 PASS + adaptive judge FAIL 0 (MR ≤1 허용) + report.
2. AGENTS.md §2 매트릭스 11행 → 4행 (policy 값 · CLI 옵션 · contracts 필드 · evidence 삭제/실패 경로).
3. 가짜 action 추가 fixture: contracts의 ACTION_SPECS 한 곳 수정으로 lease 생성·파라미터 검증·프롬프트 문장·artifact 형태 4곳 자동 반영 시연 테스트.

## 목표 역할 헌장 (응집도/결합도 계약 — 모든 PR이 이 표를 위반하면 반려)

| 패키지                                         | 책임 (이것만)                                                                                        | 금지                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `packages/contracts`                           | 스키마·어휘·형태: `ACTION_SPECS`, `ADAPTIVE_ACTIONS`(파생), `auditArtifactShape`, `validateContract` | 실행 로직, 다른 패키지 import            |
| `packages/core`                                | 판정 규칙: `milestoneCompletionRule`, `observationSettleBudget`, lease 생성, authorizer, budget      | 브라우저/IO 접근                         |
| `packages/provider-playwright`                 | 실행: strict executor + adaptive gateway. 규칙은 contracts/core에서 조회                             | 어휘·artifact 형태·완료 규칙의 독자 사본 |
| `packages/provider-hermes`                     | 전송·프롬프트. 프롬프트 action 문장은 ACTION_SPECS에서 생성                                          | action 파라미터 손 수기 나열             |
| `packages/evidence`                            | 봉인·HMAC·redaction·archive                                                                          | 의미론                                   |
| `packages/cli/qa-native-adaptive-evidence.mjs` | 무결성 검증만 — HMAC·바인딩·origin·체인·페이지 연속성. 의미론은 core/contracts import                | 완료·artifact 개수·action 의미론 재유도  |
| `packages/judge`                               | 봉인 증거 → verdict                                                                                  | agent claim의 verdict 승격               |
| `packages/spec-parser` (신설, PR-5)            | AST·annotation 파싱, 진단 방출(`emitDiagnostic`, testIndex 내장)                                     | —                                        |

## 실행 순서와 게이트

| PR   | 내용                                                                              | 규모    | 게이트                                                        |
| ---- | --------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------- |
| PR-1 | Phase 1+3: 관측 대기 정책 단일화 + element observation 봉인 + artifact shape 공유 | 1~2일   | vitest + 소비 repo adaptive FAIL 0, strict 5연속              |
| PR-2 | Phase 6: 에러 투명화                                                              | 0.5~1일 | vitest                                                        |
| PR-3 | Phase 2: ACTION_SPECS 단일 소스화                                                 | 1~2일   | vitest 행동 불변 + fixture 시연 + 소비 repo 원샷 동일 verdict |
| PR-4 | Phase 4: validator 무결성 전용화 + 변조 fixture 3종                               | 0.5일   | vitest                                                        |
| PR-5 | Phase 5: scripts/ → packages/spec-parser 흡수                                     | 1일     | vitest + 구 flow bin 스모크                                   |
| PR-6 | Phase 7+8: 소모량 summary·매트릭스 4행·runbook                                    | 1일     | vitest + 소비 repo 원샷 최종                                  |

각 PR 끝마다 소비 repo 원샷 게이트 재실행(수동 — Deep-Agent develop-11 dashboard 원샷). 리팩터 PR에서 verdict가 baseline과 다르면 머지 금지.

---

# PR-1 — 관측 대기 정책 단일화 + adaptive element observation (Phase 1+3)

문제(실측 확정): strict `observeExpectations`는 waitFor visible로 hydration을 기다려 PASS. adaptive snapshot은 domcontentloaded 직후 캡처 → SSR HTML 봉인(testid 3개, 2.5초 후 9개) → judge false FAIL 0.91. 작업 트리에 이미 `settleGatewayDom`(cap 5s, quiet 300ms, MutationObserver) 픽스와 테스트, changeset(`adaptive-navigation-settle.md`)이 미커밋 상태로 존재한다. PR-1은 이를 기반으로 (a) 정책 상수를 core로 승격, (b) strict 관측도 같은 정책 통과, (c) expectation별 관측 사실을 adaptive audit에 병행 봉인, (d) artifact 형태를 contracts 공유 함수로 수렴한다.

### Task 1: 미커밋 settle 픽스를 baseline으로 커밋

**Files:**

- 기존 작업 트리: `apps/playwright-spec-for-ai-agent/packages/provider-playwright/index.mjs` (+41), 같은 패키지 `__tests__/playwright-browser-tool-gateway.test.mjs` (+27), `.changeset/adaptive-navigation-settle.md`

- [ ] **Step 1: 전체 게이트 실행**

Run: `cd apps/playwright-spec-for-ai-agent && pnpm test`
Expected: 전부 PASS. 실패 시 settle 픽스부터 디버깅 — 이 플랜의 전제.

- [ ] **Step 2: 브랜치 생성 후 커밋**

```bash
git checkout -b feat/qa-native-cohesion-pr1
git add apps/playwright-spec-for-ai-agent/packages/provider-playwright/index.mjs \
        apps/playwright-spec-for-ai-agent/packages/provider-playwright/__tests__/playwright-browser-tool-gateway.test.mjs \
        .changeset/adaptive-navigation-settle.md
git commit -m "fix: settle adaptive gateway DOM after navigation before sealing snapshots"
```

### Task 2: core에 관측 대기 정책 — `observationSettleBudget`

**Files:**

- Modify: `apps/playwright-spec-for-ai-agent/packages/core/index.mjs` (export 추가)
- Test: `apps/playwright-spec-for-ai-agent/packages/core/__tests__/` 아래 신규 파일 `observation-settle.test.mjs` (core에 `__tests__`가 없으면 `packages/__tests__/`의 기존 core 테스트 파일 옆에 추가 — `ls`로 먼저 확인)

**Interfaces:**

- Produces: `OBSERVATION_SETTLE_POLICY = Object.freeze({ capMs: 5000, quietMs: 300, reserveMs: 1000 })`, `observationSettleBudget(remainingMs, policy?) → { capMs, quietMs } | undefined`
- 이 함수가 "무엇을 얼마나 기다릴지"의 유일한 정의. provider의 `GATEWAY_NAVIGATION_SETTLE_MS`/`GATEWAY_NAVIGATION_SETTLE_QUIET_MS` 상수는 Task 3에서 삭제된다.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
import { expect, test } from "vitest";
import {
  OBSERVATION_SETTLE_POLICY,
  observationSettleBudget,
} from "../core/index.mjs";

test("settle budget clamps below remaining time with reserve", () => {
  expect(observationSettleBudget(10_000)).toEqual({
    capMs: 5_000,
    quietMs: 300,
  });
  expect(observationSettleBudget(3_000)).toEqual({
    capMs: 2_000,
    quietMs: 300,
  });
});

test("settle budget is a no-op under budget pressure, never negative", () => {
  expect(observationSettleBudget(1_000)).toBeUndefined();
  expect(observationSettleBudget(0)).toBeUndefined();
  expect(observationSettleBudget(-5)).toBeUndefined();
});

test("policy constants are frozen", () => {
  expect(Object.isFrozen(OBSERVATION_SETTLE_POLICY)).toBe(true);
});
```

(import 경로는 테스트 파일 위치에 맞춰 조정 — 기존 이웃 테스트의 import 형식을 그대로 따를 것.)

- [ ] **Step 2: 실행해 실패 확인**

Run: `pnpm test -- observation-settle`
Expected: FAIL — `observationSettleBudget is not a function` 계열.

- [ ] **Step 3: 최소 구현**

`packages/core/index.mjs`의 `DEFAULT_ADAPTIVE_BUDGET` 근처에 추가:

```js
// Single observation-settle policy: how long any evidence capture (strict observe node or
// adaptive snapshot) may wait for the DOM to become quiet before sealing. Execution lives in
// the provider; the numbers and the clamp rule live here so runtime, validator docs, and
// prompts can never disagree about them. Returns undefined when the remaining budget cannot
// fund a settle — callers must treat that as "capture as-is", never as an error.
export const OBSERVATION_SETTLE_POLICY = Object.freeze({
  capMs: 5_000,
  quietMs: 300,
  reserveMs: 1_000,
});

export function observationSettleBudget(
  remainingMs,
  policy = OBSERVATION_SETTLE_POLICY,
) {
  if (!Number.isFinite(remainingMs)) return undefined;
  const capMs = Math.min(policy.capMs, remainingMs - policy.reserveMs);
  return capMs > 0 ? { capMs, quietMs: policy.quietMs } : undefined;
}
```

- [ ] **Step 4: 테스트 PASS 확인 후 커밋**

```bash
git add -A && git commit -m "feat: observation settle policy owned by core"
```

### Task 3: provider가 core 정책 소비 — settle 상수 이전 + strict 관측 경로 정렬

**Files:**

- Modify: `apps/playwright-spec-for-ai-agent/packages/provider-playwright/index.mjs`
  - `GATEWAY_NAVIGATION_SETTLE_MS` / `GATEWAY_NAVIGATION_SETTLE_QUIET_MS` 상수(약 :45) 삭제
  - `settleGatewayDom`(약 :364) 내부 clamp를 `observationSettleBudget(remaining)` 호출로 교체
  - strict OBSERVE 노드(`executeNode` 내 OBSERVE 분기, `observeExpectations` 호출 :959 및 `observe` 호출부) 직전에 같은 settle 실행
- Test: `packages/provider-playwright/__tests__/playwright-browser-tool-gateway.test.mjs` (기존 settle 테스트가 상수 이전 후에도 통과하는지) + strict executor 테스트 파일에 settle 케이스 1건

**Interfaces:**

- Consumes: Task 2의 `observationSettleBudget`
- Produces: `settleDomForObservation(page, remainingMs)` — 브라우저 측 MutationObserver quiet-wait 한 벌. gateway(`settleGatewayDom` 래퍼, deadline/clock 기반)와 strict(OBSERVE 노드, nodeTimeout 잔여 기반) 둘 다 이걸 호출. throw 금지 — settle 실패는 no-op.

- [ ] **Step 1: 실패 테스트 — strict OBSERVE가 settle을 거친다**

strict executor 테스트에 추가 (기존 strict 테스트의 페이지 mock 패턴 재사용):

```js
test("strict observe waits for a quiet DOM before capturing expectations", async () => {
  // Arrange: page whose testid appears only after a mutation fired 100ms post-load
  // (기존 gateway settle 테스트의 lazy-render fixture 패턴을 strict 경로로 복제)
  // Act: OBSERVE 노드 실행
  // Assert: ELEMENT_OBSERVATION fact가 resolution FOUND / visible true
});
```

정확한 mock 구성은 `playwright-browser-tool-gateway.test.mjs`에 방금 커밋된 settle 테스트(+27줄)를 열어 같은 fixture를 재사용할 것.

- [ ] **Step 2: 실행해 실패 확인** (`pnpm test -- provider-playwright`)

- [ ] **Step 3: 구현**

`settleGatewayDom`의 `page.evaluate` quiet-wait 본문을 `settleDomForObservation(page, remainingMs)`로 추출:

```js
// Shared observation settle: both the strict OBSERVE node and the adaptive gateway route
// every evidence capture through this wait. Policy (cap/quiet/clamp) is core's
// observationSettleBudget; this function is only the browser-side mechanics. Never throws —
// under budget pressure or an evaluate/navigation race the capture proceeds with the DOM as-is.
async function settleDomForObservation(page, remainingMs) {
  const budget = observationSettleBudget(remainingMs);
  if (budget === undefined) return;
  try {
    await page.evaluate(
      ({ capMs, quietMs }) =>
        new Promise((resolve) => {
          /* 기존 settleGatewayDom의 MutationObserver/readystatechange 본문 그대로 이동 */
        }),
      budget,
    );
  } catch {
    // Budget exhausted or evaluate raced a navigation; capture proceeds with the DOM as-is.
  }
}
```

- `settleGatewayDom(page, timing)`은 `runGatewayBrowserOperation(timing, (remaining) => settleDomForObservation(page, remaining))` 래퍼로 축소.
- strict OBSERVE 분기: `observeExpectations` 호출 직전에 `await settleDomForObservation(page, visibilityDeadline - Date.now())` — 단, `observeExpectations`가 이미 쓰는 0.8× node timeout `visibilityDeadline` 예산 안에서만 (예산 이중 소모 금지: settle에 쓴 시간만큼 waitFor 잔여가 줄어드는 구조 유지, `Math.min` clamp는 `observationSettleBudget`이 담당).

- [ ] **Step 4: 전체 게이트 PASS 확인** — strict 기존 테스트가 시간 가정 때문에 깨지지 않는지 특히 확인. 깨지면 테스트가 아니라 settle의 no-op 조건을 먼저 의심.

- [ ] **Step 5: 커밋** `refactor: route strict and adaptive observation through the shared settle policy`

### Task 4: contracts에 `auditArtifactShape` — artifact 형태 단일 소스 (Phase 3)

**Files:**

- Modify: `apps/playwright-spec-for-ai-agent/packages/contracts/index.mjs` — export 추가. artifact type enum에 `ELEMENT_OBSERVATION`이 없으면 추가 + schemaVersion bump (contracts fields row 준수: 구 artifact 재판독 호환 확인)
- Test: contracts 테스트 파일에 shape 테스트

**Interfaces:**

- Produces: `auditArtifactShape(action) → { required: [{suffix, type}×5], optional: [type…] }`
  - required(모든 action 공통): `before:dom`/DOM_SNAPSHOT, `before:aria`/ARIA_SNAPSHOT, `action`/ACTION_LOG, `after:dom`/DOM_SNAPSHOT, `after:aria`/ARIA_SNAPSHOT
  - optional: `report_blocked` → `["VISIBLE_TEXT"]`, 그 외 → `[]`, 전 action 공통으로 `"ELEMENT_OBSERVATION"` 허용(Task 5의 병행 봉인; 구 audit엔 없으므로 optional)
- PR-3에서 optional 목록의 근거가 `ACTION_SPECS[action].extraArtifacts`로 옮겨간다 — 지금은 함수 내 리터럴로 시작 (YAGNI).

- [ ] **Step 1: 실패 테스트**

```js
import { expect, test } from "vitest";
import { auditArtifactShape } from "../contracts/index.mjs";

test("every action seals the five snapshot artifacts", () => {
  const shape = auditArtifactShape("click_observed_element");
  expect(shape.required.map((entry) => entry.type)).toEqual([
    "DOM_SNAPSHOT",
    "ARIA_SNAPSHOT",
    "ACTION_LOG",
    "DOM_SNAPSHOT",
    "ARIA_SNAPSHOT",
  ]);
  expect(shape.optional).toEqual(["ELEMENT_OBSERVATION"]);
});

test("report_blocked may seal one extra VISIBLE_TEXT", () => {
  expect(auditArtifactShape("report_blocked").optional).toEqual([
    "VISIBLE_TEXT",
    "ELEMENT_OBSERVATION",
  ]);
});
```

- [ ] **Step 2: 실패 확인 → 구현 → PASS**

```js
// Single definition of what a sealed adaptive audit looks like. The provider builds audits
// from this shape and the evidence validator counts against it — neither side keeps its own
// copy of "exactly five plus VISIBLE_TEXT". Optional types are per-audit 0-or-1.
const AUDIT_REQUIRED_ARTIFACTS = Object.freeze([
  Object.freeze({ suffix: "before:dom", type: "DOM_SNAPSHOT" }),
  Object.freeze({ suffix: "before:aria", type: "ARIA_SNAPSHOT" }),
  Object.freeze({ suffix: "action", type: "ACTION_LOG" }),
  Object.freeze({ suffix: "after:dom", type: "DOM_SNAPSHOT" }),
  Object.freeze({ suffix: "after:aria", type: "ARIA_SNAPSHOT" }),
]);

export function auditArtifactShape(action) {
  const optional =
    action === "report_blocked"
      ? ["VISIBLE_TEXT", "ELEMENT_OBSERVATION"]
      : ["ELEMENT_OBSERVATION"];
  return { required: AUDIT_REQUIRED_ARTIFACTS, optional };
}
```

- [ ] **Step 3: artifact type enum 확인** — `grep -n "ELEMENT_OBSERVATION\|DOM_SNAPSHOT" packages/contracts/index.mjs`로 artifact type이 스키마 enum으로 검증되는지 확인. enum이면 `ELEMENT_OBSERVATION` 추가 + schemaVersion bump + 구 스키마 버전 audit 재판독 테스트(기존 legacy 4-key audit shim 테스트 옆에) 추가.

- [ ] **Step 4: 커밋** `feat: shared adaptive audit artifact shape in contracts`

### Task 5: adaptive audit에 expectation별 element observation 병행 봉인

**Files:**

- Modify: `apps/playwright-spec-for-ai-agent/packages/provider-playwright/index.mjs`
  - `captureGatewayArtifacts(store, proposal, before, after, satisfiedMilestoneIds)`(:578) — 6번째 인자 `elementObservations` 추가, 있으면 `{proposalId}:elements` / type `ELEMENT_OBSERVATION` / `application/json` 봉인
  - `execute` closure(:204~): 매 accepted action 후, PENDING인 `REQUIRED_SEMANTIC_MILESTONE` 중 `expectation`을 가진 milestone들에 대해 expectation별 `{milestoneId, resolution, visible, text}` 관측 → 봉인
- Test: `playwright-browser-tool-gateway.test.mjs`

**Interfaces:**

- Consumes: 기존 `observeExpectations(page, expectations, nodeId, timeout)`(:1090)의 관측 로직 — milestone의 `{target, expectation:{kind, expected}}`를 strict expectation 레코드 형태 `{id: milestone.id, kind, target, expected}`로 매핑해 재사용. 새 관측 코드 작성 금지 (strict 관측 코드 재사용이 Phase 1의 요구).
- Produces: judge가 소비할 artifact — JSON `[{ milestoneId, resolution: "FOUND"|"MISSING"|"AMBIGUOUS", visible, text }]`. 대기 예산은 gateway deadline 잔여에 `observationSettleBudget` clamp — 2.4 race 패턴 금지.

- [ ] **Step 1: 실패 테스트**

```js
test("accepted actions seal per-expectation element observations for the judge", async () => {
  // Arrange: milestone with expectation (testid target), lazy-rendered page fixture 재사용
  // Act: observe_dom 실행 (accepted)
  // Assert: bundle artifacts에 type ELEMENT_OBSERVATION 1개,
  //   JSON.parse(blob) → [{ milestoneId, resolution: "FOUND", visible: true, text: expect.any(String) }]
});
```

- [ ] **Step 2: 실패 확인 → 구현**

`observeExpectations`는 strict 전용 fact 형태를 반환하므로, 내부의 "expectation 1건 관측" 부분을 `observeExpectationTarget(page, expectation, deadlineMs)` 헬퍼로 추출해 strict(`observeExpectations`)와 gateway 양쪽이 호출하게 한다. gateway 측:

```js
async function observeGatewayMilestoneExpectations({
  page,
  milestones,
  deadline,
  clock,
}) {
  const targets = milestones
    .filter(
      (milestone) =>
        milestone.status === "PENDING" &&
        milestone.expectation !== undefined &&
        milestone.target !== undefined,
    )
    .map((milestone) => ({
      id: milestone.id,
      kind: milestone.expectation.kind,
      target: milestone.target,
      expected: milestone.expectation.expected,
    }));
  const observations = [];
  for (const target of targets) {
    const remaining = deadline - clock.now();
    const budget = observationSettleBudget(remaining);
    if (budget === undefined) break; // budget pressure: partial observations are still facts
    observations.push({
      milestoneId: target.id,
      ...(await observeExpectationTarget(page, target, budget.capMs)),
    });
  }
  return observations;
}
```

(정확한 clock/deadline 접근 형태는 `runGatewayBrowserOperation` 기존 시그니처를 따를 것. `observeExpectationTarget` 추출 시 strict 경로의 기존 테스트가 전부 통과해야 함 — 행동 불변.)

- [ ] **Step 3: judge가 ELEMENT_OBSERVATION artifact를 semantic 입력에 포함**

`packages/judge/index.mjs`의 `buildSemanticJudgeInput`(:47 부근)에서 audit artifact 순회에 `ELEMENT_OBSERVATION` 타입 포함 — v2.4의 expectation-adjacent evidence slicing 로직 옆에 배치. 테스트: semantic judge 입력 스냅샷에 element observation 항목이 들어가는 것 1건.

- [ ] **Step 4: 전체 게이트 PASS → 커밋** `feat: seal per-expectation element observations into adaptive audits`

### Task 6: validator·provider가 shape 소비 (하드코딩 "정확히 5" 제거)

**Files:**

- Modify: `apps/playwright-spec-for-ai-agent/packages/cli/qa-native-adaptive-evidence.mjs:19-25,36` — 리터럴 카운트 검사를 `auditArtifactShape(proposal.action)` 기반으로 교체
- Modify: `packages/provider-playwright/index.mjs` `captureGatewayArtifacts` — 봉인 순서/타입을 shape의 `required` 배열 순회로 생성
- Test: `packages/cli/__tests__/qa-native-adaptive-matrix.test.mjs` (기존 매트릭스 fixture가 전부 통과해야 함) + 구 evidence(ELEMENT_OBSERVATION 없는 5-artifact audit) 재검증 테스트

**Interfaces:**

- Consumes: Task 4 `auditArtifactShape`
- 검사 규칙: required 타입별 개수 정확 일치, optional 타입은 각 0~1개, 그 외 타입 0개. `VISIBLE_TEXT`의 report_blocked 전용 제약(:36)은 shape의 optional 목록이 대체 — action별 optional이 이미 그 제약임.

- [ ] **Step 1: 실패 테스트 — 변조 케이스**

```js
test("rejects an audit with a duplicated optional artifact", () => {
  // VISIBLE_TEXT 2개인 report_blocked audit → "adaptive checkpoint evidence is incomplete"
});
test("accepts pre-refactor five-artifact audits without element observations", () => {
  // 기존 fixture 그대로 → 통과 (validator는 runtime보다 관대해야 함)
});
```

- [ ] **Step 2: validator 교체 구현**

```js
import { auditArtifactShape } from "../contracts/index.mjs";
// ...
const shape = auditArtifactShape(proposal.action);
const requiredCounts = shape.required.reduce(
  (counts, entry) => ({
    ...counts,
    [entry.type]: (counts[entry.type] ?? 0) + 1,
  }),
  {},
);
const actualCounts = verified.bundle.artifacts.reduce(
  (counts, artifact) => ({
    ...counts,
    [artifact.type]: (counts[artifact.type] ?? 0) + 1,
  }),
  {},
);
const admissible = new Set([...Object.keys(requiredCounts), ...shape.optional]);
const complete =
  Object.entries(requiredCounts).every(
    ([type, count]) => actualCounts[type] === count,
  ) &&
  shape.optional.every((type) => (actualCounts[type] ?? 0) <= 1) &&
  Object.keys(actualCounts).every((type) => admissible.has(type));
if (!complete) throw new Error("adaptive checkpoint evidence is incomplete");
```

주의: 현재 코드는 shape 검사가 proposal 파싱(:35) **이전**에 있다 — action을 알아야 shape를 고르므로 ACTION_LOG 파싱을 먼저 하도록 순서 조정 (ACTION_LOG 1개 존재 검사만 앞에 남긴다).

- [ ] **Step 3: provider 봉인을 shape 순회로** — `captureGatewayArtifacts`의 5줄 하드코딩을 `shape.required` 순회로. 기존 gateway 테스트 전부 PASS 확인.

- [ ] **Step 4: 전체 게이트 → 커밋** `refactor: provider seal and validator both consume auditArtifactShape`

### Task 7: 문서·changeset·게이트

- [ ] **Step 1: AGENTS.md 갱신**
  - §2 "Timing / clock / wait-budget" row에 단일 정책 명시: "관측 대기는 core `observationSettleBudget` 한 벌 — 새 대기를 추가하려면 이 함수를 통과시켜라". no-DEBUG 판정 지침은 유지.
  - §2 "Milestone model" row와 provider row의 "exact-five artifact" 문구를 `auditArtifactShape` 참조로 교체.
  - §1 모듈 표: contracts 행에 `auditArtifactShape`, core 행에 `observationSettleBudget` 추가.
- [ ] **Step 2: changeset** — 기존 `adaptive-navigation-settle.md`(patch)에 더해 element observation 봉인은 새 capability이므로 minor changeset 1건 추가. `pnpm changeset version` 적용 여부는 발행 보류 정책에 따라 사람 결정 (메모리: version-bump된 PR 머지 = 자동 발행).
- [ ] **Step 3: 게이트** — `pnpm test` 전체 출력 보고. 소비 repo(Deep-Agent develop-11) adaptive 원샷 → judge FAIL 0 확인, strict 5연속 유지. 이 확인 전까지 PR 머지 금지.

---

# PR-2 — 에러 투명화 (Phase 6)

문제: `packages/cli/qa-native.mjs:174-186`의 CliError 이분법 — CliError만 메시지가 stderr로 가고 내부 Error는 `QA_NATIVE_DEBUG` 없이는 은폐된다. 5회째 지적된 운영 비용.

### Task 1: 모든 실패의 원인 문자열을 no-DEBUG stderr로

**Files:**

- Modify: `apps/playwright-spec-for-ai-agent/packages/cli/qa-native.mjs:174-186` (top-level 에러 핸들러)
- Test: `packages/cli/__tests__/` CLI 셸 테스트 (stderr는 injectable — `qa-native.mjs:151`의 주입 지점 사용)

- [ ] **Step 1: 실패 테스트**

```js
test("internal errors surface their message without QA_NATIVE_DEBUG", async () => {
  // Arrange: 핸들러가 TypeError("boom")을 던지는 command mock, env에 QA_NATIVE_DEBUG 없음
  // Act: run CLI entry
  // Assert: stderr에 "qa-native: <command> failed: boom" 포함, stack trace 미포함
});
test("QA_NATIVE_DEBUG adds the stack", async () => {
  /* stack 포함 확인 */
});
```

- [ ] **Step 2: 구현** — 이분법 폐지:

```js
const detail =
  error instanceof CliError
    ? error.message
    : `${command} failed: ${error.message}`;
stderr(`qa-native: ${detail}\n`);
if (env[DEBUG_ENV] && !(error instanceof CliError)) stderr(`${error.stack}\n`);
```

(기존 핸들러의 정확한 변수명은 :174-186을 읽고 맞출 것. AGENTS.md §3-4 "Diagnostics are never swallowed: stderr always, details behind QA_NATIVE_DEBUG"가 이 변경의 명문 근거.)

- [ ] **Step 3: 실측 은폐 사례를 테스트로 고정**
  - strict 실패 시 `runtimeOutcome.code`/`message`가 no-DEBUG stderr에 노출되는 테스트 (execute 핸들러 경로).
  - report의 "explicit judgment path" 결정이 no-DEBUG로 노출되는 테스트 (`qa-native-report.mjs` 경로).

- [ ] **Step 4: `--judgment` 개선** (`qa-native.mjs:293` `normalizeRequest`, `COMMAND_USAGE` :34-41)
  - usage에 "run-dir 상대 경로" 명시.
  - 디렉토리 지정 허용: 디렉토리면 내부 judgment 파일 중 최신 COMPLETED 자동 선택. 다중/0건 시 명시적 에러 메시지 (후보 나열).
  - 테스트: 파일 지정·디렉토리 지정·후보 없음 3케이스.

- [ ] **Step 5: 매트릭스 "CLI options" row 절차 준수** — usage/help, README, `docs/qa-native-one-shot-runbook.md` 갱신. patch changeset. 전체 게이트 → 커밋.

---

# PR-3 — ACTION_SPECS 단일 소스화 (Phase 2)

현재 어휘 6벌: ① `contracts/index.mjs:37` `ADAPTIVE_ACTIONS`(12종) ② `contracts:1577` `validateAdaptiveActionParameters` if-체인 ③ `core:191-193` lease 조립 + `core:125` `safeRecoveryActions`(9종) ④ `provider-playwright:49` `GATEWAY_ACTIONS` ⑤ `provider-hermes:30` 프롬프트 파라미터 산문 ⑥ element allowedActions(`contracts:1556`). 전부 조회로 전환. **행동 불변 PR** — 기존 vitest 전체와 소비 repo verdict가 baseline과 동일해야 함.

정본 12종: `observe_dom, observe_aria, get_current_url, navigate, click_observed_element, press_key, hover_observed_element, scroll_view, wait_for_element_state, go_back, reload_page, report_blocked`.

### Task 1: contracts에 ACTION_SPECS 정의 + ADAPTIVE_ACTIONS 파생

**Files:**

- Modify: `packages/contracts/index.mjs` — `ADAPTIVE_ACTIONS`(:37) 자리에:

```js
// The single action vocabulary. Every consumer derives from this table:
// lease building (core), gateway dispatch guard (provider-playwright), parameter
// validation (below), prompt prose (provider-hermes), milestone semantics (core
// milestoneCompletionRule), audit shape extras (auditArtifactShape).
export const ACTION_SPECS = Object.freeze({
  observe_dom: Object.freeze({
    params: Object.freeze({}),
    recovery: true,
    provesSemantic: true,
  }),
  observe_aria: Object.freeze({
    params: Object.freeze({}),
    recovery: true,
    provesSemantic: true,
  }),
  get_current_url: Object.freeze({ params: Object.freeze({}), recovery: true }),
  navigate: Object.freeze({
    params: Object.freeze({ url: "string" }),
    requiresPolicy: "navigation",
  }),
  go_back: Object.freeze({
    params: Object.freeze({}),
    requiresPolicy: "navigation",
  }),
  reload_page: Object.freeze({
    params: Object.freeze({}),
    requiresPolicy: "navigation",
  }),
  click_observed_element: Object.freeze({
    params: Object.freeze({ observationId: "string", elementId: "string" }),
    requiresPolicy: "click",
    recovery: true,
    elementBound: true,
  }),
  hover_observed_element: Object.freeze({
    params: Object.freeze({ observationId: "string", elementId: "string" }),
    requiresPolicy: "click",
    recovery: true,
    elementBound: true,
  }),
  press_key: Object.freeze({
    params: Object.freeze({ key: "escape-only" }),
    requiresPolicy: "click",
    recovery: true,
  }),
  scroll_view: Object.freeze({
    params: Object.freeze({ deltaX: "int", deltaY: "int" }),
    recovery: true,
  }),
  wait_for_element_state: Object.freeze({
    params: Object.freeze({
      observationId: "string",
      elementId: "string",
      state: "element-state",
      timeoutMs: "timeout",
    }),
    recovery: true,
    elementBound: true,
    provesSemantic: Object.freeze({ states: ["present", "visible"] }),
  }),
  report_blocked: Object.freeze({
    params: Object.freeze({ milestoneId: "string", reason: "string" }),
    recovery: true,
    terminal: true,
    extraArtifacts: Object.freeze(["VISIBLE_TEXT"]),
  }),
});

export const ADAPTIVE_ACTIONS = Object.freeze(Object.keys(ACTION_SPECS));
```

**주의:** params 값 문자열(`"escape-only"`, `"element-state"`, `"timeout"`, `"int"`)은 검증 descriptor 키 — Step 2에서 기존 if-체인(:1577-1613)의 실제 검증 로직(press_key는 `{key:"Escape"}` 고정, scroll_view는 non-zero int 등)을 descriptor별 검증 함수 테이블로 옮긴다. 기존 검증과 **의미가 1:1 동일**해야 함 — 기존 contracts 테스트가 판정.

- [ ] Step 1: 파생 동등성 테스트 — `ADAPTIVE_ACTIONS`가 기존 12종·기존 순서와 동일 (스냅샷). 기존 순서를 바꾸면 lease hash(`canonicalHash({... actions ...})`)가 변해 행동이 변한다 — **spec 객체 키 순서를 기존 ADAPTIVE_ACTIONS 순서와 일치**시킬 것.
- [ ] Step 2: `validateAdaptiveActionParameters`(:1577) — if-체인을 `ACTION_SPECS[action].params` 순회 + descriptor 검증 테이블로 교체. 기존 오류 메시지 문자열 유지 (테스트가 메시지에 의존할 수 있음 — grep으로 확인).
- [ ] Step 3: element allowedActions(:1556) — `Object.entries(ACTION_SPECS).filter(([, spec]) => spec.elementBound).map(([name]) => name)` 파생으로 교체.
- [ ] Step 4: 전체 게이트 PASS → 커밋 `refactor: action vocabulary defined once as ACTION_SPECS`.

### Task 2: core 소비 — lease 조립·safeRecoveryActions·milestoneCompletionRule

**Files:** `packages/core/index.mjs:191-193`(lease), `:125`(safeRecovery), `:248-258`(completionRule)

- [ ] Step 1: 파생 동등성 테스트 3건 — 각 policy 조합에서 lease actions가 기존 배열과 **순서까지** 동일; safeRecoveryActions 동일; completionRule 진리표 동일(observe_dom/observe_aria/wait present·visible만 semantic 증명).
- [ ] Step 2: 구현:

```js
const actions = ADAPTIVE_ACTIONS.filter((action) => {
  const requires = ACTION_SPECS[action].requiresPolicy;
  if (requires === "navigation")
    return scenario.policy.navigation === "ALLOWED";
  if (requires === "click")
    return ["SAFE_ONLY", "ALL"].includes(scenario.policy.click);
  return true;
});
```

**순서 함정:** 기존 lease는 base-6 + push 순서(`observe_dom, observe_aria, get_current_url, scroll_view, wait_for_element_state, report_blocked, navigate…, click…`)였다. filter 파생은 ACTION_SPECS 키 순서를 따르므로 다르다 → leaseId hash가 변한다. leaseId는 run마다 새로 생성되므로 **구 evidence 재판독에는 영향 없음**(lease는 audit에 통째로 저장되어 비교됨)을 validator 테스트로 확인하고, 그래도 기존 스냅샷 테스트가 순서에 의존하면 스냅샷 갱신을 changeset에 명시. 확신 없으면 기존 순서를 재현하는 정렬을 넣지 말고 **기존 순서대로 ACTION_SPECS 키를 배열**하는 쪽을 선택할 것 (Task 1 Step 1과 동일 원칙).

- [ ] Step 3: `milestoneCompletionRule`(:251-252)의 `["observe_dom","observe_aria"].includes(action)` / wait-state 하드코딩을 `ACTION_SPECS[action]?.provesSemantic` 조회로:

```js
const proof = ACTION_SPECS[action]?.provesSemantic;
const observeAction = proof === true;
const waitAction =
  typeof proof === "object" && proof.states.includes(parameters?.state);
```

- [ ] Step 4: 전체 게이트 → 커밋.

### Task 3: provider·hermes 소비 + 프롬프트 버전 해시 연동

- [ ] Step 1: `provider-playwright:49` `GATEWAY_ACTIONS` 삭제 → `import { ADAPTIVE_ACTIONS } from "../contracts/index.mjs"` 사용. dispatch if-체인은 유지 (실행 로직 자체는 action별로 다름 — 어휘 사본만 제거).
- [ ] Step 2: `provider-hermes:30`의 파라미터 산문을 생성 함수로:

```js
function actionParameterProse() {
  const groups = new Map();
  for (const [name, spec] of Object.entries(ACTION_SPECS)) {
    const key =
      Object.keys(spec.params).length === 0
        ? "{}"
        : `{${Object.keys(spec.params).join(",")}}`;
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  return [...groups.entries()]
    .map(([params, names]) => `${names.join(", ")} use ${params}`)
    .join("; ");
}
```

기존 산문과 문구가 달라지므로 프롬프트 골든 테스트가 있으면 1회 갱신하고, `EXECUTION_PROMPT_VERSION`(:14)을 spec 해시 연동으로:

```js
export const EXECUTION_PROMPT_VERSION = `hermes-adaptive-execution/0.2+${canonicalHash(ACTION_SPECS).slice("sha256:".length, "sha256:".length + 8)}`;
```

이후 ACTION_SPECS 변경 = 프롬프트 버전 자동 bump — 매트릭스 "Hermes prompts" row ① 자동화.

- [ ] Step 3: 가짜 action 시연 fixture (완료 정의 3):

```js
test("adding an action to ACTION_SPECS propagates to all four consumers", () => {
  const specs = {
    ...ACTION_SPECS,
    fake_action: {
      params: { foo: "string" },
      requiresPolicy: "click",
      recovery: true,
    },
  };
  // lease 조립 함수·파라미터 검증·prose 생성·auditArtifactShape를 specs 주입 가능 형태로 두고
  // 4곳 모두에 fake_action이 나타나는지 단언
});
```

주입이 과하면(함수들이 모듈 상수를 직접 읽는 구조면) 이 테스트는 "ACTION_SPECS에서 파생됨"을 각 소비처별 동등성 단언으로 대체 — 시연 목적은 회귀 방지이지 DI 도입이 아님.

- [ ] Step 4: 문서 — AGENTS.md §2 **"Adaptive action vocabulary" row 삭제**, §1 표의 관련 constraint를 "ACTION_SPECS 단일 소스" 한 줄로 교체. "Hermes prompts" row에서 ①(수동 버전 bump) 제거. minor changeset(프롬프트 버전 변경은 판정 비교성에 영향). 전체 게이트 + **소비 repo 원샷 verdict 동일** 확인 후 머지.

---

# PR-4 — validator 무결성 전용화 (Phase 4)

PR-1·3 이후 `qa-native-adaptive-evidence.mjs`에 남는 것: HMAC/체인(evidence 위임), run/scenario/lease 바인딩, origin, 페이지 연속성, milestone 진행(core 규칙 import), artifact 형태(contracts 함수 import). 독자 재구현 의미론이 0인지 감사하고 역할을 명문화한다.

- [ ] Step 1: 파일 상단에 역할 선언 주석:

```js
// integrity only — this file verifies that sealed evidence is untampered and bound to its
// run. Semantics (milestone completion, action vocabulary, artifact shape) live in core and
// contracts and are imported, never re-derived. Epicenter of the 2.3.0 regression: a local
// copy of completion semantics drifted from the runtime and rejected its own output.
```

- [ ] Step 2: 잔존 의미론 감사 — `milestoneCompletionRule`·`auditArtifactShape`·`validateContract` 외의 의미 판단이 남아 있으면 (예: `:64`의 semantic milestone 연쇄 스킵 루프) core로 옮길지 판단. 이 루프는 "완료 규칙"이 아니라 "순서 검증"이므로 유지가 맞다 — 판단 근거를 주석 한 줄로.
- [ ] Step 3: 변조 fixture 3종 테스트 (`packages/cli/__tests__/qa-native-adaptive-matrix.test.mjs` 옆 신규 파일):

```js
test("rejects a tampered artifact blob", () => {
  /* blob 1바이트 변조 → verifyStoredEvidence throw */
});
test("rejects reordered audits", () => {
  /* audit 2개 순서 스왑 → "out of sequence" */
});
test("rejects a forged COMPLETED outcome", () => {
  /* milestone 미완인데 outcome COMPLETED → "lacks accepted evidence" */
});
```

fixture 생성은 기존 매트릭스 테스트의 record 헬퍼 재사용.

- [ ] Step 4: AGENTS.md §2 **"Milestone model" row를 §3 불변식으로 축소** (single-source 참조 한 줄), validator row의 constraint를 "integrity only" 선언으로 교체. patch changeset. 게이트 → 커밋.

---

# PR-5 — scripts/ 레이어 흡수 (Phase 5)

레이어 역전 실측: `packages/adapter-playwright:8` → `scripts/dashboard-spec-parser.mjs`, `packages/cli/qa-native-propose-patch.mjs:9`·`qa-native-remediate.mjs:10` → `scripts/hermes-qa-project-config.mjs`, `packages/provider-hermes:9` → `scripts/hermes-runner.mjs`.

### Task 1: packages/spec-parser 신설 + 파서 3종 이동

- [ ] Step 1: `packages/spec-parser/` 생성 (`"private": true` — changeset 불요). `git mv`로 `scripts/playwright-ast-parser.mjs`, `scripts/dashboard-spec-parser.mjs`, `scripts/expectation-abstractor.mjs` 이동. 내부 상호 import 경로 수정.
- [ ] Step 2: `packages/adapter-playwright/index.mjs:8` import를 `../spec-parser/dashboard-spec-parser.mjs`로. `scripts/` 자리에는 re-export shim 3파일 (`export * from "../packages/.../x.mjs"`) — 구 flow bin 인터페이스 불변 요구.
- [ ] Step 3: vitest alias 주의 — 메모리 기록: cross-package 해석은 vitest alias로 해결한 전례 있음(tsconfig paths 아님). `vitest.config` alias에 spec-parser 추가 필요한지 확인.
- [ ] Step 4: `packages/__tests__/agents-md-refs.test.mjs`와 AGENTS.md §1 경로 갱신. 게이트 PASS.

### Task 2: hermes 지원 파일을 provider-hermes로

- [ ] `scripts/hermes-qa-project-config.mjs` → `packages/provider-hermes/project-config.mjs`, `scripts/hermes-runner.mjs` → `packages/provider-hermes/runner.mjs`. CLI 2곳 import 갱신, scripts/에 shim. `scripts/hermes-runner-smoke.mjs` 실행 스모크로 인터페이스 불변 확인.

### Task 3: 진단 단일 함수 `emitDiagnostic`

- [ ] Step 1: 현 진단 방출 지점 조사 — `dashboard-spec-parser.mjs`(:145, :202 부근)와 `adapter-playwright/index.mjs`의 file-level vs test-level `testIndex` 해석(:44-48, :235 부근)을 읽고, 진단 레코드가 만들어지는 모든 지점 목록화.
- [ ] Step 2: `packages/spec-parser/diagnostics.mjs`에 한 벌:

```js
// Every diagnostic goes through here. testIndex resolution is built in so a new emit site
// cannot forget it — the 2.1.0 regression (missing testIndex neutralized --allow-partial)
// becomes structurally impossible.
export function emitDiagnostic({ code, message, severity, node, testIndex }) {
  return Object.freeze({
    code,
    message,
    severity,
    testIndex: testIndex ?? resolveTestIndex(node),
  });
}
```

(`resolveTestIndex`는 Step 1에서 파악한 adapter의 기존 해석 로직 이동. 실제 레코드 필드는 기존 진단 객체 형태를 grep으로 확인해 맞출 것 — 필드 추가/삭제 금지, 행동 불변.)

- [ ] Step 3: 방출 지점 전부 이 함수로 교체. `--allow-partial` 기존 테스트 + testIndex 누락이 불가능함을 보이는 테스트 1건(“node 없이 emit하면 throw” 또는 resolve 보장). AGENTS.md §2 **"Diagnostics codes" row 삭제** (emitDiagnostic 참조 한 줄을 §1 표로). patch changeset. 게이트 → 커밋.

---

# PR-6 — 잔여 + 게이트·문서 마감 (Phase 7+8)

- [ ] **adaptive 소모량 summary**: 시나리오별 {턴 수, 경과 초, 토큰}을 report에 추가. 데이터 원천: ACTION_LOG artifact 수(턴), bundle 타임스탬프(초), `tokensUsed`(execute closure가 이미 수신 — :204). `packages/reporter-markdown`에 표 1개 렌더 + 테스트.
- [ ] **AGENTS.md §2 최종 4행**: `@qa-live-policy` values · CLI options · Contracts fields · Evidence deletion/failure paths. 삭제된 행들은 §1 표의 모듈별 constraint 한 줄(단일 소스 참조)로 흡수. "Browser network policy"·"Timing" row는 named test + runbook 참조로 축소해 §3 불변식에 편입. "Budget shape" row는 PR-3 이후 authorizer exhaustion 검사·`--budget-*` 플래그·프롬프트 문장이 전부 core `DEFAULT_ADAPTIVE_BUDGET` 파생인지 확인 후 core row constraint 한 줄로 흡수 — 파생이 아닌 사본이 남아 있으면 행 유지하고 사유 기록.
- [ ] **runbook**: `docs/qa-native-one-shot-runbook.md`에 릴리즈 조건 명문화 — "strict no-DEBUG 3연속 + adaptive judge FAIL 0".
- [ ] **policy 매트릭스 CI 게이트**: `packages/cli/__tests__/fixtures/policy-matrix.spec.ts`가 5개 policy 공존을 커버하는지 확인, 부족하면 fixture 확장. strict·adaptive record/replay 케이스가 vitest에서 도는지 확인 (이미 `qa-native-adaptive-matrix.test.mjs` 존재 — 커버리지 gap만 메움).
- [ ] **contracts 수제 검증기 축소는 보류** — 위상 정리 후 재평가 (원문 플랜 결정 유지).
- [ ] **소비 repo 몫 이슈 전달**: Deep-Agent에 SSR/클라이언트 마크업 불일치(testid가 hydration 후 등장) + hydration 전 로그인 GET 제출 — 별도 이슈로 작성 (이 repo 코드 변경 아님).
- [ ] **최종 게이트**: `pnpm test` 전체 출력 + 소비 repo strict 5연속 / adaptive FAIL 0 / report 확인. changeset 쌓인 상태 정리 — push/PR/발행은 사람 결정.

---

## 리스크와 완화

| 리스크                                                 | 완화                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| PR-1 settle 대기로 실행 시간 증가                      | `observationSettleBudget` clamp — node/gateway 예산 내, no-op fallback. 2.4 race 패턴 금지 |
| PR-3 lease action 순서 변화 → leaseId hash 변화        | ACTION_SPECS 키 순서를 기존 배열 순서로 고정 + 동등성 스냅샷 테스트 선행                   |
| 프롬프트 문구 변화로 판정 드리프트                     | PROMPT_VERSION spec-hash 연동 + 소비 repo adaptive baseline verdict 비교 게이트            |
| scripts 이동으로 구 flow 파손                          | scripts/ re-export shim + `hermes-runner-smoke.mjs` 스모크                                 |
| 리팩터 중 발행 사고                                    | changeset 쌓기만, `pnpm changeset version` 적용·머지는 사람 결정                           |
| ELEMENT_OBSERVATION artifact로 구 evidence 재판독 실패 | shape에서 optional 처리 + legacy audit 재검증 테스트 (기존 4-key shim 전례 따름)           |
