# Examples

## Run something offline first

```bash
npx playwright-spec-for-ai-agent demo
```

`demo` serves [`demo-app/index.html`](./demo-app/index.html) on an ephemeral
local port, writes a throwaway project pointed at it, and runs
`spec → abstract-ai → judge → review` with `QA_AI_ADAPTER=fixture` — no
credentials, no agent CLI, no network. The spec it parses is
[`demo-app/demo.spec.ts`](./demo-app/demo.spec.ts); the recorded abstract-ai
response it replays is [`demo-app/fixtures/abstract.json`](./demo-app/fixtures).

The output directory is a temp dir that is deleted on exit. Pass `--keep`, or
`--out=<dir>` to choose the location, to inspect the artifacts. Two stage
outcomes are expected offline and are not bugs:

- `judge` returns `manual_review` — the fixture adapter never browsed anything,
  and a canned answer must never look like a green verdict.
- `review` exits non-zero with `flagged` — every rubric criterion is a `concern`,
  because the fixture reviewer examined no evidence. The demo prints the exit
  code of any stage that did not return 0.

## Copyable spec files

- [`sample-spec.ts`](./sample-spec.ts) — minimal spec with `@qa-scenario` and
  `@qa-live-policy`.
- [`ocr-fixture-upload-example.ts`](./ocr-fixture-upload-example.ts) —
  `@qa-fixture` (PDF) at file level with a test-level override, for upload flows.

These are documentation, not a runnable suite. Copy one into your own app and
run the pipeline there. The annotation rules are in
[../docs/annotations.md](../docs/annotations.md).

## Where artifacts land

Default layout, from `paths.specDir` and `paths.outputDir`:

```text
src/page/{page}/__tests__/*.spec.ts     ← specs the CLI reads
src/page/{page}/__QA__/                 ← everything a run writes
```

Override both in `playwright-spec-for-ai-agent.config.*`, per page under
`pages.{page}`, or per run with `--spec-dir=` / `--output-dir=`.

Inside the output directory, with `{slug}` being the page id (`/` → `-`):

```text
{slug}-qa-spec.json                     spec
{slug}-qa-spec-abstracted.json          spec
{slug}-qa-spec-live.json                abstract-ai
{slug}-qa-spec-live.md                  abstract-ai   ← the Given/When/Then plan
{slug}-qa-abstract-audit.json           abstract-ai
{slug}-qa-judge-plan.md                 judge
{slug}-hermes-judgment.json / .md       judge         ← the verdict
{slug}-qa-evidence-manifest.json        judge
{slug}-qa-report.ctrf.json              judge
{slug}-qa-verdict-history.json          judge
{slug}-qa-runs.jsonl                    every stage   ← hash-chained ledger
{slug}-qa-run.invalid                   judge, on failure
{slug}-hermes-judge-review*.json/.md/.txt  review
{slug}-qa-ack.json                      ack
evidence/                               judge runner  ← trace, HAR, screenshots, aria
videos/                                 judge runner, with QA_RECORD_VIDEO=1
```

Plus one `*-query.txt` and one `*-raw-output.txt` per agent stage, with secrets
redacted. Field-by-field reference:
[../docs/artifacts.md](../docs/artifacts.md).

`{slug}-qa-spec-live.md` is created only by `abstract-ai`; `spec` alone does not
write it.

```bash
npx playwright-spec-for-ai-agent spec        --page=dashboard
npx playwright-spec-for-ai-agent abstract-ai --page=dashboard
npx playwright-spec-for-ai-agent show        --page=dashboard --evidence
```
