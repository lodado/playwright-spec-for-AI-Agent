# QA Native one-shot operator runbook

This runbook covers the operator prerequisites for running the dashboard QA Native
spec end to end (`execute → judge → report`) with the Hermes adaptive provider.
The multi-scenario execution, read-after-click network policy, and run-envelope
changes are already in the codebase; the steps below are the operator-only setup
that code cannot do for you (credentials, keys, external CLI compatibility).

Never place secrets, cookies, tokens, or query strings in source, argv, QA
artifacts, or reports. Every check below emits no secrets.

**Release gate:** one manual pass of this runbook — both tracks of §5 — is
required before every `minor` or larger release of `playwright-spec-for-ai-agent`
(see AGENTS.md §4). The vitest suite covers the protocol against fixtures; this
runbook is the only check against a real staging environment, real Hermes CLI,
and real credentials.

The strict track must pass **three consecutive runs without any debug or trace
flags** (`DEBUG`, `QA_NATIVE_TRACE_TIMING` unset). Logging changes the event
scheduling enough to mask timing races — a green run with logging enabled is
not evidence of a green run.

## 1. Hermes Agent CLI compatibility

QA Native calls Hermes through the legacy `--query`/`--max_turns` contract. Install
the Hermes Agent version whose CLI documents those flags, then verify:

```bash
node apps/playwright-spec-for-ai-agent/scripts/hermes-runner-smoke.mjs
```

It must print `PASS: hermes-agent protocol + inference credential OK`. The probe
inspects the real CLI surface (`hermes-agent --help`), so a symlink or shell alias
is not a fix — if the installed CLI does not speak `--query`/`--max_turns`, the
run fails fast with that message instead of producing empty output. If you cannot
install a compatible version, update `scripts/hermes-runner.mjs` to the new CLI's
documented non-interactive JSON interface.

## 2. Inference credential

Restore the inference provider credential via your secret manager or the Hermes
auth flow into `~/.hermes` on the operator machine only. A rejected credential
surfaces as a redacted `Hermes API key was rejected or permission denied.` error.
Confirm with the same smoke script from step 1 — it makes exactly one
one-action, text-only request and prints no secrets.

Set `HERMES_INFERENCE_MODEL` / `HERMES_INFERENCE_BASE_URL` (or the equivalent
`~/.hermes/config.yaml`) in the operator environment only.

## 3. Integrity and publication keys

Store both keys as canonical base64, 32 bytes or longer, in CI or your secret
manager:

- `QA_NATIVE_INTEGRITY_KEY` — seals and authenticates each run's evidence and
  envelope. A local ad-hoc `execute → judge → report` may use a session-generated
  key.
- `QA_NATIVE_PUBLICATION_KEY` — required before any publication. Never publish a
  run without a stable publication key.

Keys, cookies, tokens, and query strings never belong in artifacts or reports.

## 4. Login (shared storage state)

The login is a Playwright `storageState` JSON file — the authenticated session
(cookies + localStorage) that Playwright records after you sign in. Generate it
once (for example with `playwright ... --save-storage`) and drop it at the shared
default path so every run in this project reuses it without a flag:

```
.private/storage-state.json   # must be a private file: chmod 600
```

`execute` auto-discovers `.private/storage-state.json` when `--storage-state` is
omitted. Requirements:

- The file must be owner-only private (`chmod 600`); a world- or group-readable
  file is rejected with `storage state must be private`.
- `.private/` is gitignored, so the session is never committed.
- If the file is absent, the run proceeds unauthenticated (the previous default).
- An explicit `--storage-state=<path>` always overrides the shared default; the
  path must be a private regular file inside the project (no absolute paths, no
  symlinks).

To refresh the login, overwrite `.private/storage-state.json` (keep it `600`).

## 5. One-shot sequence

Run both tracks. The strict track exercises compilation, planning, and the
deterministic executor without a model; the adaptive track exercises the Hermes
proposer, the browser-tool gateway, and the evidence validator.

**Strict track** (no Hermes required):

```bash
pnpm exec qa-native execute \
  --spec=src/page/dashboard/__tests__/dashboard.qa-native.ts \
  --base-url="$STAGING_QA_BASE_URL" \
  --run-dir=".qa/runs/one-shot-strict-$(date +%Y%m%d-%H%M%S)"
```

Expect the `qa-native: playwright/strict executed N scenario(s)` summary and a
sealed run directory.

**Adaptive track** (steps 1–4 required) — the sequence below.

The base URL must include the locale segment. `@qa-page: dashboard` resolves
relative to the base URL, so `https://agent-dev.koreadeep.com/ko/` yields
`/ko/dashboard`; a host root would wrongly yield `/dashboard`.

```bash
export STAGING_QA_BASE_URL='https://agent-dev.koreadeep.com/ko/'
export QA_NATIVE_RUN_DIR=".qa/runs/one-shot-dashboard-$(date +%Y%m%d-%H%M%S)"

# Login picked up automatically from .private/storage-state.json.
pnpm exec qa-native execute \
  --spec=src/page/dashboard/__tests__/dashboard.qa-native.ts \
  --base-url="$STAGING_QA_BASE_URL" \
  --run-dir="$QA_NATIVE_RUN_DIR" \
  --provider=hermes \
  --mode=adaptive
pnpm exec qa-native judge --run-dir="$QA_NATIVE_RUN_DIR"
pnpm exec qa-native report \
  --run-dir="$QA_NATIVE_RUN_DIR" \
  --repository-root=. \
  --revision=HEAD
```

`execute` now runs every declared scenario of the spec sequentially into one
sealed manifest (`execution-agent-inputs.json` / `execution-agent-outcomes.json`
are JSON arrays; the run envelope is `run-envelope/0.2`). An incomplete run is
never kept as success evidence: setup failures delete the directory, while an
adaptive run whose sealed evidence fails validation is preserved as
`<run-dir>.invalid` for debugging — every command refuses to read it, and
`qa-native: invalid run evidence preserved at …` appears on stderr.

The strict and adaptive browser policy allows same-origin `GET`/`HEAD` after a
safe interaction (for example a subscription-history dialog that fetches on
click) and records each allowed request's method, origin, and path in the action
evidence. `POST`/`PUT`/`PATCH`/`DELETE`, cross-origin requests, form submits,
navigation to another origin, uploads, and destructive confirmations remain
blocked.

## 6. Verdict handling

`MANUAL_REVIEW` is a valid terminal state — never coerce it to `PASS` or `FAIL`.
Proceed to remediation or publication only after reviewing the evidence,
judgment, and report, and only for a `FAIL` or `MANUAL_REVIEW` verdict whose
verification succeeded.
