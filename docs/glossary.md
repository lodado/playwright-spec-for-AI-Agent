# Glossary

Look up a term this documentation uses with a specific meaning. Each definition
stands on its own; the link goes to the page that explains it in full.

## ack

An acknowledgement recorded against one check title in the latest judgment, with
a mandatory `--reason=` and an expiry that defaults to 14 days out. An
acknowledged check stops appearing in the Slack alert body; it does not change
the verdict. Stored in `{slug}-qa-ack.json`.
See [How a verdict is decided](./explanation/how-verdicts-are-decided.md).

## adapter

The agent backend a stage calls, selected with `QA_AI_ADAPTER`. Built-ins are
`hermes`, `aside`, `exec`, and `fixture`; any module exporting
`run(query, maxTurns, options)` also qualifies. Every adapter exposes the same
one-function seam, so `abstract-ai`, `judge`, and `review` never know which
backend ran.
See [Adapters reference](./reference/adapters.md).

## allowed origins

The origins a run may navigate to, from `staging.allowedOrigins` or
`pages.{page}.allowedOrigins`. Navigating outside them records an
`off-origin-navigation` violation, which fails the run. A page with its own
`baseUrl` does not inherit the global list.
See [Configuration reference](./reference/configuration.md).

## attached browser

A browser the operator started and signed into, which `judge` borrows over CDP
via `--cdp-url=` or `QA_BROWSER_CDP_URL`. It is the path for identity providers
that refuse automation-controlled browsers. An attached browser records a trace,
screenshots, and aria snapshots, but no HAR and no video.
See [Authenticate a judge run](./how-to/authentication.md).

## capability descriptor

