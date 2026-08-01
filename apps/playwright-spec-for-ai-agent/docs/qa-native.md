# QA Native

QA Native is the evidence-driven runtime shipped with `playwright-spec-for-ai-agent`. It compiles annotated Playwright intent, runs a bounded browser session, seals the evidence, judges it later without a browser, and can prepare reviewable remediation artifacts.

> QA Native currently supports macOS and Linux. Windows is not supported because private run artifacts rely on POSIX file and directory modes.

## Prerequisites

```bash
npm install -D playwright-spec-for-ai-agent @playwright/test
npx playwright install chromium
```

Generate and store a stable integrity key for authenticated run artifacts:

```bash
export QA_NATIVE_INTEGRITY_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"
```

## Execute, judge, and review

```bash
npx qa-native execute \
  --spec=tests/e2e/dashboard.spec.ts \
  --base-url=https://staging.example.com \
  --run-dir=.qa/runs/dashboard-1

npx qa-native judge --run-dir=.qa/runs/dashboard-1
npx qa-native review --run-dir=.qa/runs/dashboard-1
```

After re-running `judge`, choose the completed set explicitly with
`--judgment=judgments/<set-dir>` on both `review` and `report`; a single result
JSON remains accepted for commands that intentionally target one judgment.

`execute` first performs one read-only applicability observation for approved abstract/adaptive specs. High-confidence conflicting scenarios are recorded as `NOT_APPLICABLE`; ambiguous or failed selection falls back to legacy execution. It then writes an authenticated evidence archive. `judge` runs deterministic checks first and sends only unresolved semantic expectations to Hermes in text-only mode. An entirely inapplicable executed scenario is `SKIP`, not `MANUAL_REVIEW`. `review` uses a fresh text-only invocation to reject judgments that are not grounded in their cited sealed evidence; AI-native reports require every review to be approved. Hermes adaptive runs allow only page-initiated `GET`/`HEAD` requests to origins explicitly listed in the capability lease, close WebSockets, and block mutations. Strict runs allow page-initiated read-only (GET/HEAD) requests within the target's registrable domain — sibling API origins like `api.example.com` work — and block every mutation and foreign-site request. Direct browser navigation remains limited to the configured target origin.

## AI-first full-spec abstraction

```bash
npx qa-native abstract-ai --page=dashboard
npx qa-native execute --page=dashboard --run-dir=.qa/runs/dashboard-1
```

`abstract-ai` resolves the same config-selected specs as `execute`, asks one
text-only model to extract every test as explicit Given (initial observable
conditions), When (authored flow), and Then (observable claims), plus its live
classification, then asks a fresh model invocation to review
the candidate against the complete source and immutable manifest. It permits up to three reviewed revisions.
Results are cached as owner-only JSON in `.qa/abstract/cache/` with Markdown
views in `.qa/abstract/<page>/`;
unchanged source and provider prompt/model versions make no model calls.

Each extraction and independent-review batch contains at most eight tests. A
timeout, invalid response envelope, or validation failure reduces only that
failed batch until it succeeds or a single-test batch fails; successful batches
are not repeated. A retryable single-test failure gets one final retry before
the spec fails closed.

Approved Given descriptions are compiled as applicability conditions and evaluated against one bounded live-page
ARIA observation before per-scenario execution. The selector cannot grant
policy or actions and receives no titles, claims, destination URLs, dialogs,
toasts, or other post-action state. Only conditions that must already hold
before the authored flow and can be established by read-only observation may
form a conflict. Future mock responses and fixture identities stay in When or
Then. Hidden API setup also stays out of Given when the rendered Then claim
directly establishes the relevant product state. Given never presupposes the
subject evaluated by Then, so a missing target remains judgeable. Only a complete
`NOT_APPLICABLE` decision with confidence at
least `0.8` skips execution; low-confidence, malformed, missing, or failed
selection remains `AMBIGUOUS` and executes for backward-compatible coverage.

Hermes/adaptive execution defaults to `--compiler=abstract` for both `--page`
and `--spec`. Use `--compiler=ast` only as the compatibility fallback. AI output never supplies policy,
capabilities, selectors, actions, or verdicts. Only the code-owned static manifest's
nearest test or enclosing-suite `@qa-live-policy` grants live authority; missing or
unknown authority is blocked. `MOCK_ONLY` and `AMBIGUOUS` tests never become live PASS/FAIL scenarios.

## Adaptive execution

```bash
npx qa-native execute \
  --spec=tests/e2e/dashboard.spec.ts \
  --base-url=https://staging.example.com \
  --run-dir=.qa/runs/dashboard-1 \
  --provider=hermes --mode=adaptive
```

### `@qa-live-policy` values

The spec annotation is the only source of policy truth. Each test carries its own value:

| Annotation                                   | Compiled policy                   | Adaptive meaning                                                                                      |
| -------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `readonly`                                   | `executable-readonly`             | DOM-only observation; no clicks or typing.                                                            |
| `safe-interaction`                           | `executable-interaction`          | Safe clicks and non-secret typing allowed.                                                            |
| `safe-interaction-no-confirm`                | `judgment-interaction-no-confirm` | Interaction allowed, but verdicts come from semantic judgment (verifying on live would be dangerous). |
| `mock-judgment`                              | `judgment-mock-api`               | Playwright mocks are skipped; the judge rules on live-DOM evidence semantically.                      |
| `subscription-mutation`, `auth-mock`, `skip` | `blocked-*`                       | Statically blocked; skipped under `--allow-partial`, otherwise the file fails closed.                 |

