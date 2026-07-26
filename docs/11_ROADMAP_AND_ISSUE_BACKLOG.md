# 11. Roadmap, PR Slicing, GitHub Issue Backlog

## 1. 전체 우선순위

```text
P0 — 기존 동작 보존
P1 — Contract와 Evidence
P2 — Single-session runtime
P3 — Persona / Validity
P4 — Findings / Report
P5 — Variant / GitHub
P6 — Calibration
P7 — Remediation integration
```

UI dashboard보다 Runtime contract와 local CLI를 먼저 만든다.

---

## 2. Milestone A — Safe Migration

### BR-01 Freeze v0.9 compatibility

- current command golden
- artifact schema snapshot
- package pack smoke
- release baseline

### BR-02 Convert repository to pnpm workspace

- private root
- existing package subdir
- no feature change
- CI updated

### BR-03 Migrate release-please/npm publish

- package path config
- provenance
- tarball test
- rollback guide

### BR-04 Extract legacy Playwright parser

- legacy parser package
- thin wrappers
- existing tests moved
- no semantic change

Exit:

- `playwright-spec-for-ai-agent@0.10.0`
- old CLI unchanged

---

## 3. Milestone B — Canonical Contracts

### BR-05 Add versioned QA IR

- source provenance
- stable ID
- policy and expectation
- JSON Schema

### BR-06 Add StudySpec

- environment
- tasks
- oracles
- personas
- runtime/evidence/evaluation config

### BR-07 Compile Playwright IR to StudySpec

- warnings
- policy mapping
- example generated YAML
- import CLI

Exit:

```bash
persona-runtime import-playwright ...
persona-runtime validate ...
```

---

## 4. Milestone C — Evidence-first Runtime

### BR-08 Add runtime state machine

- run/session
- terminal status
- cancellation
- budgets

### BR-09 Add direct Playwright driver

- isolated context
- observation
- action executor
- origin/action safety

### BR-10 Add filesystem evidence store

- event/observation JSONL
- screenshot
- trace
- runtime issue
- sealed manifest

### BR-11 Add deterministic oracle evaluator

- URL/text/element/network/event/download
- oracle result evidence

### BR-12 Add browserless evaluation boundary

- browser closes
- evidence verification
- functional result

Exit:

- single task/persona end-to-end
- `v0.12.0`

---

## 5. Milestone D — Persona Runtime

### BR-13 Add behavior policy and seeded sampling

- distributions
- sample serialization
- presets

### BR-14 Add attention/perceived observation

- visible/viewport
- weighted candidates
- no hidden DOM

### BR-15 Add abandonment and non-action

- ignore/idle/observe_more/abandon
- no-progress budget
- persona state reducer

### BR-16 Add multi-session orchestrator

- persona × seed
- concurrency
- independent contexts

Exit:

- at least 3 personas × 3 seeds
- `v0.13.0`

---

## 6. Milestone E — Simulation Validity

### BR-17 BehavioralFingerprint

- action/route/error vectors
- curves
- goal-directedness

### BR-18 Population diversity report

- intra/inter distance
- route/action entropy
- homogenization risk

### BR-19 Stability and risk heuristics

- seed variance
- hyperactivity
- excessive cooperation
- positivity risk
- insufficient sample

### BR-20 Human validation gate

- calibration state
- recommended use
- forbidden interpretations

Exit:

- every study has validity report

---

## 7. Milestone F — Findings and Reporting

### BR-21 Behavioral evaluator

- evidence-only
- observation/interpretation/recommendation
- friction point

### BR-22 Finding clusterer

- deterministic candidate key
- optional semantic merge
- stable fingerprint

### BR-23 Severity/confidence/maturity

- decomposed confidence
- finding maturity
- human validation requirement

### BR-24 Static HTML report

- summary
- validity
- finding cards
- timeline
- evidence viewer
- cost

Exit:

- `v0.14.0`

---

## 8. Milestone G — Variant and GitHub

### BR-25 Paired baseline/candidate runner

- same sampled policy
- isolated contexts
- metrics delta

### BR-26 Order robustness

- counterbalanced execution
- reversed judge input
- unstable result

### BR-27 Release gate policy

- fail/warn rules
- uncalibrated restrictions

### BR-28 GitHub reporter

