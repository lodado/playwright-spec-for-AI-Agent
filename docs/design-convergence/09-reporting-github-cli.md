# 09. 리포팅, GitHub PR, CLI 오케스트레이션 구현 계획

## 목표

검증된 design convergence 실행 결과를 JSON, 정적 HTML, GitHub Markdown으로 출력하고, accepted patch만 draft PR로 게시하는 CLI 흐름을 완성한다.

핵심 불변식:

> 리포트와 PR은 증거를 요약할 뿐이며, 남은 mismatch를 숨기거나 완전 정합을 주장하지 않는다.

## 선행 조건

- 08 단계에서 `PatchVerificationResult`와 final suite metrics가 artifact로 저장된다.
- accepted patch는 diff hash와 기준 revision을 포함한다.
- rejected/inconclusive/infrastructure-failed 후보도 reason과 함께 저장된다.
- config hash, Figma identifiers, browser version, case IDs가 run metadata에 있다.

## 생성/수정 예정 파일

필요해질 때만 생성한다.

```text
packages/design-convergence-report/
  package.json
  src/index.ts
  src/report-schema.ts
  src/render-json.ts
  src/render-html.ts
  src/render-markdown.ts
  src/redaction.ts
  src/escaping.ts
  test/render-json.test.ts
  test/render-html.test.ts
  test/render-markdown.test.ts
  fixtures/report-input.json

packages/design-convergence-github/
  package.json
  src/index.ts
  src/pr-body.ts
  src/git.ts
  src/github-cli.ts
  src/safety.ts
  test/pr-body.test.ts
  test/git.test.ts
  test/github-cli.test.ts

apps/design-convergence/
  src/cli.ts
  src/commands/init.ts
  src/commands/extract-figma.ts
  src/commands/index-source.ts
  src/commands/bind.ts
  src/commands/validate-bindings.ts
  src/commands/run.ts
  src/commands/diff.ts
  src/commands/fix.ts
  src/commands/verify.ts
  src/commands/report.ts
  src/commands/converge.ts
  src/commands/pr.ts
  test/cli.test.ts
  test/converge.test.ts
```

수정 후보:

```text
package.json
pnpm-workspace.yaml
README.md
```

README 수정은 10 단계 release hardening에서 최종 반영한다.

## 작은 체크박스 작업

### 1. 리포트 입력 스키마

- [ ] `DesignConvergenceReportInput` Zod 스키마를 추가한다.
- [ ] run metadata, exact git commit, config hash, browser version을 필수로 한다.
- [ ] Figma file key와 node id는 포함하되 access token은 절대 포함하지 않는다.
- [ ] case별 binding status, before/after metrics, diffs, source attribution을 포함한다.
- [ ] accepted/rejected patches와 infrastructure failures를 분리한다.
- [ ] screenshots는 secondary evidence link로만 포함하고 comparison verdict의 입력으로 다시 사용하지 않는다.

### 2. JSON 리포트

- [ ] machine-readable JSON은 schemaVersion을 포함한다.
- [ ] artifact path는 run directory relative path로 저장한다.
- [ ] absolute private path와 secret pattern을 redaction한다.
- [ ] 남은 high/critical diff 수를 명시한다.
- [ ] render 직전 input artifact hash/schema를 다시 검증하고 tamper mismatch를 `report-generation` failure로 중단한다.

### 3. 정적 HTML 리포트

- [ ] QA Native reporter-html처럼 text escaping을 기본으로 한다.
- [ ] client-side JavaScript 없이 정적 HTML로 시작한다.
- [ ] CSP meta를 추가한다: `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'`.
- [ ] screenshot 링크는 relative artifact path만 허용한다.
- [ ] Figma/source/report section 링크를 안전한 anchor로 만든다.
- [ ] before/after metrics와 남은 mismatch를 같은 화면에 보여준다.
- [ ] case → binding/node → property diff/source/patch evidence로 이동 가능한 page/node section을 만든다.
- [ ] system light/dark theme, 320px layout, keyboard-visible focus, semantic headings/table alternatives, AA contrast를 fixture screenshot/manual audit로 확인한다.
- [ ] 필수 animation은 두지 않고 향후 motion이 생기면 transform/opacity와 `prefers-reduced-motion`만 사용한다.

