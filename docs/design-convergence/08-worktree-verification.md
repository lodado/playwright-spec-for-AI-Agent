# 08. 격리 worktree 검증 구현 계획

## 목표

AI가 제안한 패치를 사용자의 현재 working tree가 아닌 정확한 기준 commit의 disposable git worktree에 적용하고, deterministic score와 regression gate로 accepted/rejected를 판정한다.

핵심 불변식:

> 패치 후보는 적용·빌드·테스트·대상 case 재실행·전체 suite 재실행을 통과하고 의미 있는 개선을 보여야만 accept된다.

## 선행 조건

- 07 단계의 `PatchProposalOutput`과 policy validation이 완료되어 있다.
- diff metrics와 severity 계산은 deterministic engine에서 제공된다.
- app command, typecheck, lint, test, build, start-app 명령은 사용자 설정에서 온다.
- 명령 이름은 allowlist enum이고, 실제 argv는 설정에서 resolve한다.
- `verification.minimumImprovement`, global score allowance, required checks는 config에서 명시되며 보안상 필요한 check에 silent default를 만들지 않는다.

## 생성/수정 예정 파일

필요해질 때만 생성한다.

```text
packages/design-convergence-patching/
  src/worktree.ts
  src/apply-edits.ts
  src/path-safety.ts
  src/diff-integrity.ts
  src/command-runner.ts
  src/output-redaction.ts
  test/worktree.test.ts
  test/path-safety.test.ts
  test/diff-integrity.test.ts
  test/command-runner.test.ts

packages/design-convergence-verifier/
  package.json
  src/index.ts
  src/metrics.ts
  src/verification-policy.ts
  src/patch-verifier.ts
  src/result-schema.ts
  test/metrics.test.ts
  test/verification-policy.test.ts
  test/patch-verifier.test.ts
  fixtures/accepted-button.json
  fixtures/rejected-regression.json
  fixtures/infrastructure-failed.json
```

수정 후보:

```text
packages/design-convergence-browser/src/index.ts
packages/design-convergence-comparison/src/index.ts
apps/design-convergence/src/commands/verify.ts
```

## 작은 체크박스 작업

### 1. 기준 commit 고정

- [ ] `git rev-parse --verify HEAD`로 기준 commit을 저장한다.
- [ ] v0.1은 working tree/index가 dirty이면 중단한다. stash/reset/clean 또는 dirty-state 우회 옵션을 만들지 않는다.
- [ ] worktree는 `.design-convergence/worktrees/<candidate-id>` 아래에 만든다.
- [ ] worktree 생성 후 `git rev-parse HEAD`가 기준 commit과 같은지 확인한다.
- [ ] worktree 제거 실패는 warning artifact로 남기고 검증 결과와 분리한다.
- [ ] 첫 후보는 exact clean base commit에서 시작하고, 이후 후보는 마지막 accepted commit에서 시작한다.
- [ ] accepted 후보만 전용 local branch에 commit해 다음 accepted state가 된다. rejected 후보 worktree는 폐기하며 사용자 branch/index/files는 끝까지 바꾸지 않는다.
- [ ] internal Git argv는 `rev-parse`, `status`, `worktree add/remove`, `diff`, accepted-branch `add/commit`으로 allowlist하고 reset/clean/rebase/default-branch mutation을 노출하지 않는다.
- [ ] AI 없이 수동 변경을 검증할 때는 clean committed `--revision <sha>`와 configured base revision의 diff를 같은 path/semantic policy에 통과시킨 뒤 candidate로 취급한다.

### 2. path와 symlink 안전성

- [ ] 모든 edit path는 root-relative POSIX path로 normalize한다.
- [ ] absolute path, `..`, null byte, Windows drive prefix를 거부한다.
- [ ] `lstat`로 symlink를 확인하고 기본적으로 따르지 않는다.
- [ ] realpath가 worktree root 밖이면 거부한다.
- [ ] 패치 적용 전후 파일 목록이 proposal의 edit 목록과 일치하는지 확인한다.

### 3. structured edit 적용

- [ ] structured edit는 `baseHash`가 현재 파일 hash와 일치할 때만 적용한다.
- [ ] 각 exact-text replacement의 target occurrence가 유일하게 해석되는지 확인하고 임시 파일 + atomic rename으로 쓴다.
- [ ] edit 적용 후 `git diff --no-ext-diff --no-renames`를 저장한다.
- [ ] diff가 예상 밖 파일, forbidden file, binary, rename, mode change, deletion을 포함하면 즉시 reject한다.
- [ ] diff hash를 `PatchApplicationResult`에 저장한다.

### 4. 안전한 command runner

- [ ] AI 출력에서 command를 읽지 않는다.
- [ ] 실행 가능한 command kind는 `format`, `type-check`, `lint`, `test`, `build`, `start-app`만 허용한다.
- [ ] `child_process.spawn(file, args, { shell: false })` 형태만 사용한다.
- [ ] 설정 argv는 문자열 배열로만 받는다.
- [ ] env는 allowlist와 explicit additions만 전달한다.
- [ ] stdout/stderr는 크기 제한 후 redaction해서 저장한다.
- [ ] timeout과 exit code를 구조화한다.
- [ ] timeout 시 전체 process tree를 종료하고 missing/timeout/truncated check를 PASS로 바꾸지 않는다.

### 5. 대상 우선 검증

