# The pipeline

This page is for someone who has run the tool once and wants to know why a
single QA run is split into five commands instead of one. It explains what each
stage consumes and produces, what the split buys, and the trade-off the whole
design rests on: staging is never driven by Playwright. After reading it you
should be able to predict which stage a given failure belongs to, and why a
stage refuses input that another stage produced.

Procedures live elsewhere. To run the pipeline, follow
[the getting-started tutorial](../get-started.md); for the flags each command
takes, see [the CLI reference](../reference/cli.md).

## The problem one agent cannot solve

Handing an agent a repository, a staging URL, and "tell me if the page is
correct" produces an answer that cannot be checked. The agent decides what the
specs meant, decides what it looked at, decides whether that was enough, and
reports one paragraph. Nothing in that chain is reproducible, and every part of
it is the same untrusted narrator.

The pipeline breaks the chain into stages with different trust levels. Parsing
is code, so it is deterministic. The plan is written by a model once and then
frozen, so every later stage argues about the same document. The judge is the
only stage allowed near a browser. The reviewer sees the judge's output and
cannot go look for itself. Each boundary is a place where a stale or mismatched
input can be refused instead of silently absorbed.

## The five stages

`nightly` runs them in order for one page or for every configured page:

```text
spec → abstract-ai → judge → review → slack · issues (optional)
```

| Stage | Consumes | Produces | Agent |
| ----- | -------- | -------- | ----- |
| `spec` | `@qa-scenario`-annotated Playwright specs in the page's spec directory | `{slug}-qa-spec.json` | none |
| `abstract-ai` | `{slug}-qa-spec.json` | `{slug}-qa-spec-live.json`, `{slug}-qa-spec-live.md`, `{slug}-qa-abstract-audit.json` | text-only, 2 turns |
| `judge` | the live plan and the staging URL | `{slug}-qa-judge-plan.md`, `{slug}-hermes-judgment.json`/`.md`, `{slug}-qa-evidence-manifest.json`, `{slug}-qa-report.ctrf.json`, `evidence/` | browsing |
| `review` | the judgment and the pinned judge plan | `{slug}-hermes-judge-review-packet.md`, `{slug}-hermes-judge-review.json`/`.md` | text-only |
| `slack` | the judgment, the review, and the acknowledgements | a Slack message | none |

`{slug}` is the page id with `/` replaced by `-`. Every file is listed, with its
readers, in [the artifacts reference](../reference/artifacts.md).

`nightly` runs each stage as a child process. A stage that crashes, hangs, or
leaks a browser cannot take the orchestrator down with it, and the run exits
with the *worst* outcome across stages rather than the last one — an
environment failure in `judge` must not be overwritten by a Slack failure, or
the alert pages the wrong person. `nightly` also skips the two agent stages when
their inputs provably did not change: `abstract-ai` when the spec hash is
unchanged, `judge` when staging reports a build that already passed. Those two
stages are the largest cost in a nightly run.

## Deterministic reading before judgment

`spec` reads the annotations and never executes or modifies a spec file. It
reads *only* the annotations: which page, which scenario, which live policy,
which fixtures. It does not interpret your assertions.

That boundary is deliberate. An earlier version parsed `expect(...)` chains into
a structured list of expectations, which meant it could only represent the
matchers it had been taught. An assertion it did not recognise silently vanished
from the plan, so the check appeared to pass while testing less than the spec
said — and every Playwright release widened the gap. Reading annotations only is
a contract the tool can actually keep: annotations are a vocabulary this project
defines, while assertions are a language Playwright keeps extending.

What stays deterministic is what has to be. The same specs always yield the same
scenario JSON, so a verdict that changed is either the page changing or the model
changing, and the hash stamps below tell you which. What the tests *mean* is left
to the agent, which is handed the Playwright source verbatim and can read any
assertion Playwright can express.

The annotation vocabulary and the live policies that drive this pass are in
[the annotations reference](../reference/annotations.md).

## The pinned plan

`abstract-ai` writes the Given/When/Then plan once. `judge` writes the exact
document it handed the agent to `{slug}-qa-judge-plan.md`, and `review` reads
that file rather than regenerating anything.

The pin matters because `review` is a critique of a judgment, and a critique of
a document nobody saw is confident nonsense. Reviewing the live plan when the
judge ran against an older revision produces a review that reads as if it were
about this run. `review` falls back to `{slug}-qa-spec-live.md` only when the
judge plan is missing, and says so in a warning, because the fallback is exactly
the case the pin exists to prevent.

The two agent-facing stages are also separated by capability, not only by
order. `judge` runs the adapter in browse mode; `abstract-ai` and `review` run
it in text-only mode, which disables the browser and terminal toolsets on
adapters that support it (`supportsToolsetDisable`). A reviewer that could
browse would stop reviewing the judgment and start re-judging the page, and its
disagreement with the judge would no longer mean anything.

`review` is bound to its input a second way: its entire input is one packet, and
the reviewer must echo the packet's SHA-256 back. A review that echoes a
different digest answered about a different document and is rejected as unusable
agent output.

## The provenance chain

Each stage stamps the hash of what it consumed onto what it produces, and the
next stage re-checks the stamp.

| Boundary | Stamp | Refusal |
| -------- | ----- | ------- |
| `abstract-ai` → `judge` | `sourceHash` on `{slug}-qa-spec-live.json`, the hash of the raw `spec` artifact | `judge` refuses a plan generated from a different spec revision |
| `judge` → `review` | `<!-- specHash: … -->` on the first line of `{slug}-qa-judge-plan.md` | `review` refuses when that hash and the judgment's `specHash` disagree |

