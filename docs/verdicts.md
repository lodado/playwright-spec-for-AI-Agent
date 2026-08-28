# How a verdict is decided

The agent proposes; the harness decides. Every rule below is a **floor**:
normalization may lower the agent's own verdict, never raise it. An agent that
says `fail` is believed. An agent that says `pass` has to show its work.

```
agent JSON → per-check floors → coverage floor → violation floors → worst(agent status, derived)
```

## Per-check floors

A check's `result` is one of `pass`, `fail`, `skip`, `manual_review`; anything
else becomes `manual_review`. Then:

**Low confidence demotes.** An explicit `confidence: "low"` on a `pass` becomes
`manual_review`. A *missing* confidence is treated as `medium` — absence is not
a claim of low confidence, and the evidence rule below already gates the pass.

**Evidence or demote.** A `pass` must cite something concrete, or it becomes
`manual_review` with `demotedFrom: "pass"`. Concrete means either:

- an `evidenceRefs` entry that names a file the runner actually captured (by
  full path or basename), or that resolves on disk; or
- a `detail` containing a quoted string (2+ chars, straight or curly quotes), a
  URL or an absolute path, or a number carrying a unit (`%`, `ms`, `s`, `px`,
  `kb`, `mb`, `items`, `rows`, `results`, `credits`, a currency symbol, `점`,
  `개`, `원`).

"I checked it and it was fine" matches none of these.

**Cause.** A `pass` always carries `NONE`. A non-pass whose declared cause is
missing or unrecognised becomes `HARNESS_DEFECT` — an agent that cannot classify
its own failure *is* the defect, and guessing `PRODUCT_DEFECT` would blame the
app for a harness problem.

## Nothing executed is not green

A run whose checks are all `skip` — a failed login, for example — floors at
`manual_review`. Same principle as pytest's exit code 5 or Playwright's "no
tests found": zero executed checks is not a pass.

## Coverage floor

`coverage` is `{ planned, addressed, missing[] }`, computed by matching the
plan's check titles against the agent's `checks[].item` (exact first, then
whitespace- and case-normalised). Any unaddressed planned check floors the
verdict at `manual_review` and appends
`N planned check(s) unaddressed: …` to the summary.

## Violation floors

The harness watches the browser, not the narrative.

| Kind                                        | Effect on the verdict                             |
| ------------------------------------------- | -------------------------------------------------- |
| `off-origin-navigation`                     | `fail`, cause forced to `HARNESS_DEFECT`          |
| `unexpected-mutation` / `blocked-mutation`  | `manual_review`                                    |
| `suspicious-aria`, `capture-failed`, `route-error`, `session-close-failed` | recorded only  |

A run that left the site under test can say nothing trustworthy about the
target, hence `fail`. A write that landed on a read-only plan may have changed
staging state, hence a human. A missing screenshot is not a product signal.

How violations are detected depends on the adapter. With `blocksEventLoop:
false` the browser layer intercepts live and *aborts* off-origin main-frame
navigations and (on a read-only plan) every non-GET/HEAD request. With a
blocking adapter — all four built-ins — no route handler can run while
`spawnSync` holds the event loop, so the same checks are applied to the recorded
HAR after the run: off-origin `document` requests, and non-GET/HEAD requests to
an allowed origin. Mutation analysis is skipped entirely when no
`allowedOrigins` are configured; there is nothing to compare a request against.

A plan is read-only unless it contains a test with `liveRunPolicy`
`executable-interaction` or `judgment-interaction-no-confirm`.

## Cause taxonomy

| Cause                | Meaning                                                                 |
| -------------------- | ------------------------------------------------------------------------ |
| `PRODUCT_DEFECT`     | The application under test is wrong.                                    |
| `SPEC_GAP`           | The plan does not cover what the page actually does.                    |
| `ENVIRONMENT_DEFECT` | Login, deployment, or network broke; the product was never really tested.|
| `HARNESS_DEFECT`     | The agent or its tooling failed.                                        |
| `NONE`               | Only for a `pass`.                                                      |

The run-level cause is derived in this order: an off-origin navigation forces
`HARNESS_DEFECT`; otherwise the agent's declared cause is used if valid;
otherwise the first cause present among the checks, in the priority
`PRODUCT_DEFECT > ENVIRONMENT_DEFECT > SPEC_GAP > HARNESS_DEFECT`.

`PRODUCT_DEFECT` deliberately outranks `ENVIRONMENT_DEFECT`: one unreachable
sub-page must not quarantine — and so hide — four real product failures.

