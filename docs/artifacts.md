# Artifacts

Everything a run produces lands in one directory per page — by default
`src/page/{page}/__QA__/`, overridable with `paths.outputDir`,
`pages.{page}.outputDir`, `--output-dir=`, or `QA_OUTPUT_DIR`. `{slug}` below is
the page id with `/` replaced by `-`.

## The files

| File                                     | Written by     | Read by                                    |
| ---------------------------------------- | -------------- | ------------------------------------------ |
| `{slug}-qa-spec.json`                    | `spec`         | `abstract-ai`, `judge`, `nightly`, `show`  |
| `{slug}-qa-spec-abstracted.json`         | `spec`         | `abstract-ai` (preferred input)            |
| `{slug}-qa-spec-live.json`               | `abstract-ai`  | `judge`, `nightly` (reuse check)           |
| `{slug}-qa-spec-live.md`                 | `abstract-ai`  | `judge` (the plan), `review` (fallback)    |
| `{slug}-qa-abstract-audit.json`          | `abstract-ai`  | `abstract-ai` (reuse bookkeeping)          |
| `{slug}-hermes-abstract-query.txt`       | `abstract-ai`  | humans; `--dry-run` writes only this       |
| `{slug}-hermes-abstract-raw-output.txt`  | `abstract-ai`  | humans, when output is unusable            |
| `{slug}-qa-judge-plan.md`                | `judge`        | `review` (the pinned plan)                 |
| `{slug}-hermes-query.txt`                | `judge`        | humans (secrets redacted)                  |
| `{slug}-hermes-raw-output.txt`           | `judge`        | humans (secrets redacted)                  |
| `{slug}-hermes-judgment.json`            | `judge`        | `review`, `slack`, `report`, `show`, `ack`, `doctor`, `nightly` |
| `{slug}-hermes-judgment.md`              | `judge`        | humans                                     |
| `{slug}-qa-evidence-manifest.json`       | `judge`        | humans                                     |
| `{slug}-qa-report.ctrf.json`             | `judge`        | any CTRF-consuming reporter                |
| `{slug}-qa-verdict-history.json`         | `judge`        | flakiness / stable-verdict analysis        |
| `{slug}-qa-runs.jsonl`                   | every stage    | `report`, `review` packet, `doctor`        |
| `{slug}-qa-run.invalid`                  | `judge` (on failure) | `review`, `slack`, `report`, `show`, `doctor` |
| `{slug}-hermes-judge-review-packet.md`   | `review`       | humans (the reviewer's exact input)        |
| `{slug}-hermes-judge-review-query.txt`   | `review`       | humans                                     |
| `{slug}-hermes-judge-review-raw-output.txt` | `review`    | humans (`-sampleN.txt` with `--samples=`)  |
| `{slug}-hermes-judge-review.json`        | `review`       | `slack`, `report`, `show`                  |
| `{slug}-hermes-judge-review.md`          | `review`       | humans                                     |
| `{slug}-qa-ack.json`                     | `ack`          | `slack`                                    |
| `evidence/`                              | `judge` runner | `review` packet, `show`                    |
| `videos/`                                | `judge` runner (`QA_RECORD_VIDEO`) | humans                 |

`evidence/` holds what the **runner** captured, not what the agent reported:
`<slug>-<runId>.har`, `<slug>-<runId>-trace.zip`, and per open page
`<label>-<n>.png` plus `<label>-<n>.yaml` (a sanitised aria snapshot). It is
populated only when the runner owns a browser — that is, when the adapter
declares `auth: "cdp-attach"` and either

- `judge` **launched** the browser: `authRequired` is on,
  `--credentials-in-prompt` was not passed, and `login` has stored a session (or
  a `storageState` is configured); or
- `judge` **attached** to one you already run, via `--cdp-url=` /
  `QA_BROWSER_CDP_URL`. Attaching wins when both are available.

An adapter that drives its own browser (`auth: "self-prelogin"`) leaves
`evidence/` empty: there is no runner-owned context to record.

### Attached browsers capture less

Evidence from an attached browser is narrower than from a launched one, and the
run records the gap instead of implying it captured more:

| Capture                    | Launched | Attached (`--cdp-url`) |
| -------------------------- | -------- | ---------------------- |
| trace (`-trace.zip`)       | yes      | yes                    |
| screenshots + aria (`.png`/`.yaml`) | yes | yes                |
| HAR (`.har`)               | yes      | **no**                 |
| video (`QA_RECORD_VIDEO`)  | yes      | no                     |

HAR recording is a launch-time context option and the attached context already
exists, so it cannot be added afterwards. The run pushes one violation instead:

```json
{ "kind": "capture-unavailable",
  "detail": "HAR is not recorded for an attached browser (launch-time option)." }
```

It is recorded, not verdict-moving. The practical consequence is in
[verdicts.md](./verdicts.md#violation-floors): blocking adapters derive
mutation and off-origin violations from the recorded HAR after the run, so with
no HAR there is no post-run mutation analysis — the trace and the aria snapshots
are what remain.

Closing the session on an attached browser disconnects the client. It never
closes the browser the operator started.

## The judgment contract

`{slug}-hermes-judgment.json` is the artifact everything downstream reads.

| Field               | Type                     | Meaning                                                                    |
| ------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `schemaVersion`     | number                   | Currently `1`. A higher number is refused, not guessed at.                 |
| `artifactKind`      | `"judgment"`             | Identity stamp.                                                            |
| `runId`             | `run-xxxxxxxx`           | Ties the judgment to its ledger entries.                                   |
| `page`              | string                   | Page id.                                                                   |
| `judgedAt`          | ISO 8601                 | When the verdict was written.                                              |
| `targetUrl`         | string                   | The absolute URL that was judged.                                          |
| `targetPath`        | string                   | Display path for that URL.                                                 |
| `planSource`        | string                   | Which plan the judge used (`spec-live.md`, or a fallback).                 |
| `specHash`          | `sha256:…`               | Hash of the raw `spec` artifact this plan descends from.                   |
| `status`            | `pass｜fail｜manual_review` | The verdict, after the floor rules.                                      |
| `cause`             | see below                | Failure taxonomy for the run.                                              |
| `summary`           | string                   | Agent summary, plus `Verdict floor applied — …` when a rule fired.         |
| `recommendedAction` | string                   | What the agent suggests a human do.                                        |
| `source`            | string                   | Adapter name (`hermes-agent` for hermes).                                  |
| `agentMeta`         | object                   | `{ adapter, model, durationMs }`, omitted when the adapter reported none.  |
| `checks[]`          | array                    | Per-check results — see below.                                             |
| `coverage`          | object                   | `{ planned, addressed, missing[] }`.                                       |
| `evidence[]`        | string[]                 | The agent's free-text evidence notes.                                      |
| `runnerEvidence`    | object｜null             | What the harness captured — see below.                                     |

Violations detected during the run are not a separate top-level field. The ones
the browser layer saw are in `runnerEvidence.violations`; the ones derived from
post-run HAR inspection reach you through the `Verdict floor applied — …` note
appended to `summary`.

`cause` is one of `PRODUCT_DEFECT`, `SPEC_GAP`, `ENVIRONMENT_DEFECT`,
`HARNESS_DEFECT`, `NONE`.

### `checks[]`

| Field          | Meaning                                                                            |
| -------------- | ----------------------------------------------------------------------------------- |
| `item`         | The exact planned check title. Defaults to `"Untitled check"`.                      |
| `detail`       | What the agent observed. This is what the evidence rule reads.                      |
| `result`       | `pass｜fail｜skip｜manual_review`. An unrecognised value becomes `manual_review`.    |
| `confidence`   | `high｜medium｜low`. Missing means `medium`, not low.                               |
| `cause`        | Per-check cause. `pass` → `NONE`; a non-pass with no valid cause → `HARNESS_DEFECT`.|
| `evidenceRefs` | Artifact filenames or paths backing the check. `[]` when there are none.            |
| `demotedFrom`  | Present only when a floor rule lowered the result, e.g. `"pass"`.                   |

### `runnerEvidence`

```json
{
  "tracePath": "…/evidence/<slug>-<runId>-trace.zip",
  "harPath":   "…/evidence/<slug>-<runId>.har",
  "videoPath": "…/videos/<slug>-<runId>.webm",
  "screenshots":   ["…/evidence/<label>-1.png"],
  "ariaSnapshots": ["…/evidence/<label>-1.yaml"],
  "violations": [{ "kind": "suspicious-aria", "detail": "…" }]
}
```

On an attached browser `harPath` and `videoPath` are always `null`.

Violation kinds:

| Kind                    | Written by                                              |
| ----------------------- | -------------------------------------------------------- |
| `off-origin-navigation` | live route interception, or post-run HAR inspection      |
| `blocked-mutation`      | live route interception on a read-only plan              |
| `unexpected-mutation`   | post-run HAR inspection on a read-only plan              |
| `suspicious-aria`       | aria-snapshot scan                                       |
| `capture-failed`        | a screenshot, aria snapshot, trace, HAR, or video that could not be written |
| `capture-unavailable`   | a capture this session cannot do at all (HAR on an attached browser) |
| `route-error`           | the interception handler itself threw                    |
| `session-close-failed`  | the browser did not close (or, when attached, disconnect) cleanly |

Which of them move the verdict is in [verdicts.md](./verdicts.md).

## The evidence manifest

`{slug}-qa-evidence-manifest.json` is the coverage ledger: one entry per planned
check, plus any check the agent invented.

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

An unplanned check appears with `planned: false`.

The manifest matches a planned title to a reported check by normalised title
only — it does not use the containment rung of the
[coverage ladder](./verdicts.md#coverage-floor). A check the agent paraphrased
therefore counts as addressed in `coverage` while the manifest still lists it as
`"result": "unaddressed"`. The verdict follows `coverage`.

## The review artifact

`{slug}-hermes-judge-review.json` carries `overallReview` (`approved` or
`flagged`), `summary`, `criteria[]`, `recommendations[]`, `warnings[]`,
`packetSha256`, `reviewedRunId`, `reviewedJudgment`, `source`, `agentMeta`,
`reviewedAt`, and — with `--samples=N` — `samples` and `unstable`.

`criteria[]` is a fixed six-item rubric, always in this order:
`evidence-cited`, `verdict-follows-evidence`, `coverage-complete`,
`cause-correct`, `no-injection-obeyed`, `not-overly-pedantic`. Each has
`verdict` (`pass｜concern｜fail`), `detail`, `affectedChecks[]`, `citations[]`.

`recommendations[]` entries are `{ item, currentResult, suggestedResult, reason }`.
A recommendation naming a check the judgment does not contain, or proposing a
result outside `pass|fail|skip|manual_review`, is dropped and the reason is
recorded in `warnings[]`.

## The run ledger

`{slug}-qa-runs.jsonl` is append-only and hash-chained: each entry's `hash`
covers the previous entry's `hash`, starting from `sha256:genesis`. Every entry
carries `runId`, `at`, `kind`, `prevHash`, `hash`.

Kinds written today: `judge-start`, `judge-retry`, `judge`, `deploy`, `slack`,
`ack`. `doctor` verifies the chain and reports
`chain broken at entry N: …` when it was edited or truncated.

## Verdict history

`{slug}-qa-verdict-history.json` is a bounded ring of the last 30 runs, written
atomically. Each entry is `{ runId, judgedAt, status, specHash, checks[] }` with
checks reduced to `{ item, result }`. Flakiness and stable-verdict analysis only
compare runs sharing the newest `specHash` — a verdict that changed after the
spec changed is a new expectation, not a flake.

## CTRF

`{slug}-qa-report.ctrf.json` projects the judgment onto
[CTRF](https://ctrf.io) so existing GitHub/Slack/Jira/Jenkins reporters can read
it. Result mapping: `pass→passed`, `fail→failed`, `skip→skipped`,
`manual_review→other`; anything unrecognised maps to `other`, never `passed`.
Per-check `duration` is `0` — the judge scores every check inside one agent
pass, so per-check timing does not exist; the run's total lives on the summary.
Fields CTRF has no home for (cause, confidence, evidence refs, coverage,
`specHash`, `planSource`, `runnerEvidence`) go under the schema's own `extra`
extension point.
