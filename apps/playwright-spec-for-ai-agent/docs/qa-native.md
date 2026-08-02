# QA Native v3 operator guide

QA Native v3 executes one AI-native, evidence-bound pipeline:

```text
Playwright source
  → static authority
  → reviewed Given/When/Then behavior
  → initial-state applicability selection
  → policy-bounded Playwright runtime
  → sealed evidence
  → AI judgment
  → independent grounding review
  → Markdown report
```

## One-shot command

```bash
export QA_NATIVE_INTEGRITY_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"

npx qa-native run \
  --spec=tests/e2e/account.spec.ts \
  --base-url=https://staging.example.com \
  --run-dir=.qa/runs/account-1
```

Use `--page=<configured-name>` instead of `--spec` to select the specs, base URL,
and target path from project config. A run directory is exclusive and must be a
new path below `.qa/`.

## Stage debugging

`abstract`, `execute`, `judge`, `review`, and `report` are the same stages used
by `run`; they do not expose alternate implementations.

```bash
npx qa-native abstract --page=account
npx qa-native execute --page=account --run-dir=.qa/runs/account-1
npx qa-native judge --run-dir=.qa/runs/account-1
npx qa-native review --run-dir=.qa/runs/account-1
npx qa-native report --run-dir=.qa/runs/account-1
```

## Authority and behavior

The AST-backed static stage extracts only annotated identity, source range,
policy, and fixture declarations. Missing authority fails closed. It does not
interpret assertions or actions.

The extractor and independent reviewer produce exact test-ID coverage with
Given/When/Then. Their output cannot contain policy, permissions, actions,
selectors, fixture paths, executable code, or verdicts. An unchanged approved
artifact is reused from `.qa/abstract/cache/`.

Runtime then captures one bounded read-only URL/ARIA observation. A separate AI
call compares it only with extracted Given conditions; only explicit
`APPLICABLE` behaviors execute. `NOT_APPLICABLE` and `AMBIGUOUS` behaviors are
reported and skipped without becoming authority or verdicts.

## Browser policy

| Scenario capability | HTTP | WebSocket |
| --- | --- | --- |
| observe only | GET/HEAD on exact leased origins | blocked |
| interaction | every method on exact leased origins | allowed on exact leased origins |
| blocked | browser is not launched | blocked |

The execution agent sees When and Then, proposes one bounded action at a time,
and receives only opaque observed-element identities. It cannot name arbitrary
selectors. Uploads resolve only code-owned `@qa-fixture` entries inside the
project without following a symlink escape.

Default per-scenario budgets are 32 actions, 32 turns, 300000 ms, and 100000
tokens. Override them with `--budget-actions`, `--budget-turns`,
`--budget-time-ms`, and `--budget-tokens`.

## Evidence and quarantine

Evidence is redacted, bounded, hashed, and HMAC authenticated. Its signed
manifest binds `authority.json` and `behavior.json`, preventing artifact swaps.
Pending browser route decisions are drained before sealing.

After the browser starts, validation or sealing failure preserves the directory
as `<run>.invalid`. No QA Native command reads an `.invalid` run. Before browser
launch, failure removes the empty reservation when possible.

## Authentication

A Playwright storage state must stay inside the project and be owner-only:

```bash
chmod 600 .private/storage-state.json
npx qa-native run --spec=tests/e2e/account.spec.ts \
  --base-url=https://staging.example.com \
  --storage-state=.private/storage-state.json \
  --run-dir=.qa/runs/account-1
```

An optional private `--auth-bootstrap` JSON may authorize an initial login URL,
read origins, and exact mutation endpoints. After bootstrap, the active scenario
policy completely replaces that temporary authority.

## Results

`judge` always uses sealed evidence and an AI semantic decision. Code validates
contract coverage and every evidence citation; it does not substitute a
deterministic semantic verdict. `review` is a separate model call that checks the
judgment against the same bounded evidence projection. It returns `APPROVED` or
`MANUAL_REVIEW` and cannot change the verdict.

The final layout is:

```text
.qa/runs/<id>/
├── authority.json
├── behavior.json
├── evidence/
├── judgment.json
├── review.json
└── report.md
```

Keep `.qa/` private even though redaction is enforced; screenshots and traces may
still contain sensitive business context.
