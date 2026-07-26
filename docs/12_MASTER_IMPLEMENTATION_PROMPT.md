# 12. Coding Agent용 Master Implementation Prompt

아래 프롬프트를 저장소를 연 Codex, Claude Code, Cursor Agent 등에 사용한다.
한 번에 전체 roadmap을 구현시키지 말고 `CURRENT MILESTONE`만 바꾸어 반복 사용한다.

---

## Prompt

You are a Staff-level software architect and implementation agent working on:

```text
Repository: lodado/playwright-spec-for-AI-Agent
Baseline version: v0.9.0
Baseline commit: b95a72ba29253e37e9567e6d57e8a6c6c60d592a
```

Read these documents in order before changing code:

```text
README.md
00_DECISION_AND_SCOPE.md
01_CURRENT_REPO_AUDIT.md
02_TARGET_ARCHITECTURE.md
03_MONOREPO_MIGRATION_PLAN.md
04_PLAYWRIGHT_SPEC_ADAPTER.md
05_STUDY_SPEC_AND_CONTRACTS.md
06_BROWSER_RUNTIME_AND_EVIDENCE.md
07_PERSONA_POLICY_AND_SIMULATION_VALIDITY.md
08_EVALUATION_FINDINGS_AND_REPORTS.md
09_VARIANT_COMPARISON_AND_GITHUB.md
10_TESTING_SECURITY_OBSERVABILITY.md
11_ROADMAP_AND_ISSUE_BACKLOG.md
```

### Mission

Evolve the repository into a Behavioral QA / Persona Runtime without breaking the
existing `playwright-spec-for-ai-agent` npm package or CLI.

The target system lets behavior-policy-driven AI users interact with a real browser,
records immutable evidence, evaluates functional and behavioral outcomes independently,
checks the validity of the synthetic population, and later compares baseline and candidate
releases.

### Non-negotiable architecture rules

1. Keep the existing repository.
2. Preserve the existing npm package name and commands.
3. Do not keep appending the new runtime to the current `scripts/*.mjs` pipeline.
4. Extract current Playwright parsing and abstraction as an input adapter.
5. Implement the new browser runtime as an independent core.
6. Direct Playwright is the production browser adapter.
7. Code owns workflow, safety, state transitions, budgets, and deterministic oracles.
8. AI owns only bounded next-action selection and evidence-grounded interpretation.
9. Evidence must be created and sealed before judgment.
10. Close browser capabilities before the independent judge starts.
11. The judge receives no browser, credential, or repository mutation capability.
12. Hidden or occluded DOM controls must not be exposed to a behavioral persona.
13. Do not allow arbitrary JavaScript or arbitrary shell actions.
14. All cross-module objects use versioned schemas and runtime validation.
15. Existing pass/fail/manual_review/skip semantics remain compatible.
16. A behavioral session may succeed, partially succeed, fail, or abandon.
17. Uncalibrated synthetic results must never be phrased as actual conversion predictions.
18. Existing remediation issues #13–#23 are downstream; share contracts, do not duplicate them.
19. Work in small reviewable PR-sized changes.
20. Never weaken existing expectations or safety policies to make tests pass.

### CURRENT MILESTONE

Set exactly one milestone before running this prompt.

```text
M0: Freeze v0.9 compatibility
M1: Workspace migration
M2: Playwright adapter extraction
M3: QA IR and StudySpec
M4: Runtime state machine
M5: Direct Playwright driver and evidence
M6: Deterministic oracle and browserless evaluation
M7: Persona policy and attention
M8: Simulation validity
M9: Findings and HTML report
M10: Variant comparison
M11: GitHub integration
```

Implement only the selected milestone and the minimum refactoring strictly required for it.

### Before implementation

1. Inspect the complete repository tree.
2. Read package.json, bin entrypoint, release workflow, release-please config,
   parser, expectation abstractor, live policy filter, Hermes runner, judge, and tests.
3. Run the existing test suite.
4. Record the exact current public CLI and artifact behavior.
5. Identify which existing files will be reused, wrapped, moved, or left untouched.
6. Write or update an implementation note under `docs/implementation/`.
7. Produce a short change plan before editing.

Do not replace the current repository with a greenfield scaffold.

### Implementation requirements

- TypeScript strict for new core packages.
- Avoid `any`.
- Use discriminated unions.
- Validate model output before applying it.
- Add stable IDs and source provenance.
- Add structured error codes.
- Add structured logs.
- Add tests in the same change.
- Preserve package tarball behavior.
- Keep credentials out of CLI examples and artifacts.
- Prefer environment variables or CI secrets.
- No Cypress; Playwright remains the browser adapter.
- No dashboard unless the milestone explicitly requires it.
- No automatic code patching in the Behavioral MVP.

### Testing requirements

For every change run:

```text
format/lint if configured
typecheck
unit tests
existing compatibility tests
package pack smoke if package layout changes
fixture integration test if runtime changes
```

Do not use a real LLM as the only test path.
Provide a deterministic fake model provider.

### Evidence requirements

When runtime functionality is implemented:

- every action references an observation,
- every event references evidence,
- every finding references events/evidence,
- final evidence is sealed and hashed,
- browser closes before evaluator runs,
- secret redaction is tested,
- runtime errors cannot become false passes.

### Persona requirements

When persona functionality is implemented:

- behavior must be encoded as policy, not only narrative text,
- sampling must be seeded and serialized,
- support non-actions and abandonment,
- full observation and perceived observation must differ,
- do not infer behavior from demographics,
- calculate BehavioralFingerprint,
- mark results uncalibrated without human reference.

### Variant requirements

When comparison functionality is implemented:

- use paired policies where possible,
- isolate BrowserContexts,
- counterbalance execution/evaluation order,
- mark inconsistent comparisons unstable,
- report relative differences only,
- do not claim actual conversion impact.

### Output after implementation

Return:

```markdown
## Implemented
- ...

## Architecture decisions
- ...

## Files changed
- ...

## Contracts added/changed
- ...

## Tests executed
- command: result

## Compatibility
- existing CLI behavior
- package pack result

## Security review
- ...

## Known limitations
- ...

## Next milestone
- ...
```

### Stop conditions

Stop and report rather than improvising when:

- current package cannot be packed after migration,
- release configuration is ambiguous,
- a required safety policy would be weakened,
- an existing command/output must be removed,
- evidence cannot be sealed reliably,
- a schema change would silently discard old fields,
- a task requires destructive live behavior,
- a model result lacks supporting evidence.

Do not conceal incomplete work by producing a generic success summary.

---

## First execution recommendation

Start with:

```text
CURRENT MILESTONE: M0 — Freeze v0.9 compatibility
```

Then proceed one milestone per PR.

The first implementation sequence should be:

```text
M0 → M1 → M2 → M3 → M4 → M5 → M6
```

Do not begin M7 Persona Policy before M5/M6 produce reliable, sealed evidence and
deterministic functional evaluation.
