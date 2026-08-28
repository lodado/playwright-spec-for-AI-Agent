# How a verdict is decided

This page is for someone reading a judgment that says something other than what
the agent claimed, and wanting to know which rule intervened and why. It
explains the one principle behind every rule, each floor the harness applies,
the cause taxonomy, and what `manual_review` means as an answer. After reading
it you should be able to read a `Verdict floor applied — …` note and say exactly
which rule fired.

The rules themselves live in `scripts/judge-verdict.mjs`. For the shape of the
judgment file, see [the artifacts reference](../reference/artifacts.md); for how
the judgment reaches CI and Slack, see [the CI how-to](../how-to/ci.md).

## The downgrade-only principle

The agent proposes; the harness decides. Every rule below is a **floor**:
normalization may lower the agent's own verdict, never raise it. An agent that
says `fail` is believed. An agent that says `pass` has to show its work.

```text
agent JSON → per-check floors → coverage floor → violation floors → worst(agent status, derived)
```

The asymmetry is the whole design. A model that reports a defect has no
incentive to invent one, and the cost of believing it is a human looking at a
working page. A model that reports success is the failure mode that matters:
"I checked it and it was fine" costs nothing to write, is indistinguishable from
a real pass in prose, and ships a broken page. So the burden of proof sits
entirely on `pass`.

Because the final status is `worst(agent status, derived)`, no accumulation of
green checks can turn an agent's `manual_review` into a `pass`. Every note a
floor produces is appended to the judgment's `summary` after
`Verdict floor applied — `, so a downgraded verdict always carries the reason
that downgraded it.

## Per-check floors

A check's `result` is one of `pass`, `fail`, `skip`, or `manual_review`;
anything else becomes `manual_review`. Then three rules apply.

**Low confidence demotes.** An explicit `confidence: "low"` on a `pass` becomes
`manual_review` with `demotedFrom: "pass"`. A *missing* confidence is treated as
`medium` — absence is not a claim of low confidence, and the evidence rule below
already gates the pass.

**Evidence or demote.** A `pass` must cite something concrete, or it becomes
`manual_review` with `demotedFrom: "pass"`. Concrete means either:

- an `evidenceRefs` entry naming a file the runner actually captured (by full
  path or basename), or that resolves on disk; or
- a `detail` containing a quoted string (2+ characters, straight or curly
  quotes), a URL or an absolute path, or a number carrying a unit (`%`, `ms`,
  `s`, `px`, `kb`, `mb`, `items`, `rows`, `results`, `credits`, a currency
  symbol, `점`, `개`, `원`).

The list is deliberately mechanical. It does not judge whether the evidence is
*good*, only whether the agent quoted something it could only have got by
looking. "I checked it and it was fine" matches none of these.

**Cause is required on a non-pass.** A `pass` always carries `NONE`. A non-pass
whose declared cause is missing or unrecognised becomes `HARNESS_DEFECT` — an
agent that cannot classify its own failure *is* the defect, and guessing
`PRODUCT_DEFECT` would blame the application for a harness problem.

**Nothing executed is not green.** A run whose checks are all `skip` — after a
failed login, for example — floors at `manual_review`. This is the same
principle as pytest's exit code 5 or Playwright's "no tests found": zero
executed checks is not a pass.

## The parser-gap floor

A check can be capped before the agent ever sees it. When the parser cannot read
every Playwright assertion in a read-only test, it assigns that test the derived
verb `judgment-parser-gap` instead of `executable-readonly`, and the plan lists
the API calls it could not resolve. The judge is told to inspect the page and
report what it sees, but that a pass is forbidden: the check settles at
`manual_review` with cause `SPEC_GAP`.

The reasoning is the same as everywhere else here. A test whose assertions were
only half understood produces a plan that asserts less than the test does, and a
`pass` against a weakened plan claims more than was checked. Capping keeps the
gap visible — in the verdict and in the plan — until the parser learns the
construct or the spec is rewritten in one it already reads.


## The coverage floor

`coverage` is `{ planned, addressed, missing[] }`. Any unaddressed planned check
floors the verdict at `manual_review` and appends
`N planned check(s) unaddressed: …` to the summary. A plan the agent only
partially answered is not a verdict on the plan.

