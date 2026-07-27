# QA Native

QA Native is the evidence-driven runtime shipped with `playwright-spec-for-ai-agent`. It compiles annotated Playwright intent, runs a bounded read-only browser session, seals the evidence, judges it later without a browser, and can prepare reviewable remediation artifacts.

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

## Execute and judge

```bash
npx qa-native execute \
  --spec=tests/e2e/dashboard.spec.ts \
  --base-url=https://staging.example.com \
  --run-dir=.qa/runs/dashboard-1

npx qa-native judge --run-dir=.qa/runs/dashboard-1
```

`execute` writes an authenticated evidence archive. `judge` runs deterministic checks first and sends only unresolved semantic expectations to Hermes in text-only mode.

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
├── reports/
└── remediation/<proposal-id>/
```

Keep `.qa/` private. It may contain screenshots, traces, paths, and staging evidence even though secrets and unsafe publication payloads are filtered.
