# Contributing

## Running the tests

```bash
npm ci
npm test                       # vitest run — the whole suite
npx vitest run scripts/__tests__/judge-verdict.test.ts   # one file
node bin/playwright-spec-for-ai-agent.mjs demo           # offline end-to-end run
```

`demo` serves the bundled app on a local port and runs spec → abstract-ai →
judge → review with `QA_AI_ADAPTER=fixture`: no model, no credentials, no
network. It is the fastest way to see a change move through every stage. Every
pull request runs `npm test` on Node 20 and 22 and `demo` on Node 20.

## Layout

`bin/playwright-spec-for-ai-agent.mjs` is a dispatcher: it loads `.env`,
normalizes flags, and spawns one script per command. Its `COMMANDS` table is the
source of truth for which script owns which stage.

| Command | Script |
| --- | --- |
| `spec` | `scripts/extract-page-e2e-spec.mjs` |
| `abstract-ai` | `scripts/run-hermes-spec-abstractor.mjs` |
| `login` | `scripts/run-qa-login.mjs` |
| `judge` | `scripts/run-hermes-page-judge.mjs` |
| `review` | `scripts/run-hermes-judge-review.mjs` |
| `slack` | `scripts/slack-page-qa-report.mjs` |
| `nightly` | `scripts/run-page-qa-nightly.mjs` |
| `doctor` | `scripts/run-qa-doctor.mjs` |
| `show` | `scripts/page-qa-show.mjs` |
| `report` | `scripts/page-qa-report.mjs` |
| `ack` | `scripts/page-qa-ack.mjs` |
| `demo` | `scripts/run-qa-demo.mjs` |

Shared modules under `scripts/` back those stages: `hermes-qa-project-config.mjs`
(config discovery and defaults), `page-qa-paths.mjs` (`artifactPaths` — the only
place artifact filenames are spelled), `errors.mjs` (error classes and exit
codes), `ai-agent-adapter.mjs` (backend selection), `judge-verdict.mjs`,
`agent-output.mjs`, and `qa-evidence.mjs`.

## Exit codes

`scripts/errors.mjs` defines the contract every command honors, and CI branches
on it. A verdict failure and an infrastructure failure must never share a code.

| Code | Meaning |
| --- | --- |
| 0 | judged green, or nothing to judge |
| 1 | verdict failure — the product under test was judged `fail` |
| 2 | usage — wrong flags, missing `--page`, unusable config |
| 3 | environment — agent CLI, model, credentials, or staging missing |
| 4 | agent output — the adapter ran but returned something unusable |

Throw `UsageError`, `EnvironmentError`, or `AgentOutputError` rather than calling
`process.exit` from a stage.

## Adding an adapter

An adapter is one module exporting `run(query, maxTurns, options)` that returns
parsed JSON, plus optional `capabilities`, `prelogin`, and `resolveModel`. It is
done when it passes the exported contract suite:
`runAdapterContractSuite` in `scripts/__tests__/agent-runner-contract.test.ts`.

You do not need to fork to add one — `QA_AI_ADAPTER` also takes a module
specifier (a path or a package name) resolved from the consumer project. Open an
adapter request issue if a backend belongs in the box.

## Zero runtime dependencies

The package ships with no `dependencies`. `@playwright/test` is an optional peer
and `vitest` is a dev dependency; everything else is Node stdlib. A pull request
that adds a runtime dependency needs to argue why a few lines of stdlib will not
do.

## Commits

Conventional Commits, **in English**. release-please turns every commit subject
into a permanent public line in `CHANGELOG.md`, so a subject nobody can read
later is a bug in the changelog. Use `feat:`, `fix:`, `chore:`, `docs:`,
`refactor:`, `test:`; add `!` or a `BREAKING CHANGE:` footer for breaks.

Non-trivial logic ships with a test that fails when the logic breaks.
