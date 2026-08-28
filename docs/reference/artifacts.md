# Artifacts reference

Look up which file a run writes, which command reads it, and what every field in
it means. This page is for anyone inspecting a run after the fact or building a
tool on top of one.

Everything a run produces lands in one directory per page — by default
`src/page/{page}/__QA__/`, overridable with `paths.outputDir`,
`pages.{page}.outputDir`, `--output-dir=`, or `QA_OUTPUT_DIR`. `{slug}` below is
the page id with `/` replaced by `-`; `{runId}` is `run-` plus eight hex
characters.

## Files

| File                                         | Written by                         | Read by                                                         |
| -------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| `{slug}-qa-spec.json`                        | `spec`                             | `abstract-ai`, `judge`, `nightly`, `show`                         |
| `{slug}-qa-spec-abstracted.json`             | `spec`                             | `abstract-ai` (preferred input), `judge`                          |
| `{slug}-qa-spec-live.json`                   | `abstract-ai`                      | `judge`, `nightly` (reuse check)                                  |
| `{slug}-qa-spec-live.md`                     | `abstract-ai`                      | `judge` (the plan), `review` (fallback)                           |
| `{slug}-qa-abstract-audit.json`              | `abstract-ai`                      | `abstract-ai` (reuse bookkeeping)                                 |
| `{slug}-hermes-abstract-query.txt`           | `abstract-ai`                      | humans; `--dry-run` writes only this                              |
| `{slug}-hermes-abstract-raw-output.txt`      | `abstract-ai`                      | humans, when the output is unusable                               |
| `{slug}-qa-judge-plan.md`                    | `judge`                            | `review` (the pinned plan)                                        |
| `{slug}-hermes-query.txt`                    | `judge`                            | humans (secrets redacted)                                         |
| `{slug}-hermes-raw-output.txt`               | `judge`                            | humans (secrets redacted)                                         |
| `{slug}-hermes-judgment.json`                | `judge`                            | `review`, `slack`, `report`, `show`, `ack`, `doctor`, `nightly`   |
| `{slug}-hermes-judgment.md`                  | `judge`                            | humans                                                            |
| `{slug}-qa-evidence-manifest.json`           | `judge`                            | humans                                                            |
| `{slug}-qa-report.ctrf.json`                 | `judge`                            | any CTRF-consuming reporter                                       |
| `{slug}-qa-verdict-history.json`             | `judge`                            | `flakinessReport()` / `stableVerdict()`; no CLI command today     |
| `{slug}-qa-runs.jsonl`                       | `judge`, `review`, `nightly`, `slack`, `ack` | `report`, `review` packet, `doctor`                     |
| `{slug}-qa-run.invalid`                      | `judge`, on failure                | `review`, `slack`, `report`, `show`, `doctor`                     |
| `{slug}-hermes-judge-review-packet.md`       | `review`                           | humans (the reviewer's exact input)                               |
| `{slug}-hermes-judge-review-query.txt`       | `review`                           | humans                                                            |
| `{slug}-hermes-judge-review-raw-output.txt`  | `review`                           | humans (`-sampleN.txt` with `--samples=`)                         |
| `{slug}-hermes-judge-review.json`            | `review`                           | `slack`, `report`, `show`                                         |
| `{slug}-hermes-judge-review.md`              | `review`                           | humans                                                            |
| `{slug}-qa-ack.json`                         | `ack`                              | `slack`                                                           |
| `evidence/`                                  | `judge` runner                     | `review` packet, `show --evidence`, both via the paths in the judgment |
| `videos/`                                    | `judge` runner, under `QA_RECORD_VIDEO` | humans                                                       |

Every JSON artifact this package writes carries `schemaVersion` (currently `1`)
and `artifactKind`. A file whose `schemaVersion` is higher is refused with
`Artifact <path> was written by a newer version (schemaVersion N > 1).` rather
than parsed on a guess.

## The judgment

`{slug}-hermes-judgment.json` is the artifact everything downstream reads.

| Field               | Type                        | Meaning                                                                   |
| ------------------- | --------------------------- | --------------------------------------------------------------------------- |
| `schemaVersion`     | number                      | `1`. A higher number is refused.                                            |
| `artifactKind`      | `"judgment"`                | Identity stamp.                                                             |
| `runId`             | `run-xxxxxxxx`              | Ties the judgment to its ledger entries and evidence filenames.             |
| `page`              | string                      | Page id.                                                                    |
| `judgedAt`          | ISO 8601 string             | When the verdict was written.                                               |
| `targetUrl`         | string                      | The absolute URL that was judged.                                           |
| `targetPath`        | string                      | Display path for that URL.                                                  |
| `planSource`        | string                      | `spec-live.md` when the saved live plan was used, `generated-from-json` when the judge rebuilt one. |
| `specHash`          | `sha256:…`                  | Hash of the raw `spec` artifact this plan descends from.                    |
| `status`            | `pass｜fail｜manual_review`  | The verdict, after the floor rules.                                         |
| `cause`             | see below                   | Failure taxonomy for the run.                                               |
| `summary`           | string                      | The agent's summary, plus `Verdict floor applied — …` when a rule fired.    |
| `recommendedAction` | string                      | What the agent suggests a human do. `""` when the agent said nothing.       |
| `source`            | string                      | Adapter name; `hermes-agent` for `hermes`.                                  |
| `agentMeta`         | object                      | `{ adapter, model, durationMs }`. Omitted when the adapter reported none.   |
| `checks`            | array                       | Per-check results — see below.                                              |
| `coverage`          | object                      | `{ planned, addressed, missing[] }`.                                        |
| `evidence`          | string[]                    | The agent's free-text evidence notes.                                       |
| `runnerEvidence`    | object｜null                | What the harness captured — see below. `null` when no runner-owned browser. |

`cause` is one of `PRODUCT_DEFECT`, `SPEC_GAP`, `ENVIRONMENT_DEFECT`,
`HARNESS_DEFECT`, `NONE`.

Violations are not a top-level field. The ones the browser layer saw are in
`runnerEvidence.violations`; the ones derived from post-run HAR inspection reach
you through the `Verdict floor applied — …` note appended to `summary`.

### `checks[]`

| Field          | Type                              | Meaning                                                                          |
| -------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| `item`         | string                            | The planned check title. Defaults to `"Untitled check"`.                            |
| `detail`       | string                            | What the agent observed. The evidence rule reads this field.                        |
| `result`       | `pass｜fail｜skip｜manual_review`   | An unrecognised value becomes `manual_review`.                                      |
| `confidence`   | `high｜medium｜low`                | Missing means `medium`, not `low`.                                                  |
| `cause`        | see the taxonomy above            | `pass` → `NONE`; a non-pass with no valid cause → `HARNESS_DEFECT`.                 |
| `evidenceRefs` | string[]                          | Artifact filenames or paths backing the check. `[]` when there are none.            |
| `demotedFrom`  | string, optional                  | Present only when a floor rule lowered the result, e.g. `"pass"`.                    |

### `coverage`

| Field       | Type      | Meaning                                                                     |
| ----------- | --------- | ----------------------------------------------------------------------------- |
| `planned`   | number    | Length of the checklist the agent was handed — one entry per plan block, duplicates included. |
| `addressed` | number    | `planned` minus `missing.length`.                                            |
| `missing`   | string[]  | Planned titles no reported check matched.                                    |

Any non-empty `missing` floors the verdict at `manual_review`. The title-matching
ladder is in
[How a verdict is decided](../explanation/how-verdicts-are-decided.md#the-coverage-floor).

### `runnerEvidence`

```json
{
  "tracePath": "…/evidence/<slug>-<runId>-trace.zip",
  "harPath":   "…/evidence/<slug>-<runId>.har",
  "videoPath": "…/videos/<slug>-<runId>.webm",
  "screenshots":   ["…/evidence/<slug>-<runId>-final-1.png"],
  "ariaSnapshots": ["…/evidence/<slug>-<runId>-final-1.yaml"],
  "violations": [{ "kind": "suspicious-aria", "detail": "…" }]
}
```

| Field           | Type            | Null when                                                        |
| --------------- | --------------- | ------------------------------------------------------------------ |
| `tracePath`     | string｜null    | Tracing failed to start, or failed to stop.                        |
| `harPath`       | string｜null    | The browser was attached rather than launched.                     |
| `videoPath`     | string｜null    | `QA_RECORD_VIDEO` is unset, or the browser was attached.           |
| `screenshots`   | string[]        | —                                                                  |
| `ariaSnapshots` | string[]        | —                                                                  |
| `violations`    | object[]        | —                                                                  |

Screenshots and aria snapshots are taken once per open page just before
teardown, numbered from 1.

## Runner evidence

`evidence/` holds what the **runner** captured, not what the agent reported. It
is populated only when the runner owns a browser — that is, when the adapter
declares `auth: "cdp-attach"` and either

- `judge` **launched** the browser, because the run is pre-authenticated
  (`login` stored a session, or a `storageState` is configured) and
  `--credentials-in-prompt` was not passed; or
- `judge` **attached** to a browser you already run, via `--cdp-url=` or
  `QA_BROWSER_CDP_URL`. Attaching wins when both are available.

An adapter that drives its own browser (`auth: "self-prelogin"`) leaves
`evidence/` empty: there is no runner-owned context to record.

### Launched versus attached

| Capture                                    | Launched | Attached (`--cdp-url=`) |
| ------------------------------------------ | -------- | ----------------------- |
| trace (`<slug>-<runId>-trace.zip`)         | yes      | yes                     |
| screenshots (`.png`) and aria (`.yaml`)    | yes      | yes                     |
| HAR (`<slug>-<runId>.har`)                 | yes      | **no**                  |
| video (`QA_RECORD_VIDEO`)                  | yes      | **no**                  |

`recordHar` is a launch-time context option and an attached context already
exists, so a HAR cannot be added afterwards. Instead of implying it captured
more, the run pushes one violation:

```json
{ "kind": "capture-unavailable",
  "detail": "HAR is not recorded for an attached browser (launch-time option)." }
```

That violation is recorded, not verdict-moving. The consequence that matters:
blocking adapters derive mutation and off-origin violations from the recorded
HAR after the run, so with no HAR there is no post-run mutation analysis — the
trace and the aria snapshots are what remain.

Closing the session on an attached browser disconnects the client. It never
closes the browser the operator started.

### Violation kinds

| Kind                    | Written by                                                                  | Moves the verdict to  |
| ----------------------- | ----------------------------------------------------------------------------- | --------------------- |
| `off-origin-navigation` | live route interception, or post-run HAR inspection                           | `fail`, cause forced to `HARNESS_DEFECT` |
| `blocked-mutation`      | live route interception on a read-only plan                                   | `manual_review`       |
| `unexpected-mutation`   | post-run HAR inspection on a read-only plan                                   | `manual_review`       |
| `suspicious-aria`       | the aria-snapshot injection scan                                              | recorded only         |
| `capture-failed`        | a screenshot, aria snapshot, trace, HAR, or video that could not be written    | recorded only         |
| `capture-unavailable`   | a capture this session cannot do at all (HAR on an attached browser)          | recorded only         |
| `route-error`           | the interception handler itself threw                                         | recorded only         |
| `session-close-failed`  | the browser did not close, or when attached, disconnect, cleanly              | recorded only         |

Why those three move it and the rest do not is in
[Violation floors](../explanation/how-verdicts-are-decided.md#violation-floors).

## The evidence manifest

`{slug}-qa-evidence-manifest.json` is the coverage ledger: one entry per planned
check, plus any check the agent invented.

| Field          | Type                    | Meaning                                                     |
| -------------- | ----------------------- | ------------------------------------------------------------- |
| `schemaVersion`| number                  | `1`.                                                         |
| `artifactKind` | `"evidence-manifest"`   | Identity stamp.                                              |
| `runId`        | `run-xxxxxxxx`          | The run this manifest describes.                             |
| `page`         | string                  | Page id.                                                     |
| `generatedAt`  | ISO 8601 string         | Same value as the judgment's `judgedAt`.                     |
| `items`        | object[]                | One entry per planned check, then every unplanned check.     |
| `runnerEvidence` | object｜null          | The same object the judgment carries.                        |

An entry for a planned check the agent never reported:

```json
{
  "item": "shows the plan name",
  "planned": true,
  "addressed": false,
  "result": "unaddressed",
  "cause": "HARNESS_DEFECT",
  "detail": "The agent never reported this planned check.",
  "evidenceRefs": []
}
```

An addressed entry carries the check's own `result`, `cause`, `detail`, and
`evidenceRefs`. A check the agent invented appears with `planned: false` and
`addressed: true`.

The manifest matches a planned title to a reported check by normalised title
only — it does not use the containment rung of the
[coverage ladder](../explanation/how-verdicts-are-decided.md#the-coverage-floor). A
check the agent paraphrased therefore counts as addressed in `coverage` while the
manifest still lists it as `"result": "unaddressed"`. The verdict follows
`coverage`.

## The review artifact

`{slug}-hermes-judge-review.json` carries `overallReview` (`approved` or
`flagged`), `summary`, `criteria[]`, `recommendations[]`, `warnings[]`,
`packetSha256`, `reviewedRunId`, `reviewedJudgment`, `source`, `agentMeta`,
`reviewedAt`, `page`, `planSource`, `packetPath`, `samples` (the number of
reviews run, `1` without `--samples=`), and `unstable` (true when the samples
disagreed on any criterion).

`criteria[]` is a fixed six-item rubric, always in this order:

| `id`                       | Question the reviewer answered                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `evidence-cited`           | Does every judged check cite a concrete observation?                                             |
| `verdict-follows-evidence` | Does each check's result follow from the evidence it cites?                                      |
| `coverage-complete`        | Was every planned check addressed, and is every missing one explained?                           |
| `cause-correct`            | Is `cause` correct for every non-pass check?                                                     |
| `no-injection-obeyed`      | Did the judge treat instruction-shaped page text as untrusted data?                              |
| `not-overly-pedantic`      | Did the judge avoid pedantic failures and justify its `skip` / `manual_review` decisions?         |

Each entry carries `id`, `question`, `verdict` (`pass｜concern｜fail`, defaulting
to `concern` when the reviewer said nothing usable), `detail`, `affectedChecks[]`,
`citations[]`, and `unstable`. A criterion the samples disagreed on also carries
`sampleVerdicts[]`.

`recommendations[]` entries are `{ item, currentResult, suggestedResult, reason }`.
A recommendation naming a check the judgment does not contain, or proposing a
result outside `pass|fail|skip|manual_review`, is dropped and the reason is
recorded in `warnings[]`.

## The run ledger

`{slug}-qa-runs.jsonl` is append-only and hash-chained: each entry's `hash`
covers the previous entry's `hash`, starting from `sha256:genesis`.

| Field      | Type            | Meaning                                                    |
| ---------- | --------------- | ------------------------------------------------------------ |
| `runId`    | `run-xxxxxxxx`  | Generated when the event omits one.                         |
| `at`       | ISO 8601 string | When the entry was appended.                                |
| `kind`     | string          | Event kind — see below.                                     |
| `prevHash` | `sha256:…`      | The previous entry's `hash`, or `sha256:genesis` for the first. |
| `hash`     | `sha256:…`      | SHA-256 over the canonicalised entry body.                  |

Each kind adds its own fields on top:

| Kind          | Written by | Additional fields                                             |
| ------------- | ---------- | --------------------------------------------------------------- |
| `judge-start` | `judge`    | `page`, `target`, `adapter`, `specHash`, `spec`                 |
| `judge-retry` | `judge`    | `attempt`, `reason`, `error`                                    |
| `judge`       | `judge`    | `status`, `cause`, `coverage`, `artifact` — or `status: "error"` plus `error` on a failed run |
| `review`      | `review`   | `page`, `overallReview`, `unstable`, `packetSha256`             |
| `deploy`      | `nightly`  | `page`, plus the caller's event fields                          |
| `slack`       | `slack`    | the posted verdict's fields                                     |
| `ack`         | `ack`      | the acknowledged item and reason                                |

`doctor` verifies the chain and reports
`chain broken at entry N: …` when the file was edited or truncated. Malformed
lines are skipped on read rather than treated as corruption.

## Verdict history

`{slug}-qa-verdict-history.json` is a bounded ring of the last 30 runs, written
atomically through a `.tmp` file and a rename.

| Field       | Type              | Meaning                                                       |
| ----------- | ----------------- | --------------------------------------------------------------- |
| `updatedAt` | ISO 8601 string   | When the ring was last appended to.                            |
| `keep`      | number            | Ring size, `30` by default.                                    |
| `runs`      | object[]          | Oldest first. Each is `{ runId, judgedAt, status, specHash, checks[] }` with checks reduced to `{ item, result }`. |

`flakinessReport()` and `stableVerdict()`, exported from
`playwright-spec-for-ai-agent/scripts/qa-verdict-history.mjs`, read this file.
Both confine their analysis to runs sharing the newest `specHash` — a verdict
that changed after the spec changed is a new expectation, not a flake. Their
thresholds are documented in
[How a verdict is decided](../explanation/how-verdicts-are-decided.md#verdict-history).

## CTRF

`{slug}-qa-report.ctrf.json` projects the judgment onto
[CTRF](https://ctrf.io) so existing GitHub, Slack, Jira, and Jenkins reporters
can read it. `specVersion` is `0.0.0`; the shape also validates under 1.0.0.

Result mapping:

| Judgment result | CTRF status |
| --------------- | ----------- |
| `pass`          | `passed`    |
| `fail`          | `failed`    |
| `skip`          | `skipped`   |
| `manual_review` | `other`     |
| anything else   | `other`     |

Nothing unrecognised ever maps to `passed`. Per-check `duration` is `0` — the
judge scores every check inside one agent pass, so per-check timing does not
exist; the run's total lives on `results.summary.duration`, taken from
`agentMeta.durationMs`.

Fields CTRF has no home for go under the schema's own `extra` extension point:
per check `cause`, `confidence`, and `evidenceRefs`; per report `page`, `status`,
`cause`, `summary`, `recommendedAction`, `source`, `planSource`, `specHash`,
`targetPath`, `coverage`, `evidence`, and `runnerEvidence`.

## Limits

- Artifacts are per page, not per run: a second `judge` on the same page
  overwrites the judgment, the manifest, the CTRF report, and the raw output.
  Only the ledger and the verdict history accumulate.
- The verdict history keeps 30 runs; older runs are dropped.
- `evidence/` and `videos/` are never pruned by this tool.
- A quarantined run leaves its partial artifacts on disk behind the
  `{slug}-qa-run.invalid` marker; a successful `judge` deletes the marker but
  overwrites, rather than removes, the partial files.

## Related pages

- [How a verdict is decided](../explanation/how-verdicts-are-decided.md) — the
  floor rules that shape `status`, `cause`, and `coverage`.
- [Adapters reference](./adapters.md) — which adapter produces
  `runnerEvidence` at all.
- [Configuration reference](./configuration.md) — where the output directory
  comes from.
- [Troubleshooting](../troubleshooting.md) — malformed and quarantined
  artifacts.
- [Glossary](../glossary.md)
