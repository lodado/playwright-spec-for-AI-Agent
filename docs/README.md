# Persona Runtime / Behavioral QA Runtime 구현 플랜

> 대상 저장소: `lodado/playwright-spec-for-AI-Agent`  
> 기준 버전: `v0.9.0`  
> 기준 커밋: `b95a72ba29253e37e9567e6d57e8a6c6c60d592a`  
> 작성 기준일: `2026-07-26`

## 최종 결정

이 프로젝트는 새 GitHub 저장소로 분리하지 않는다.

기존 저장소를 상위 모노레포로 확장하되, 현재 배포 중인
`playwright-spec-for-ai-agent` 패키지와 CLI는 하위 호환 패키지로 보존한다.
새 Behavioral Runtime은 기존 Hermes Judge에 기능을 계속 덧붙이는 방식이 아니라,
독립된 코어 패키지로 구현한다.

```text
기존 자산
Playwright spec → QA intent → Hermes live judgment
                         │
                         └─ Playwright Spec Adapter로 추출

새 코어
StudySpec
→ Browser Runtime
→ Evidence Bundle
→ Persona Policy
→ Functional / Behavioral Evaluation
→ Simulation Validity
→ Variant Regression
→ GitHub Report
```

한 문장으로 정리하면 다음과 같다.

> 기존 레포의 히스토리, npm 패키지, Playwright 의도 추출 자산은 유지하고,
> 새 제품의 실행 코어는 별도 모듈로 새로 만든다.

## 제품 정의

오픈소스 런타임의 작업명은 `Persona Runtime`, 제품 카테고리는
`Behavioral Release Intelligence`로 사용한다.

핵심 문구:

> Behavioral regression testing for every product release.

이 제품은 실제 사용자의 전환율이나 선호도를 예언하는 도구가 아니다.
여러 행동 정책을 가진 AI 사용자가 실제 브라우저에서 과업을 수행하게 하고,
어디에서 막히고, 뒤로 가고, 오해하고, 이탈하는지 재현 가능한 증거로 찾는다.

또한 AI 사용자의 결과를 맹신하지 않도록 다음을 함께 표시한다.

- 실제 사용자 데이터 교정 여부
- 페르소나 사이 행동 다양성
- seed와 model에 따른 안정성
- 과잉 행동 및 과잉 협조 위험
- A/B 평가 순서 일관성
- 사람 검증이 필요한 범위

## 문서 읽는 순서

| 순서 | 문서 | 목적 |
|---:|---|---|
| 1 | `00_DECISION_AND_SCOPE.md` | 제품 경계와 최종 기술 결정을 확정한다. |
| 2 | `01_CURRENT_REPO_AUDIT.md` | 현재 저장소에서 가져갈 것과 버릴 것을 구분한다. |
| 3 | `02_TARGET_ARCHITECTURE.md` | 목표 모듈, 책임, 의존성 방향을 이해한다. |
| 4 | `03_MONOREPO_MIGRATION_PLAN.md` | 기존 npm/CLI를 깨지 않고 모노레포로 이동한다. |
| 5 | `04_PLAYWRIGHT_SPEC_ADAPTER.md` | 기존 parser를 canonical StudySpec 입력 어댑터로 만든다. |
| 6 | `05_STUDY_SPEC_AND_CONTRACTS.md` | 모든 런타임 경계를 versioned JSON 계약으로 정의한다. |
| 7 | `06_BROWSER_RUNTIME_AND_EVIDENCE.md` | 직접 Playwright 런타임과 immutable evidence를 구현한다. |
| 8 | `07_PERSONA_POLICY_AND_SIMULATION_VALIDITY.md` | 행동 정책과 synthetic 결과 신뢰도 검사를 구현한다. |
| 9 | `08_EVALUATION_FINDINGS_AND_REPORTS.md` | 판정, finding, severity, confidence, 리포트를 구현한다. |
| 10 | `09_VARIANT_COMPARISON_AND_GITHUB.md` | baseline/candidate 비교와 PR Check를 구현한다. |
| 11 | `10_TESTING_SECURITY_OBSERVABILITY.md` | 테스트, 보안, 비용, 관측성을 고정한다. |
| 12 | `11_ROADMAP_AND_ISSUE_BACKLOG.md` | 실제 PR 순서와 GitHub issue 단위로 쪼갠다. |
| 13 | `12_MASTER_IMPLEMENTATION_PROMPT.md` | Codex·Claude Code 등에 넣을 실행 프롬프트다. |
| 14 | `13_RESEARCH_HYPOTHESES_AND_REFERENCES.md` | 논문 가설과 설계 요구사항의 연결을 기록한다. |

## 권장 실행 방식

한 번에 전체 시스템을 구현하지 않는다. 각 단계는 독립적으로 merge 가능해야 하며,
기존 CLI의 golden test가 항상 통과해야 한다.

```text
Phase A — 보존과 추출
v0.9.0 동작 고정
→ 모노레포 scaffold
→ Playwright parser/abstractor adapter 추출

Phase B — 새 코어
StudySpec
→ Browser Runtime
→ Evidence Bundle
→ deterministic oracle
→ browserless judge

Phase C — Behavioral Layer
Persona Policy
→ multi-session
→ Simulation Validity
→ HTML report

Phase D — Release Integration
baseline/candidate
→ GitHub PR report
→ release warning

Phase E — Calibration / Remediation
PostHog 등 실제 행동 교정
→ 기존 remediation #13~#23 파이프라인과 연결
```

## 완료 정의

첫 번째 공개 가능한 Behavioral MVP는 다음 흐름이 동작할 때 완료다.

```bash
persona-runtime run ./examples/hidden-cta/study.yaml
```

결과:

1. 세 개 이상의 행동 페르소나가 독립 BrowserContext에서 실행된다.
2. 각 행동 전후 screenshot, semantic observation, trace, console/network evidence가 저장된다.
3. deterministic oracle이 기능 성공/실패를 먼저 판정한다.
4. AI evaluator는 브라우저를 종료한 뒤 evidence만 읽는다.
5. `success / partial / failure / abandoned / runtime_error`가 구분된다.
6. 반복 finding이 event/evidence와 연결된다.
7. 행동 다양성·과잉 행동·교정 상태가 함께 표시된다.
8. 정적 HTML과 JSON report가 생성된다.
9. 기존 `playwright-spec-for-ai-agent` 명령은 그대로 동작한다.
