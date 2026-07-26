# Persona Runtime MVP implementation

Implemented on `agent/persona-runtime` as PR-sized commits covering M0–M11:

- pnpm/Turbo workspace with the published legacy package preserved
- Playwright QA intent adapter and versioned contracts
- isolated direct-Playwright sessions, seeded policies, and sealed evidence
- deterministic/browserless evaluation, validity, findings, and HTML reporting
- paired variant comparison and idempotent GitHub reporting
- `validate`, `import-playwright`, `run`, and `compare` CLI commands

The runnable demo is documented in [`examples/hidden-cta/README.md`](../../examples/hidden-cta/README.md).

## Security boundary

Study files and credential references are operator-controlled inputs. CI should select
studies from a trusted base branch and set `PERSONA_RUNTIME_ALLOWED_HOSTS` to the
comma-separated preview/staging host allowlist. The driver separately enforces HTTP(S),
origin/action policies, metadata-host blocking, contained storage-state paths, masked
form screenshots, and evidence hash verification.

## Verification

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm package:smoke
```

The final local run passed all ten workspace test tasks, including 315 legacy package
tests and real-Chromium Persona Runtime/driver integration tests.