- Check
- idempotent comment
- artifact link
- infra/product distinction

Exit:

- `v0.15.0`

---

## 9. Milestone H — Analytics Calibration

### BR-29 Human reference dataset contract

- aggregate/cluster privacy
- data window
- features

### BR-30 PostHog adapter

- route/event sequence
- funnel/abandonment
- no direct identifier

### BR-31 Human-synthetic benchmark

- distribution similarity
- next action
- abandonment/error reaction
- calibration report

Exit:

- calibrated behavioral risk

---

## 10. Existing remediation epic #13~#23 integration

현재 이슈를 새 backlog로 복제하지 않는다.

공유 지점:

| Existing issue | Persona Runtime output |
|---|---|
| `#13` remediation epic | sealed evidence + independent judgment |
| `#14` publish failure issue | Finding + evidence refs + human gate |
| `#15` dedup fingerprint | stable finding fingerprint |
| `#16` patch proposal | only eligible after diagnosis gate |
| `#17` isolated worktree | no change |
| `#18` deterministic verification | runtime can provide study replay |
| `#19` before/after live rerun | Variant Comparison reused |
| `#20` expectation weakening | StudySpec/Oracle integrity hash |
| `#21` Issue/Draft PR routing | maturity/confidence/human gate input |
| `#22` independent review | browserless independent evaluator |
| `#23` orchestration | shared versioned contracts |

### Important dependency rule

`BR-10 Evidence Store`, `BR-11 Oracle`, `BR-23 Finding fingerprint`,
`BR-25 Variant Comparison`은 remediation contract와 함께 설계한다.

하지만 remediation 자동 patch 구현이 Behavioral MVP를 block하지는 않는다.

---

## 11. 권장 실제 PR 순서

```text
PR 1  baseline golden tests
PR 2  workspace scaffold
PR 3  release workflow migration
PR 4  adapter extraction
PR 5  QA IR contracts
PR 6  StudySpec compiler
PR 7  runtime state machine
PR 8  Playwright driver
PR 9  evidence store and sealing
PR 10 deterministic oracle
PR 11 single-session CLI/report
PR 12 persona policy
PR 13 attention/abandonment
PR 14 multi-session
PR 15 validity
PR 16 findings
PR 17 HTML report
PR 18 compare
PR 19 GitHub reporter
```

각 PR은 되도록 하나의 architecture boundary만 변경한다.

---

## 12. Definition of Done per issue

모든 issue에 포함:

- Problem
- Scope
- Non-goals
- Contract change
- Affected packages
- Security implications
- Acceptance Criteria
- Test plan
- Migration/compatibility
- Artifact example
- Rollback

---

## 13. 첫 4주 현실적 범위

### Week 1

- BR-01~BR-04
- compatibility와 workspace

### Week 2

- BR-05~BR-07
- QA IR / StudySpec / import

### Week 3

- BR-08~BR-10
- runtime / driver / evidence

### Week 4

- BR-11~BR-12
- oracle / browserless evaluation / simple report

4주 완료 시 persona보다 먼저 “증거가 남는 단일 사용자 runtime”이 있어야 한다.

다음 2~3주에 persona/validity를 붙인다.

---

## 14. MVP demo scenario

추천 fixture:

```text
baseline
업로드 완료 후 결과 CTA가 viewport 안에 있음

candidate
새 설명 영역 때문에 CTA가 fold 아래로 내려감
```

population:

- impatient_new_user
- careful_business_buyer
- low_domain_knowledge_user

결과:

- 기능 API는 모두 성공
- candidate에서 일부 persona가 CTA를 발견하지 못하고 abandon
- trace/screenshot/event evidence
- uncalibrated validity warning
- baseline/candidate relative report

이 demo 하나로 기능 QA와 Behavioral QA의 차이를 보여줄 수 있다.

---

## 15. Go/No-Go gates

### Go to Persona phase

- evidence seal 안정
- hidden element 차단
- oracle deterministic
- browserless judge
- single-session fixture repeatable

### Go to GitHub blocking

- false positive history 측정
- infra failure 분리
- report idempotent
- high finding repeated/stable
- manual override
- cost budget

### Go to remediation patch

- code location provenance
- pinned revision
- independent review
- isolated worktree
- deterministic verification
- expectation integrity
- human approval