A judgment whose run-level cause is `ENVIRONMENT_DEFECT` quarantines the run
(writes `{slug}-qa-run.invalid`) and exits **3**. It is not reported as a
product failure.

## Retries

`judge` retries on cause: two attempts for an `EnvironmentError`, one for an
`AgentOutputError`, zero for anything else. A *completed* judgment is never
re-judged, however bad it is — scenario checks are not silently re-rolled. When
the budget runs out, the last real failure propagates; no synthetic "final
attempt" verdict is invented. Each retry appends a `judge-retry` entry to the
ledger.

## Stale-input refusal

Each stage stamps the hash of what it consumed onto what it produces, and the
next stage re-checks it:

- `abstract-ai` stamps the raw spec's hash onto the live plan. `judge` refuses a
  plan generated from a different spec revision.
- `judge` records the spec hash in the judge plan markdown. `review` refuses when
  that hash and the judgment's `specHash` disagree.

Both are usage errors (exit 2) naming the command to re-run. Without them,
`judge` would happily judge last night's plan after `abstract-ai` failed, and
`review` would critique a plan the judge never saw — both silent, both
indistinguishable from a real verdict.

## `manual_review`, and what to do with it

`manual_review` means "a human has to look". It is what the harness returns when
the page is neither clearly correct nor clearly broken: mock-backed intent that
cannot be confirmed live, a `pass` with no concrete evidence, an unaddressed
planned check, a write that landed on a read-only plan, or a run where nothing
executed.

The verdict itself is decided per run. Repeated `manual_review` on the same
check is what `ack` and the verdict history are for.

### Triage with `ack`

An acknowledged check stops appearing in the Slack alert body without changing
the verdict.

```bash
# what the latest judgment called this check, exactly
npx playwright-spec-for-ai-agent show --page=dashboard --failed

npx playwright-spec-for-ai-agent ack --page=dashboard \
  --item="shows health score on dashboard" \
  --reason="known staging data gap, tracked in ACME-412" \
  --until=2026-09-30

npx playwright-spec-for-ai-agent ack --page=dashboard --list
npx playwright-spec-for-ai-agent ack --page=dashboard --remove="shows health score on dashboard"
```

- `--item=` must match a check title in the latest judgment exactly; a typo
  fails loudly and prints the available items, because an ack that matches
  nothing looks identical to a working one until the alert fires again.
- `--reason=` is mandatory. An ack without a reason is indistinguishable from an
  ignored alert.
- `--by=` defaults to `$USER`; `--until=` defaults to 14 days out. An ack with no
  `until` never expires, but the CLI always writes one — silence has to run out,
  or a known issue quietly becomes an unknown one.
- Re-acking the same item replaces the entry, so a second ack extends rather
  than duplicates.

Acks are stored in `{slug}-qa-ack.json` and recorded in the run ledger.

## Verdict history and flakiness

`{slug}-qa-verdict-history.json` keeps the last 30 runs. Analysis is confined to
runs sharing the newest `specHash`: a verdict that changed after the spec
changed is a new expectation, not a flake.

- **Flakiness** looks at the last 10 same-spec runs. A check's `flipRate` is
  flips per transition; at `>= 0.3` with more than one run it is `flaky`. The
  same computation runs over the run-level verdicts.
- **Stable verdict** is an n-of-m rule over the last 3 same-spec runs: stable
  only when one status holds a strict majority **and** the sample is full. Two
  of three agreeing counts; one of two, and a first-ever run, do not.

## Review

`review` is the independent check on the judge, and nothing it says is taken on
trust. Its entire input is one packet — the plan the judge used, the judgment
verbatim, the runner-captured filenames, the flagged accessible names, and the
ledger entries for that run — and it must echo the packet's SHA-256 back. A
review that echoes a different digest answered about a different document and is
rejected as unusable agent output (exit 4).

The `evidence-cited` criterion is additionally re-computed in code: judged
checks whose `detail` and `evidenceRefs` contain no quote, URL, number, or
artifact filename are appended to the criterion's detail and its verdict is
floored at `concern`, whatever the reviewer said.

`--samples=N` (1–9) runs the review N times over the same packet and takes a
per-criterion majority; ties go to the more severe verdict, and disagreement is
reported as `unstable` rather than smoothed over.

`review` exits non-zero when the review is `flagged`, `unstable`, or any
criterion is `concern` or `fail`.