`planned` counts **one entry per plan block, duplicates included** — it is the
length of the checklist the agent was handed, not a set. The same title is
legitimately planned once per scenario (`shows the plan name` under `ACTIVE`,
under `INACTIVE`, under `CANCEL_PENDING`), and the agent reports one check per
block. Deduplicating here made `coverage.planned` disagree with the very
document the run pinned, which `review` then flagged — correctly. For the same
reason the abstraction validator identifies a planned test by
**(scenario, title)**: a title repeated across scenarios is not
`test planned more than once`.

## The matching ladder

Pairing a planned title with a reported `checks[].item` is a ladder, tried in
order:

1. exact string equality;
2. equality after collapsing whitespace and lowercasing;
3. bounded containment — either side may contain the other, but the shorter side
   must be at least 8 characters. When several reported checks qualify, the one
   closest in length to the planned title wins.

Each reported check can satisfy only one planned entry: once matched it is
consumed, so a single vague line cannot cover a whole plan.

Rung 3 exists because of a specific incident. Real agents paraphrase a title
even when told not to — dropping a project's `"to be: "` prefix from every
title, or re-adding the scenario name. Under exact-only matching, a complete run
in which every check was genuinely performed was read as **0 addressed**,
floored to `manual_review`, and reported with every check listed as unaddressed.
The floor rules were working; the input to them was wrong.

The 8-character minimum and the one-to-one consumption are what keep the
fallback from degenerating into "any check counts for anything". Without them,
a reported item of `"ok"` would match every planned title that contains those
letters.

The evidence manifest deliberately does not use rung 3. It matches by
normalised title only, so a paraphrased check counts as addressed in `coverage`
while the manifest still lists it as `"result": "unaddressed"`. The verdict
follows `coverage`; the manifest is the stricter record of what the agent
literally reported.

## Violation floors

The harness watches the browser, not the narrative. Violations are recorded by
the runner-owned Playwright context, so the audited party cannot suppress them.

| Kind | Effect on the verdict |
| ---- | --------------------- |
| `off-origin-navigation` | `fail`, cause forced to `HARNESS_DEFECT` |
| `unexpected-mutation` / `blocked-mutation` | `manual_review` |
| `suspicious-aria`, `capture-failed`, `capture-unavailable`, `route-error`, `session-close-failed` | recorded only |

A run that left the site under test can say nothing trustworthy about the
target, hence `fail`. A write that landed on a read-only plan may have changed
staging state, so a human has to look. A missing screenshot is not a product
signal, so it is recorded and nothing more.

A plan is read-only unless it contains a test with `liveRunPolicy`
`executable-interaction` or `judgment-interaction-no-confirm`.