Both refusals are usage errors — exit code 2 — and both name the command to
re-run. Hashing excludes the stage stamps themselves (`sourceHash`,
`generatedAt`, `schemaVersion`, `agentMeta`, `inputHash`), so re-running a stage
over identical specs produces an identical hash.

Staleness that cannot be established is not treated as stale. An artifact
written before the stamp existed, or a missing raw spec, is unverifiable rather
than mismatched, and the run proceeds. Only an actual mismatch blocks.

Without these stamps, `judge` would happily judge last night's plan after
`abstract-ai` failed, and `review` would critique a plan the judge never saw.
Both failures are silent, and both are indistinguishable from a real verdict —
which is the worst property a QA tool can have.

## The run ledger

`{slug}-qa-runs.jsonl` is append-only and hash-chained: each entry's `hash`
covers the previous entry's `hash`, starting from `sha256:genesis`. Every entry
carries `runId`, `at`, `kind`, `prevHash`, and `hash`. The kinds written today
are `judge-start`, `judge-retry`, `judge`, `deploy`, `slack`, and `ack`.

The chain makes verdict history tamper-evident. A re-run cannot silently
overwrite last night's `fail`, and a report can cite a `runId` instead of
restating a verdict in prose. `doctor` verifies the chain and reports
`chain broken at entry N: …` when a file was edited or truncated.

The ledger is also where the judge's retry behaviour becomes visible. `judge`
retries on cause — two attempts for an environment failure, one for unusable
agent output, none for anything else — and each retry appends a `judge-retry`
entry. A *completed* judgment is never re-judged, however bad it is: scenario
checks are not silently re-rolled until they come out green.

## The founding trade-off: no Playwright against staging

The tool reads specs as source material and never runs them against staging.
That is a deliberate limitation, and it is why a judgment layer exists at all.

Two properties of a real deployment break spec replay:

- **Mock literals cannot be replayed.** A CI assertion such as
  `toContainText("98 pts")` is a statement about a mocked API response. Run
  against staging it asserts a fixture that is not there, so it fails on a
  correct page. `abstract-ai` converts it into intent — a numeric score with its
  unit and a readable label — which is what the original test was actually
  protecting.
- **Live data is non-deterministic.** Counts, dates, copy, routing, and latency
  all move between runs. Equality assertions over them produce failures that
  carry no information about the product.

The cost is that a judgment is not a proof. A model reads the page and reports,
and the harness can only check that the report is supported by evidence it
captured itself. That is why the verdict is decided by the harness rather than
the agent, why ambiguity resolves to `manual_review` rather than to a forced
pass, and why one run is not treated as settled — see
[how a verdict is decided](./how-verdicts-are-decided.md).

Deterministic Playwright tests still belong in CI. This pipeline is the layer
that runs after deployment and escalates whatever it cannot settle.

## The adapter seam

Every stage that talks to a model calls one function:
`runAgent(query, maxTurns, options)`. The backend is chosen with
`QA_AI_ADAPTER` — a built-in name (`hermes`, `aside`, `exec`, `fixture`) or a
module specifier resolved against the project root. Callers branch on a
capability descriptor rather than on the adapter's name:

| Capability | What it decides |
| ---------- | --------------- |
| `auth` | `cdp-attach` (the runner owns the browser), `self-prelogin` (the adapter drives its own), or `credentials-in-prompt` |
| `supportsMaxTurns` | whether the judge's turn budget is passed through or ignored |
| `supportsToolsetDisable` | whether text-only mode can actually remove the browser toolset |
| `supportsVideo` | whether video recording is available |
| `blocksEventLoop` | whether live request interception is legal during a run |

`blocksEventLoop` is load-bearing rather than informational. Every built-in
adapter runs its CLI with `spawnSync`, which freezes this process for the whole
agent run. A Playwright `context.route` handler is serviced by that same event
loop, so an intercepted request would stall until the agent exits — the browser
waits for a handler that cannot run, and the agent waits for the browser. Live
interception is therefore enabled only when an adapter declares
`blocksEventLoop: false` (the default is `true`).

Blocking adapters get the same coverage from the recorded HAR, inspected after
the run: off-origin `document` requests, and non-GET/HEAD requests to an allowed
origin. The two paths differ in what they can do about a violation. Live
interception *aborts* the request; post-run inspection can only report it. Both
feed the same violation floors.

The same constraint shapes evidence capture. Screenshots and aria snapshots are
taken through an explicit `capture(label)` call rather than on a timer, because
a timer cannot fire while the event loop is blocked and would silently capture
nothing. `close()` calls it once for the settled end state; an adapter that
leaves the loop free can call it between steps.

Writing a backend of your own is covered in
[the add-an-adapter how-to](../how-to/add-an-adapter.md); the built-in
capability values are in [the adapters reference](../reference/adapters.md).

## Related documents

- [How a verdict is decided](./how-verdicts-are-decided.md) — the floors applied to the judge's answer
- [The CLI reference](../reference/cli.md) — every command and flag
- [The artifacts reference](../reference/artifacts.md) — every file a run writes
- [The configuration reference](../reference/configuration.md) — config keys and environment variables
- [The CI how-to](../how-to/ci.md) — exit codes, GitHub Actions, CTRF, Slack
- [Troubleshooting](../troubleshooting.md) — real error messages, indexed by symptom
