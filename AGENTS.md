# AGENTS.md — QA Native v3 development guide

This is the canonical development guide for
`apps/playwright-spec-for-ai-agent`. Read that application's
`ARCHITECTURE.md` before editing the pipeline. `CLAUDE.md` adds release rules;
this file wins on implementation and validation behavior.

## Product direction

QA Native v3 is intentionally breaking and AI-native:

```text
spec → static-authority → abstract-ai → runtime → evidence → judge → review → report
```

Do not preserve or recreate v2 compatibility. The default pipeline has no AST
semantic compiler, strict executor, compiler/provider matrix, applicability AI,
deterministic semantic judge, old artifact reader, remediation, or publication.

## Document-first development

1. Read `apps/playwright-spec-for-ai-agent/ARCHITECTURE.md` end to end before a
   pipeline edit.
2. Identify the owning stage and trust boundary before changing code.
3. If behavior intentionally changes the architecture, update the architecture
   first. Never rewrite documentation to hide a regression.
4. Keep README and package metadata aligned with the same production path.

## Stage boundaries

| Stage | Owns | Must not own |
| --- | --- | --- |
| `contracts` | five persisted artifact shapes, IDs, hashes, limits | browser or AI behavior |
| `static-authority` | test identity, source range, annotations, policy, fixture names | semantic expectations |
| `abstract-ai` | reviewed Given/When/Then and cache | policy, actions, selectors, verdicts |
| `ai-provider` | prompts and transport normalization | orchestration or authority |
| `runtime` | budgets, capability authorization, Playwright I/O | PASS/FAIL decisions |
| `evidence` | context-aware redaction, sealing, archive | product semantics |
| `judge` | sealed evidence → provisional verdict | browser access or repair |
| `review` | independent grounding approval | replacement verdicts |
| `report` | pure local rendering | AI calls or repository mutation |
| `cli` | the single composition root | duplicated domain rules |

Dependencies point toward earlier stages. `cli` alone composes the complete
pipeline.

## Trust rules

1. Policy authority comes only from `@qa-live-policy` and project config.
2. The execution AI receives When and Then, never Given as an instruction.
3. Model output cannot add origins, fixtures, selectors, files, actions, or
   verdict authority.
4. Runtime outcomes are claims until judge cites sealed evidence.
5. Network methods and WebSockets are authorized per scenario policy and exact
   leased origin.
6. Fixture paths remain project-contained, no-follow, bounded files selected by
   authored fixture name.
7. Redaction is context-specific: URL, headers, structured JSON, and free text
   use separate parsers. Do not create a universal sensitive-key predicate.
8. Evidence failures are preserved as `<run>.invalid`; downstream commands
   refuse invalid paths.

## Working rules

1. Trace the affected stage end to end and search for an existing helper before
   adding code.
2. Fix the shared root cause, not one caller.
3. Preserve unrelated worktree changes.
4. Prefer deletion. No compatibility shim, speculative abstraction, or
   one-implementation interface.
5. Match surrounding naming and comment density.
6. Every non-trivial branch ships with the smallest test that fails if broken.
7. Consumer routes, origins, selectors, strings, product states, and counts are
   evidence only. Never copy them into production defaults or prompts.

## CLI

The production command is:

```bash
qa-native run (--page=<name> | --spec=<file>) \
  --run-dir=.qa/runs/<id> \
  [--base-url=<url>] \
  [--storage-state=<file>] \
  [--allowed-origin=<origin>]
```

Individual stage commands may exist only as debugging entry points over the
same functions. Do not add alternate compilers, providers, or execution modes.

## Verification

Run from `apps/playwright-spec-for-ai-agent`:

```bash
pnpm test
```

There is no separate lint/typecheck script because source is `.mjs`. Before
completion also run:

```bash
git diff --check
```

Report actual output. Never claim green without running the command.

## Required tests

- one consumer-neutral spec → report vertical slice;
- blocked policy launches neither browser nor execution AI;
- read-only versus interaction network authority;
- reviewed behavior has exact authority test-ID coverage;
- reviewer correction cannot add authority fields;
- URL/header/structured/text redaction boundaries;
- judgment references only sealed evidence;
- production overfitting scan.

Tests remain colocated under each module's `__tests__/` directory.

## Consumer page sweeps

1. Never edit consumer tracked code during a QA sweep.
2. Separate missing specs, policy skips, auth/environment failures, application
   failures, and QA Native failures.
3. Promote only consumer-neutral engine defects with a neutral regression test.
4. Do not make a page pass using a product-specific branch.

## Release

This is a Changesets-managed pnpm monorepo. A published-package change requires
a changeset and applied version bump. v3 is breaking, so the final package
version must use a major changeset.

Commit format:

```text
<type>(<scope>): <imperative lowercase subject>
```

Allowed types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