### 4. GitHub Markdown 요약

- [ ] PR body는 marker comment와 summary section을 포함한다.
- [ ] default title은 `fix(ui): align implementation with Figma design`이고 config override도 bounded single-line text만 허용한다.
- [ ] accepted changes와 verification result를 bullet list로 렌더링한다.
- [ ] rejected patches와 remaining mismatches를 별도 section에 남긴다.
- [ ] user mention, HTML comment injection, image embed, query string URL을 sanitize한다.
- [ ] “fully correct” 같은 과장 표현을 생성하지 않는다.
- [ ] cases evaluated, validated bindings, accepted groups, before/after fidelity, remaining critical/high, type/lint/test/full-suite 결과와 report evidence 위치를 포함한다.

### 5. CLI command rollout

- [ ] `init`은 starter config, case setup, `.gitignore` entry, env 안내만 생성하고 기존 파일을 덮어쓰지 않는다.
- [ ] `extract-figma`는 Figma raw/normalized/candidate artifact를 생성한다.
- [ ] `index-source`는 React component index 통계를 출력한다.
- [ ] `bind`는 AI proposal과 static validation 결과를 저장한다.
- [ ] `validate-bindings`는 instrumented app으로 runtime validation을 수행한다.
- [ ] `run`은 render/style extraction과 raw diff를 생성한다.
- [ ] `diff`는 저장된 figma/browser normalized artifact에서 deterministic diff를 재계산한다.
- [ ] `fix`는 patch proposal, policy validation, isolated application, candidate별 affected/full-suite evaluation과 accept/reject까지 수행한다.
- [ ] `verify`는 기존 candidate, clean committed manual revision, 또는 `fix`가 만든 최종 accepted branch를 AI 없이 같은 deterministic gate로 재검증한다.
- [ ] `report`는 JSON/HTML/Markdown을 생성한다.
- [ ] `converge`는 필요한 단계만 순서대로 실행하고 중간 실패를 provenance와 함께 멈춘다.
- [ ] `pr`은 accepted changes가 있을 때만 draft PR을 만든다.
- [ ] `converge --create-pr`은 report gate까지 성공한 뒤 `pr`을 호출하며 draft가 default다.
- [ ] 모든 command는 human/JSON/verbose/quiet logging과 공통 exit-code 정책을 유지한다.

### 6. converge orchestration

- [ ] `bind if required → validate → run → diff → fix → verify → report` 순서를 구현한다.
- [ ] `--max-iterations`의 default는 `1`이다. 후보마다 full-suite rerun이 O(candidates × suite)이므로 무제한 자동 수렴을 기본값으로 두지 않는다. 더 많은 반복은 명시 opt-in으로만 허용한다.
- [ ] binding이 없으면 명시적으로 provider가 설정된 경우에만 AI binding을 시도하고, 그렇지 않으면 review-required로 중단한다.
- [ ] `--case`는 case subset을 제한하지만 final accept 전 full suite를 요구한다.
- [ ] 각 stage는 idempotent artifact를 읽고 재시작 가능해야 한다.
- [ ] `fix`의 candidate별 검증 후 `verify`는 누적 accepted state에 대한 final-suite release gate이며 중복 판정 결과도 같은 hashes로 연결한다.
- [ ] infrastructure failure가 발생하면 patching/PR 단계로 넘어가지 않는다.

### 7. Draft-only GitHub PR

