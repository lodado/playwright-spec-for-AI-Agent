# Playwright Spec for AI Agent: one-shot prompt

Copy the prompt below into an AI coding agent working in the target application repository.

```text
Set up and run the full `qa-native` QA and remediation flow in this repository.

Goal: execute every eligible scenario in the selected existing Playwright spec against its configured staging environment, including authenticated flows, create sealed evidence and a judgment, then create the evidence-backed report and run eligible remediation/publication steps. Complete the work without follow-up questions; use the repository's existing package manager, scripts, CI/staging configuration, and formatting conventions.

Rules:
- Require Node.js 20+ on macOS or Linux. Install `playwright-spec-for-ai-agent` and `@playwright/test` as development dependencies only when absent, and install Chromium only when absent.
- Select an existing annotated `*.spec.ts` or `*.spec.js` and its configured staging base URL. Run every scenario the spec declares, including interaction, confirmation, upload, authenticated, and mutation scenarios, but do not edit annotations or bypass the scenario's declared QA Native/Playwright safety policy.
- Reuse an existing workspace-local staging `storageState` file when available; it must be owner-only (`chmod 600`) and must never be copied into run artifacts, committed, or printed. Use an existing auth-bootstrap file only when it has explicit origin and endpoint allowlists. Never put credentials, cookies, tokens, or query strings into a command, source file, or report.
- Reuse `QA_NATIVE_INTEGRITY_KEY` and `QA_NATIVE_PUBLICATION_KEY` from the secure environment/CI secret store. If either is absent, generate a canonical base64 32-byte value in the current shell, do not print or commit it, and report that the operator must store it as a stable secret before a repeatable publication run.
- Run `npx qa-native execute --spec=<relative-spec-path> --base-url=<staging-url> --run-dir=.qa/runs/one-shot-<unique-id>` with `--storage-state` and/or `--auth-bootstrap` when configured, then run `npx qa-native judge --run-dir=<same-run-dir>`. Use `--provider=hermes --mode=adaptive` only when the selected scenario needs adaptive behavior and the repository's Hermes configuration is already present.
- Run `npx qa-native report --run-dir=<same-run-dir> --repository-root=. --revision=HEAD`. For eligible `FAIL` or `MANUAL_REVIEW` outcomes, run `propose-patch`, `verify-patch`, and `remediate --repository=<owner/repository> --publish=auto`; allow QA Native to create/update only its eligible evidence-backed Issue or Draft PR. Do not manually edit the patch worktree, create a non-draft PR, merge, auto-merge, or publish when required verification is missing, failed, timed out, network-dependent, or inconclusive.
- Inspect the judgment, report, verification, and publication results. Treat `manual_review` as a valid safe result; do not force a pass/fail conclusion. Do not overwrite an existing `.qa` run directory.

Finish with: selected spec and scenario count, staging URL, authentication method without secrets, exact commands run, run directory, evidence/judgment/report paths, verdict, verification result, publication result, changed files, and validation result. If a required staging configuration, authenticated state, GitHub authentication, or stable secret is unavailable, complete every non-blocked local stage and report the exact prerequisite for the blocked stage.
```