How violations are detected depends on the adapter, and the two paths are not
equivalent. With `blocksEventLoop: false` the browser layer intercepts live and
*aborts* off-origin main-frame navigations and, on a read-only plan, every
non-GET/HEAD request. With a blocking adapter — all four built-ins — no route
handler can run while `spawnSync` holds the event loop, so the same two checks
are applied to the recorded HAR after the run: off-origin `document` requests,
and non-GET/HEAD requests to an allowed origin. The reasoning behind that split
is in [the pipeline explanation](./pipeline.md#the-adapter-seam).

Two consequences follow. Mutation analysis is skipped entirely when no
`allowedOrigins` are configured — there is nothing to compare a request against,
and guessing would be worse than declining. And an attached browser records no
HAR at all, so a blocking adapter on `--cdp-url` has no post-run mutation
analysis; the run records a `capture-unavailable` violation so the gap is
visible rather than implied. See
[the authentication how-to](../how-to/authentication.md) for what each session
path gives up.

## The cause taxonomy

| Cause | Meaning | Where it routes |
| ----- | ------- | --------------- |
| `PRODUCT_DEFECT` | The application under test is wrong. | the team that owns the page |
| `SPEC_GAP` | The plan does not cover what the page actually does. | whoever maintains the specs and annotations |
| `ENVIRONMENT_DEFECT` | Login, deployment, or network broke; the product was never really tested. | whoever owns staging |
| `HARNESS_DEFECT` | The agent or its tooling failed. | whoever owns this tool's setup |
| `NONE` | Only for a `pass`. | nobody |

The run-level cause is derived in this order: an off-origin navigation forces
`HARNESS_DEFECT`; otherwise the agent's declared cause is used if valid;
otherwise the first cause present among the checks, in the priority
`PRODUCT_DEFECT > ENVIRONMENT_DEFECT > SPEC_GAP > HARNESS_DEFECT`.

`PRODUCT_DEFECT` outranks `ENVIRONMENT_DEFECT` on purpose. A judgment whose
run-level cause is `ENVIRONMENT_DEFECT` quarantines the run — it writes
`{slug}-qa-run.invalid`, exits **3**, and is not reported as a product failure.
That quarantine is the right response to a broken staging environment and the
wrong response to a page with four real defects and one unreachable sub-page,
so the product cause wins the tie.

Exit code 3 also has to stay distinct from exit code 1. A nightly that cannot
tell "staging is broken" from "staging is down" pages the wrong person. The full
exit-code contract is in [the CI how-to](../how-to/ci.md).

## `manual_review` as an abstention

`manual_review` is not a soft failure. It is the harness declining to answer,
and it is what you get when the page is neither clearly correct nor clearly
broken:

- mock-backed intent that cannot be confirmed live;
- a `pass` with no concrete evidence, or reported with low confidence;
- an unaddressed planned check;
- a write that landed on a read-only plan;
- a run where nothing executed.

Treating any of these as `pass` would make a green run meaningless; treating
them as `fail` would make the alert channel noise. The abstention keeps both
signals honest at the cost of human attention, which is the resource the tool is
spending deliberately.

The verdict itself is decided per run. A check that abstains every night is a
different problem, and `ack` is what it is for: an acknowledged check stops
appearing in the Slack alert body without changing the verdict. An ack requires
a reason and carries an expiry — an ack without a reason is indistinguishable
from an ignored alert, and one that never expires turns a known issue into an
unknown one. The flags are in [the CLI reference](../reference/cli.md).

## The review's own floor

The downgrade-only principle applies a second time, to the reviewer. `review`
is the independent check on the judge, and nothing it says is taken on trust.

The `evidence-cited` criterion is re-computed in code: judged checks whose
`detail` and `evidenceRefs` contain no quote, URL, number, or artifact filename
are appended to the criterion's detail and its verdict is floored at `concern`,
whatever the reviewer said. A reviewer that waves through an unevidenced pass
loses the argument to the same predicate that gated the pass in the first place.

`--samples=N` (1–9) runs the review N times over the same packet and takes a
per-criterion majority. Ties go to the more severe verdict, and disagreement is
reported as `unstable` rather than smoothed over: reviewers who cannot agree
have told you something, and averaging it away discards it. `review` exits
non-zero when the review is `flagged`, `unstable`, or any criterion is `concern`
or `fail`.

## Verdict history

One judgment is a sample, not a proof — the model is non-deterministic, and so
is the environment. `{slug}-qa-verdict-history.json` keeps the last 30 runs so a
verdict can be read against its neighbours.

Analysis is confined to runs sharing the newest `specHash`. A verdict that
changed after the spec changed is a new expectation, not a flake, and mixing the
two would report every intentional change as instability. Within that cohort,
flakiness looks at the last 10 runs and flags a check whose flips-per-transition
reaches `0.3` with more than one run; the stable-verdict rule needs a strict
majority over a full sample of the last 3 runs, so two of three agreeing counts
while one of two, and a first-ever run, do not.

The file format is in [the artifacts reference](../reference/artifacts.md).

## Related documents

- [The pipeline](./pipeline.md) — why the stages are separated and how provenance is enforced
- [The artifacts reference](../reference/artifacts.md) — the judgment contract, evidence manifest, and history files
- [The annotations reference](../reference/annotations.md) — the live policies that decide what is executable
- [The CI how-to](../how-to/ci.md) — exit codes and reporting
- [Troubleshooting](../troubleshooting.md) — real error messages, indexed by symptom
- [Glossary](../glossary.md) — verdict, cause, floor, coverage, and the other terms used here