Scenarios whose policy starts with `judgment-` are recorded in
`extensions.semanticJudgmentScenarioIds` and complete through an observe-only evidence milestone
instead of per-expectation checks.

### Budgets

Each scenario gets an independent budget. Defaults: 32 actions, 32 turns, 300000 ms, 100000
tokens. Override per run with `--budget-actions`, `--budget-turns`, `--budget-time-ms`,
`--budget-tokens` (positive integers). A scenario that exhausts its budget seals the evidence it
gathered and ends as `ERROR` with a `BUDGET_EXHAUSTED: …` reason; the run itself still exits 0 and
reports the scenario on stderr.

The execution prompt forbids unchanged observation loops: an affirmed
applicability conflict or a still-absent authored target after one safe recovery
must become an evidence-backed `report_blocked` claim instead of consuming the
remaining budget.

### `report_blocked` is a claim, not a verdict

The execution agent may end a milestone with `report_blocked` plus a reason. That reason is only
the agent's claim: the gateway seals the full visible page alongside it, and the judge rules on
that sealed evidence later. Nothing the agent writes can become a verdict directly.

### Quarantined runs (`<run-dir>.invalid`)

If the sealed evidence fails integrity validation after an adaptive run, the run directory is not
deleted — it is renamed to `<run-dir>.invalid` with the evidence archive inside, and
`qa-native: invalid run evidence preserved at …` is printed to stderr. Every qa-native
command refuses to read `.invalid` paths, so a rejected run can never become a verdict or a
report. Inspect it manually, then delete it when you are done debugging.

## Authenticated pages

Prefer a Playwright `storageState` file created outside QA Native. It is passed only to the browser context and is never copied into the run directory, evidence archive, or run envelope.
The file must remain inside the workspace and be owner-only (`chmod 600 .private/enterprise-session.json`).

```bash
npx qa-native execute \
  --spec=tests/e2e/dashboard.spec.ts \
  --base-url=https://staging.example.com \
  --storage-state=.private/enterprise-session.json \
  --run-dir=.qa/runs/dashboard-1
```

For an automatic SSO or session-refresh page, add an opt-in bootstrap file instead of weakening normal runtime policy:

```json
{
  "url": "https://staging.example.com/login",
  "allowedOrigins": ["https://login.example-idp.com"],
  "allowedEndpoints": [
    {
      "origin": "https://staging.example.com",
      "path": "/api/auth/session",
      "methods": ["POST"]
    }
  ]
}
```

Pass it with `--auth-bootstrap=.private/auth-bootstrap.json`. During bootstrap, only `GET`/`HEAD` requests to the listed origins and the exact non-GET endpoints above are allowed. Once its page finishes loading, page-initiated API traffic is unrestricted. Do not put credentials, cookies, tokens, or query strings in this file.

## Create a repository-aware report

```bash
npx qa-native report \
  --run-dir=.qa/runs/dashboard-1 \
  --repository-root=. \
  --revision=HEAD
```

The report pins `HEAD` to an exact commit before locating likely files and line ranges.

## Propose and verify a patch

```bash
npx qa-native propose-patch \
  --run-dir=.qa/runs/dashboard-1 \
  --repository-root=. \
  --revision=HEAD

npx qa-native verify-patch \
  --run-dir=.qa/runs/dashboard-1 \
  --repository-root=. \
  --revision=HEAD
```

Proposal generation never edits the caller's workspace. Verification applies the saved proposal only in a private worktree and runs trusted `format`, `lint`, `typecheck`, `unit`, and `playwright` commands configured under `remediation.verification.checks`.

Missing, failed, timed-out, output-limited, patch-mutating, or network-dependent checks never become an implicit pass.

## Publish an Issue or Draft PR

Create and store a stable publication key:

```bash
export QA_NATIVE_PUBLICATION_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"
```

Run or resume the complete remediation state machine:

```bash
npx qa-native remediate \
  --run-dir=.qa/runs/dashboard-1 \
  --repository-root=. \
  --repository=owner/repository \
  --publish=auto

npx qa-native publish \
  --run-dir=.qa/runs/dashboard-1 \
  --repository-root=. \
  --repository=owner/repository \
  --publish=auto
```

Only an eligible patch that passes deterministic verification, improves the authenticated scenario, preserves expectation strength, and receives independent review can become a Draft PR. Unsafe or inconclusive cases fall back to an evidence-backed Issue or manual review. QA Native has no merge or auto-merge path.

## Artifact layout

```text
.qa/runs/<run-id>/
├── execution/
├── evidence/
├── judgments/
├── reviews/
├── reports/
└── remediation/<proposal-id>/
```

Keep `.qa/` private. It may contain screenshots, traces, paths, and staging evidence even though secrets and unsafe publication payloads are filtered.