The five-field object an adapter declares — `auth`, `supportsMaxTurns`,
`supportsToolsetDisable`, `supportsVideo`, `blocksEventLoop` — that the harness
branches on instead of on the adapter's name.
See [Adapters reference](./reference/adapters.md#capability-descriptor).

## cause

The failure taxonomy carried by a judgment and by each of its checks: one of
`PRODUCT_DEFECT`, `SPEC_GAP`, `ENVIRONMENT_DEFECT`, `HARNESS_DEFECT`, or `NONE`.
It separates "the app is wrong" from "the run never reached the app".
See [How a verdict is decided](./explanation/how-verdicts-are-decided.md#the-cause-taxonomy).

## check

One entry the agent reported in `judgment.checks[]`: a title, what it observed, a
result, a confidence, a cause, and any evidence references. Compare
[planned check](#planned-check).
See [Artifacts reference](./reference/artifacts.md#checks).

## coverage

The `{ planned, addressed, missing[] }` object recording how much of the
checklist the agent actually answered. Any unaddressed planned check floors the
verdict at `manual_review`.
See [How a verdict is decided](./explanation/how-verdicts-are-decided.md#the-coverage-floor).

## CTRF report

`{slug}-qa-report.ctrf.json`, the judgment projected onto the Common Test Report
Format so existing GitHub, Slack, Jira, and Jenkins reporters can read it.
Anything CTRF has no field for goes under its `extra` extension point.
See [Artifacts reference](./reference/artifacts.md#ctrf).

## evidence manifest

`{slug}-qa-evidence-manifest.json`, one entry per planned check plus every check
the agent invented, each marked `addressed` or `unaddressed`. It is the coverage
ledger a human reads; the verdict itself follows `coverage`.
See [Artifacts reference](./reference/artifacts.md#the-evidence-manifest).

## judgment

`{slug}-hermes-judgment.json`, the verdict artifact `judge` writes and every
downstream command reads: status, cause, summary, checks, coverage, and runner
evidence for one run of one page.
See [Artifacts reference](./reference/artifacts.md#the-judgment).

## live plan

`{slug}-qa-spec-live.md`, the Given/When/Then checklist `abstract-ai` writes from
the parsed spec and `judge` hands to the agent. It states what should be
observable on staging, not how to click.
See [Pipeline](./explanation/pipeline.md).

## live policy

The `@qa-live-policy` annotation on a test, which tells the judge how far it may
go on a live site — from `readonly` to `safe-interaction` to `skip`. Every parsed
test needs one. A plan containing an `executable-interaction` or
`judgment-interaction-no-confirm` test is not a read-only plan.
See [Annotations reference](./reference/annotations.md#live-policy-values).

## page

The unit everything is keyed by: a page id such as `dashboard` or
`settings/billing`. It selects a spec directory, an output directory, and a
target URL. `{slug}` in a filename is the page id with `/` replaced by `-`.
See [Configuration reference](./reference/configuration.md).

## planned check

One block of the live plan the agent was asked to answer. `coverage.planned`
counts one entry per block, duplicates included — the same title is legitimately
planned once per scenario.
See [How a verdict is decided](./explanation/how-verdicts-are-decided.md#the-coverage-floor).

## quarantine

The `{slug}-qa-run.invalid` marker `judge` drops when it fails after possibly
writing partial artifacts, or when the run-level cause is `ENVIRONMENT_DEFECT`.
`review` and `slack` refuse to report on a quarantined run; a successful `judge`
deletes the marker.
See [Troubleshooting](./troubleshooting.md#the-run-is-quarantined).

## review packet

`{slug}-hermes-judge-review-packet.md`, the reviewer's entire input: the pinned
plan, the judgment verbatim, the runner-captured filenames, the flagged
accessible names, and that run's ledger entries. The reviewer must echo the
packet's SHA-256 back, or its answer is rejected.
See [How a verdict is decided](./explanation/how-verdicts-are-decided.md#the-reviews-own-floor).

## run id

`run-` plus eight hex characters, generated per `judge` run. It ties the
judgment, the ledger entries, and the evidence filenames of one run together.
See [Artifacts reference](./reference/artifacts.md#the-run-ledger).

## run ledger

`{slug}-qa-runs.jsonl`, append-only and hash-chained: each entry's `hash` covers
the previous entry's `hash`, starting from `sha256:genesis`. `doctor` verifies
the chain, so an edited or truncated history is detectable.
See [Artifacts reference](./reference/artifacts.md#the-run-ledger).

## runner evidence

What the harness captured from a browser it owns — trace, HAR, video,
screenshots, aria snapshots, and violations — as opposed to what the agent said
about itself. It exists only for a `cdp-attach` adapter.
See [Artifacts reference](./reference/artifacts.md#runner-evidence).

## scenario

An account state a spec file is written for, declared with `// @qa-scenario: ID`
at the top of the file. `judge` picks one scenario matching the live account,
plus every scenario marked `@qa-always-run`.
See [Annotations reference](./reference/annotations.md).

## session profile

`.private/qa-browser-profile`, the owner-only Chromium profile that `login`
signs in once and `judge` relaunches headless. Its `.qa-session` marker is
written only when the cookie jar actually changed, so an aborted login is not
mistaken for a stored session.
See [Authenticate a judge run](./how-to/authentication.md).

## spec artifact

`{slug}-qa-spec.json`, the machine-readable form of the annotated Playwright
specs that `spec` parses. Nothing after `spec` reads your test code.
See [Pipeline](./explanation/pipeline.md).

## spec hash

The `sha256:` digest of the spec artifact, stamped onto everything derived from
it. `judge` refuses a plan generated from a different spec revision, and
`review` refuses a judgment whose hash disagrees with the plan's.
See [How a verdict is decided](./explanation/pipeline.md#the-provenance-chain).

## storage state

A Playwright storage-state JSON — cookies and `localStorage` — that a project's
e2e setup already writes, pointed at by `staging.storageState` or
`pages.{page}.storageState`. It is the session for apps that mint one in code
and have no login form to drive.
See [Authenticate a judge run](./how-to/authentication.md).

## target URL

The absolute URL a run judges, built from the resolved base URL plus the page's
`targetPath`, or taken whole from `pageUrl`. A placeholder hostname is refused
rather than judged.
See [Configuration reference](./reference/configuration.md).

## verdict

The run-level `status` of a judgment: `pass`, `fail`, or `manual_review`.
`manual_review` means a human has to look — the page was neither clearly correct
nor clearly broken.
See [How a verdict is decided](./explanation/how-verdicts-are-decided.md).

## verdict floor

A rule that may lower the agent's own verdict but never raise it. The floors are
per-check (low confidence, missing evidence, invalid cause), coverage, and
violations. A fired floor appends `Verdict floor applied — …` to the summary.
See [How a verdict is decided](./explanation/how-verdicts-are-decided.md).

## violation

Something the harness observed about the run itself rather than about the page:
an off-origin navigation, a write on a read-only plan, a capture that failed or
was unavailable, a route error, or an unclean session close. Three kinds move
the verdict; the rest are recorded.
See [Artifacts reference](./reference/artifacts.md#violation-kinds).

## Related pages

- [Documentation index](./README.md)
- [Troubleshooting](./troubleshooting.md)
- [CLI reference](./reference/cli.md)