- [ ] PR 전 accepted patch가 하나 이상 있는지 확인한다.
- [ ] final suite 완료와 unresolved critical regression 0개를 확인한다.
- [ ] accepted diff hash가 검증 artifact와 일치하는지 확인한다.
- [ ] Phase 08의 accepted-only local branch, commit chain, final diff hash가 그대로인지 확인한다.
- [ ] generated branch name은 `design-convergence/<run-id>` pattern과 길이 제한을 통과해야 한다.
- [ ] Git remote의 exact owner/repository/base branch를 검증한 뒤 dedicated branch만 명시적 argv로 push한다. default/protected branch refspec은 거부한다.
- [ ] merge, auto-merge, non-draft PR 생성을 지원하지 않는다.
- [ ] `gh pr create --draft`는 bounded argv와 sanitized body file로 호출한다.
- [ ] Git/GitHub child process에는 필요한 최소 env만 전달하고 token을 URL, argv, log, body에 넣지 않는다.
- [ ] commit은 accepted changes만 포함하고 temporary artifacts는 기본적으로 포함하지 않는다.
- [ ] raw Figma payload, source excerpt, screenshot, rejected model output은 PR body/commit에 기본 첨부하지 않고 명시적으로 게시된 safe report link만 사용한다.

## 테스트 우선 절차

1. HTML escaping fixture로 script injection이 text로 렌더링되는지 검증한다.
2. HTML report를 320px/light/dark에서 열어 overflow, focus, contrast 기본을 확인하는 작은 Playwright smoke를 둔다.
3. Markdown sanitizer fixture로 mention, HTML comment, unsafe image embed가 제거되는지 검증한다.
4. report schema fixture로 accepted/rejected/infrastructure sections가 모두 유지되는지 검증한다.
5. CLI parser test에서 모든 command help와 required option error를 검증한다.
6. converge orchestration fake stages로 순서와 stop condition을 검증한다.
7. GitHub CLI fake spawn으로 draft-only, no merge, no default push를 검증한다.
8. accepted-only commit test로 rejected candidate 파일이 commit되지 않는지 검증한다.

## 실제 검증 명령

구현 PR에서 실행한다.

```bash
pnpm --filter @design-convergence/report test
pnpm --filter @design-convergence/report typecheck
pnpm --filter @design-convergence/github test
pnpm --filter @design-convergence/github typecheck
pnpm --filter design-convergence test
pnpm design-convergence report --run-dir ".design-convergence/artifacts/$RUN_ID"
pnpm design-convergence converge --case pricing-desktop --provider mock
pnpm design-convergence pr --help
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

현재 문서 단계에서는 위 패키지와 CLI가 아직 없으므로 명령을 실행하지 않는다.

CI는 fake Git/GitHub transport만 사용한다. 실제 draft PR smoke는 별도 disposable repository와 명시적 credential이 있는 opt-in job에서만 수행한다.

## 종료 게이트

- JSON, HTML, Markdown report가 같은 canonical report input에서 생성된다.
- HTML/Markdown escaping과 redaction 테스트가 통과한다.
- CLI command가 모두 help와 error path 테스트를 가진다.
- `converge`가 stage별 artifact를 남기고 실패 provenance를 유지한다.
- GitHub PR은 draft-only이며 accepted changes만 commit한다.
- report와 PR body가 remaining mismatches를 숨기지 않는다.

## 다음 단계 진입 게이트

10 단계로 진입하려면 다음이 필요하다.

- report artifacts가 example app integration run에서 생성된다.
- CLI smoke가 root script에 연결될 준비가 되어 있다.
- GitHub PR path는 fake transport 테스트로 안전성이 검증되어 있다.
- public README에 쓸 실제 command와 output이 구현되어 있다.

## 의도적 보류

- SARIF-like format은 v0.1 이후로 보류한다.
- interactive report viewer app은 정적 HTML이 한계에 도달할 때까지 보류한다.
- GitHub Checks API 직접 연동은 `gh` 기반 draft PR보다 늦게 추가한다.
- PR 자동 merge, protected branch push, non-draft PR은 지원하지 않는다.