- [ ] formatting을 먼저 실행하고 allowed file 범위 안의 결과만 받아들인 뒤 검증 대상 diff hash를 봉인한다.
- [ ] typecheck, lint, configured tests, configured build를 선언된 required order로 실행한다.
- [ ] 봉인 뒤 각 command 전후 status/diff를 비교하고 source를 추가 변경한 command가 있으면 reject한다.
- [ ] affected cases만 먼저 rerun한다.
- [ ] before/after target weighted score를 계산한다(보고용 지표).
- [ ] 개선 판정은 score delta가 아니라 **resolved diff record** 기준으로 한다: target cause group의 diff record가 최소 하나 해소되고(match로 전환), 새로운 diff record가 0이며, critical regression이 0일 때 "improved"다. 거의 완벽한 case의 마지막 low-severity 결함을 고치는 올바른 패치가 score delta 미미로 reject되는 것을 막기 위함이다.
- [ ] `minimumImprovement`는 "해소해야 하는 최소 diff record 수"로 정의하고 score 임계로 쓰지 않는다.
- [ ] acceptance 식은 patch applied, format/typecheck/lint/test pass, target의 diff record가 실제로 해소됨, 새 diff 0, critical regression 0을 모두 요구한다. global weighted score는 보고에만 쓰고 accept/reject의 독립 입력으로 쓰지 않는다.

### 6. 전체 suite regression 검증

- [ ] target 개선 후 full design suite를 rerun한다.
- [ ] 이전 passing case가 failing이면 reject한다.
- [ ] critical diff가 새로 생기면 reject한다.
- [ ] global weighted score가 허용치보다 증가하면 secondary guard로 reject한다(primary regression 신호는 record 기준: 이전 passing case의 failing 전환과 새 critical diff).
- [ ] binding validation 실패, mapped element disappearance는 reject한다.
- [ ] 모든 acceptance 계산은 저장된 before/after normalized values와 deterministic weights만 사용하며 AI 설명을 입력으로 받지 않는다.

### 7. 결과 분류

- [ ] `accepted`, `rejected`, `inconclusive`, `infrastructure-failed`를 구분한다.
- [ ] app startup, font loading, Playwright crash, Figma fetch failure는 product mismatch로 바꾸지 않는다.
- [ ] rejected patch와 infrastructure failure는 별도 artifact namespace에 저장한다.
- [ ] accepted state의 case artifact에는 `after.png`와 after normalized/diff/metrics를 연결하고 rejected candidate evidence는 candidate 하위에 보존한다.

## 테스트 우선 절차

1. path traversal, symlink escape, forbidden glob edit fixture를 먼저 만든다.
2. source hash mismatch fixture로 apply가 실패하는 테스트를 작성한다.
3. command runner가 `shell:false`와 allowlisted env만 쓰는지 fake spawn으로 검증한다.
4. 좋은 패치 fixture가 target score를 낮춰 accepted 되는 테스트를 작성한다.
5. target은 개선하지만 다른 case에 critical regression을 만드는 fixture를 rejected로 검증한다.
6. app startup 실패 fixture가 `infrastructure-failed`가 되는지 검증한다.
7. rejected patch artifact에 reason과 redacted bounded output이 남는지 검증한다.

## 실제 검증 명령

구현 PR에서 실행한다.

```bash
pnpm --filter @design-convergence/patching test
pnpm --filter @design-convergence/patching typecheck
pnpm --filter @design-convergence/verifier test
pnpm --filter @design-convergence/verifier typecheck
pnpm design-convergence verify --candidate "$FIXTURE_CANDIDATE_ID"
pnpm design-convergence verify --revision "$FIXTURE_COMMIT_SHA"
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

현재 문서 단계에서는 위 패키지와 CLI가 아직 없으므로 명령을 실행하지 않는다.

## 종료 게이트

- accepted fixture와 rejected regression fixture가 모두 통과한다.
- user working tree가 패치 후보 평가 중 변경되지 않는다.
- 모든 command output이 redaction과 크기 제한을 통과한다.
- `PatchVerificationResult`가 before/after metrics, checks, reasons를 포함한다.
- infrastructure failure가 design diff failure와 분리되어 보고된다.

## 다음 단계 진입 게이트

09 단계로 진입하려면 다음이 필요하다.

- accepted patch가 사용자 workspace가 아닌 전용 local branch의 commit으로 연결되고 exact handoff artifact가 있다.
- rejected/inconclusive/infrastructure-failed 후보가 report input에 포함된다.
- full suite 결과와 final metrics가 JSON으로 저장된다.
- GitHub PR 생성에 사용할 exact repository, branch base, revision, diff hash가 고정되어 있다.

## 의도적 보류

- Docker/VM 기반 완전 격리는 v0.1에서 보류한다. 따라서 project command 실행은 operator-approved repository 또는 외부 sandbox/별도 OS 사용자에서만 지원하며 임의 제3자 저장소의 host-safe 실행을 주장하지 않는다.
- 병렬 worktree 검증은 전역 lock으로 시작한다. 처리량 문제가 측정되면 candidate별 queue로 확장한다.
- flaky case 자동 재시도 정책은 기본 0회로 둔다. 안정화 지표가 쌓이면 제한적 retry를 추가한다.
- 패키지 설치나 dependency update는 자동 패치 범위에서 제외한다.
