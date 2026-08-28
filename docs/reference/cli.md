# CLI reference

Every command of `playwright-spec-for-ai-agent`, with its own flags, defaults,
inputs, outputs, and exit codes. Written for an operator or a CI author who
already knows what the pipeline does and needs the exact invocation.

For what the stages mean, read
[the pipeline explanation](../explanation/pipeline.md). For a first run, follow
[Get started](../get-started.md).

## Invocation

```
npx playwright-spec-for-ai-agent <command> [options]
```

Eight pipeline commands run in this order: `spec`, `abstract-ai`, `login`,
`judge`, `review`, `slack`, `issues`, `nightly`. Six operator commands inspect
or rehearse a project: `doctor`, `show`, `report`, `handoff`, `ack`, `demo`.

Two conventions apply to every command:

- Each command also accepts the [global options](#global-options). The tables
  below list only that command's own flags.
- Artifacts are written to the page's output directory and prefixed with the
  page slug: page `dashboard` writes `dashboard-hermes-judgment.json`. The
  tables write this as `<page>-hermes-judgment.json`. See
  [Artifacts](./artifacts.md) for each file's contents.

Flags take their value with `=` (`--page=pricing`). The router also accepts the
space-separated form (`--page pricing`) for the flags it lists in `VALUE_FLAGS`
and rewrites them before spawning the stage script; see
[Router and stage-script drift](#router-and-stage-script-drift) for the flags it
does not rewrite.

## spec

Parses `@qa-scenario` annotations in a page's spec directory into two JSON
artifacts. Never runs Playwright.

| Option                     | Default | Required | Effect                                                                 |
| -------------------------- | ------- | -------- | ---------------------------------------------------------------------- |
| `--page=<slug>`            | —       | yes      | Page id. Missing `--page=` exits 2.                                    |
| `--allow-missing-fixtures` | off     | no       | Warn instead of failing when a `@qa-fixture` file does not exist.      |

Reads: every `*.spec.ts` in the resolved spec directory that carries a
`@qa-scenario` line and no `@qa-live-skip: true` line.

Writes: `<page>-qa-spec.json`, carrying the `specSourcesHash`, `parserVersion`,
`excluded`, and `unparsedTestCount` stamps that `abstract-ai` and `judge` compare
against.

Exit codes: 0 on success. 2 when `--page=` is missing, the spec directory does
not exist, a `@qa-fixture` file is missing, a test carries no
`@qa-live-policy`, or an annotation names an unknown policy.

Annotation syntax lives in [Annotations](./annotations.md).

## abstract-ai

Sends the annotated spec to the AI agent, which writes a Given/When/Then live
plan. The agent receives each test's title and its declared annotations, not the
Playwright body: the plan states the behaviour the check defends, and the body is
quoted later for the judge that verifies it.

| Option                  | Default | Required | Effect                                                          |
| ----------------------- | ------- | -------- | ---------------------------------------------------------------- |
| `--page=<slug>`         | —       | yes      | Page id.                                                        |
| `--dry-run`             | off     | no       | Write the prompt and stop before calling the agent.             |
| `--force`               | off     | no       | Regenerate even when the input hash is unchanged.               |

Reads: `<page>-qa-spec.json`.

Writes: `<page>-qa-spec-live.json`, `<page>-qa-spec-live.md`,
`<page>-qa-abstract-audit.json`, `<page>-hermes-abstract-query.txt`,
`<page>-hermes-abstract-raw-output.txt`.

Exit codes: 0 on success or on a skipped regeneration. 2 for usage errors.
3 when the agent CLI, model, or provider key is missing. 4 when the agent ran
but returned output the harness cannot use.

## login

Opens a headed browser on the staging login page so an operator signs in once.
`judge` then reuses that browser profile and needs no credentials.

| Option                | Default    | Required | Effect                                                                              |
| --------------------- | ---------- | -------- | ------------------------------------------------------------------------------------ |
| `--channel=<name>`    | bundled Chromium | no | Launch real Chrome or Edge (`chrome`, `msedge`). Providers that block automated browsers are likelier to accept it. |
| `--attach`            | off        | no       | Print the recipe for attaching to a browser you already run, then exit 0.           |
| `--base-url=<url>`    | `STAGING_QA_BASE_URL`, else config | no | Staging origin.                                              |
| `--login-path=<path>` | `STAGING_QA_LOGIN_PATH`, else config, else `/login` | no | Login page path.                                     |

Reads: nothing on disk.

Writes: a persistent browser profile at `.private/qa-browser-profile`,
owner-only. The command stores it only after the profile gains a session
cookie — Chromium creates the directory the moment the window opens, so its
existence proves nothing.

Exit codes: 0 when a session was stored, or after `--attach` printed the
recipe. 3 when the browser window closed without any new session cookie.

The three session paths, and when to pick each, are in
[Authenticate a run](../how-to/authentication.md).

## judge

Opens the target page in a browser through the AI agent and judges the live DOM
against the live plan.

| Option                                    | Default  | Required | Effect                                                                                     |
| ----------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------- |
| `--page=<slug>`                           | —        | yes      | Page id.                                                                                   |
| `--target-path=<path>`                    | config   | no       | Staging path. Wins over `pages.{page}.pageUrl` and `pages.{page}.targetPath`.             |
| `--base-url=<url>`                        | `STAGING_QA_BASE_URL`, else config | no | Staging origin.                                                          |
| `--login-path=<path>`                     | `STAGING_QA_LOGIN_PATH`, else config, else `/login` | no | Login page path.                                        |
| `--email=<address>`                       | `STAGING_QA_EMAIL` | no | Staging account email. Unused when a session path is configured.                       |
| `--password=<secret>`                     | `STAGING_QA_PASSWORD` | no | Staging account password. Unused when a session path is configured.                 |
| `--auth-required=false`                   | `true`   | no       | Skip login for a public target page.                                                       |
| `--credentials-in-prompt`                 | off      | no       | Legacy: embed credentials in the agent prompt instead of using the login session.          |
| `--expected-plan=<plan>`                  | config   | no       | Plan label the scenarios assume.                                                           |
| `--expected-subscription-status=<status>` | config   | no       | Expected account state, uppercased. `--expected-account-state=` is the current name.       |
| `--account-notes=<text>`                  | config   | no       | Free text forwarded verbatim into the agent prompt.                                        |
| `--cdp-url=<url>`                         | `QA_BROWSER_CDP_URL` | no | Judge through a browser you already run and signed into.                              |
| `--fail-on=<mode>`                        | `fail`   | no       | `fail` \| `manual_review` \| `never` — which verdict exits 1.                              |
| `--non-interactive`                       | off in a TTY | no   | Skip prompts. `--yes` and `-y` are aliases; `CI=true` has the same effect.                 |
| `--dry-run`                               | off      | no       | Write the prompt and plan, then stop before calling the agent.                             |

Reads: `<page>-qa-spec-live.md`.

Writes: `<page>-hermes-judgment.json`, `<page>-hermes-judgment.md`,
`<page>-qa-judge-plan.md`, `<page>-hermes-query.txt`,
`<page>-hermes-raw-output.txt`, `<page>-qa-evidence-manifest.json`,
`<page>-qa-report.ctrf.json`, `<page>-qa-verdict-history.json`, an appended
`<page>-qa-runs.jsonl`, an `evidence/` directory, and a `videos/` directory when
`QA_RECORD_VIDEO` is set. Appends markdown to `$GITHUB_STEP_SUMMARY` when that
variable is set.

Exit codes: 0 when the verdict passes the `--fail-on` gate. 1 when it does not.
2 for usage errors, including an unknown `--fail-on` value. 3 when the agent
backend, credentials, or staging origin are unusable. 4 when the agent returned
unusable output.

How a verdict is reached, and which floors can downgrade it, is in
[How verdicts are decided](../explanation/how-verdicts-are-decided.md).

## review

Re-reviews the judgment with a second agent pass that does not browse: it reads
the plan, the judgment, the captured evidence, and the run ledger.

| Option                 | Default | Required | Effect                                                                     |
| ---------------------- | ------- | -------- | ---------------------------------------------------------------------------- |
| `--page=<slug>`        | —       | yes      | Page id.                                                                   |
| `--target-path=<path>` | config  | no       | Staging path, used to label the review.                                    |
| `--samples=<n>`        | `1`     | no       | Integer 1–9. Runs the review `n` times and takes a per-criterion majority. |
| `--dry-run`            | off     | no       | Write the prompt and stop before calling the agent.                        |

Reads: `<page>-qa-judge-plan.md` (falling back to `<page>-qa-spec-live.md`) and
`<page>-hermes-judgment.json`.

Writes: `<page>-hermes-judge-review.json`, `<page>-hermes-judge-review.md`,
`<page>-hermes-judge-review-query.txt`, and
`<page>-hermes-judge-review-raw-output.txt` — one raw file per sample, suffixed
`-sample1`, `-sample2`, … when `--samples=` is above 1.

Exit codes: 0 when the review is clean. 1 when the overall review is `flagged`,
when samples disagreed (`unstable`), or when any criterion is `fail` or
`concern`. 2 when `--samples=` is not an integer from 1 to 9, or the judgment
artifact is missing. 3 and 4 as for `judge`.

## slack

Posts the stored verdict to a Slack incoming webhook.

| Option                 | Default    | Required | Effect                                          |
| ---------------------- | ---------- | -------- | ------------------------------------------------- |
| `--page=<slug>`        | —          | yes      | Page id.                                        |
| `--notify=<mode>`      | `failures` | no       | `failures` \| `always` \| `never`.              |
| `--base-url=<url>`     | config     | no       | Origin used to build the link in the message.   |

`--notify=failures` posts on every status that is not `pass`, because a skipped
or unrecognised verdict means nothing was verified.

Reads: `<page>-hermes-judgment.json`, `<page>-hermes-judge-review.json` when it
exists, `<page>-qa-ack.json`, and the `<page>-qa-run.invalid` quarantine marker.
Requires `SLACK_WEBHOOK_URL`.

Writes: appends a `slack` event to `<page>-qa-runs.jsonl`.

Exit codes: 0 after posting or after deliberately not posting. 2 when
`--page=` is missing, no target path resolves for the page, `--notify=` names
an unknown mode, or `<page>-hermes-judgment.json` does not exist. 3 when
`SLACK_WEBHOOK_URL` is unset, the webhook rejects the post, or the run is
quarantined.

## nightly

Runs `spec` → `abstract-ai` → `judge` → `review` → optional `slack` for one page
or many.

| Option                 | Default | Required        | Effect                                                                          |
| ---------------------- | ------- | --------------- | --------------------------------------------------------------------------------- |
| `--page=<slug>`        | —       | one of the three | Run this page.                                                                  |
| `--pages=<a,b>`        | —       | one of the three | Run these pages sequentially.                                                   |
| `--all`                | off     | one of the three | Run every page in the config's `pages` and legacy `targetPaths` blocks.        |
| `--target-path=<path>` | config  | no              | Single page only. Ignored for `--pages=` and `--all`, where config decides.     |
| `--with-slack`         | off     | no              | Run the `slack` stage on `fail` and `manual_review`.                            |
| `--with-issues`        | off     | no              | Run the `issues` stage after `review` for each page.                            |
| `--review-on=<mode>`   | `fail`  | no              | `always` \| `fail` \| `never` — when to run the review stage.                   |
| `--skip-review`        | off     | no              | Alias of `--review-on=never`.                                                   |
| `--skip-abstract-ai`   | off     | no              | Reuse the existing live plan.                                                   |
| `--force-abstract`     | off     | no              | Re-run `abstract-ai` even when the spec hash is unchanged.                       |
| `--force-judge`        | off     | no              | Judge even when `versionUrl` reports an already-passed build.                    |
| `--non-interactive`    | off in a TTY | no         | Forwarded to `judge`.                                                            |

Every argv entry `nightly` does not consume itself is forwarded to the stage
scripts, so `--fail-on=`, `--samples=`, `--notify=`, and `--strict-config` reach
the stage that parses them.

Reads and writes: whatever its stages read and write.

Exit codes: the **worst** code any stage returned, ranked
0 < 1 < 2 < 4 < 3, with an unrecognised code ranked worse than all of them. A
verdict failure and an infrastructure failure never collapse into one code.

## doctor

Checks config, specs, agent backend, credentials, and stored artifacts before a
run costs agent time.

| Option            | Default             | Required | Effect                                             |
| ----------------- | ------------------- | -------- | ---------------------------------------------------- |
| `--page=<slug>`   | every configured page | no     | Check only this page.                              |
| `--json`          | off                 | no       | Machine-readable report on stdout.                 |
| `--check-network` | off                 | no       | Also fetch each target URL (HEAD/GET, 10s timeout).|

Reads: the project config, the spec directories, `~/.hermes/config.yaml` and
`~/.hermes/.env` for the Hermes provider check, and the stored artifacts.

Writes: nothing.

Exit codes: 0 when every required check passes. 3 otherwise. Config warnings
that other commands print above their output are captured into the table here.

## show

Prints the latest verdict, per-check table, coverage, and artifact paths for one
page.

| Option                  | Default | Required | Effect                                       |
| ----------------------- | ------- | -------- | ---------------------------------------------- |
| `--page=<slug>`         | —       | yes      | Page id.                                     |
| `--json`                | off     | no       | Machine-readable report on stdout.           |
| `--checks-only`         | off     | no       | Print only the per-check table.               |
| `--failed`              | off     | no       | Print only checks whose result is not `pass`. |
| `--evidence`            | off     | no       | Print artifact and evidence paths only.       |

Reads: the page's stored artifacts. A missing artifact is listed under
`Missing:` rather than failing the command.

Writes: nothing.

Exit codes: 0. 2 when `--page=` is missing.

## report

Renders one table over every configured page's latest judgment.

| Option               | Default             | Required | Effect                                              |
| -------------------- | ------------------- | -------- | ----------------------------------------------------- |
| `--pages=<a,b>`      | every configured page | no     | Report only these pages.                            |
| `--format=<md｜json>` | `md`                | no       | Output format.                                      |
| `--out=<path>`       | —                   | no       | Also write the rendered report to this file.        |
| `--fail-on=<mode>`   | `fail`              | no       | `fail` \| `manual_review` \| `never`.               |

Reads: each page's stored judgment.

Writes: the rendered report to stdout, to `--out=` when given, and appended to
`$GITHUB_STEP_SUMMARY` when that variable is set.

Exit codes: 0 when no page fails the `--fail-on` gate. 1 when a page fails on
its verdict. 3 when a failing page is `quarantined` or `unreadable`, because
that is an infrastructure failure rather than a verdict. 2 when no pages resolve
or a value flag is invalid.

## issues

Files one GitHub issue per page whose verdict still needs someone to act, using
the `handoff` document as the body. It reuses an open issue rather than filing a
new one each night, and closes it when a later run passes.

| Option              | Default      | Required | Effect                                                              |
| ------------------- | ------------ | -------- | --------------------------------------------------------------------- |
| `--page=<slug>`     | —            | no       | One page. Without it, `--pages=` or every configured page.          |
| `--pages=<a,b>`     | every configured page | no | File for these pages.                                          |
| `--issue-on=<mode>` | `unsettled`  | no       | `unsettled` (fail + manual_review) \| `fail`.                       |
| `--include-harness` | off          | no       | Also file `HARNESS_DEFECT` causes and quarantined runs.             |
| `--label=<name>`    | `qa:verdict` | no       | Extra label, repeatable. `qa:verdict` is always applied.            |
| `--allow-public`    | off          | no       | Permit filing on a public repository.                               |
| `--dry-run`         | off          | no       | Print the title and body that would be sent; make no API call.      |

Environment: `GITHUB_TOKEN` (the workflow needs `permissions: issues: write`)
and `GITHUB_REPOSITORY` as `owner/repo`. GitHub Actions supplies both.

Reads: `<page>-hermes-judgment.json`, `<page>-qa-ack.json`,
`<page>-qa-verdict-history.json`, `<page>-qa-run.invalid`, and everything
`handoff` reads to build the body.

Writes: an issue, a comment, or a state change on GitHub, and an `issue` event
appended to `<page>-qa-runs.jsonl`.

### What it decides

- **One issue per page**, found by the `<!-- playwright-spec-for-ai-agent:
  page=<slug> -->` marker in the body rather than by title, so renaming the
  issue does not orphan it.
- **Silence when nothing changed.** The body carries a fingerprint of the
  failing check set; an identical set produces no comment. A changed set
  comments and rewrites the body. A recurrence on a closed issue reopens that
  thread instead of filing a second one, so what was already tried stays
  attached.
- **A passing verdict closes it.** Only a real re-judgment against staging can
  produce that verdict, so a merged fix closes nothing by itself — the next run
  does.
- **`HARNESS_DEFECT` is not filed by default**, nor is a quarantined run: a
  check that was never really judged is ops work, and filing it at the
  application team is how a label becomes noise. `--include-harness` opts in.
- **Acknowledged checks are excluded**, on the same rules as the Slack alert.
- **A flaky check adds `qa:flaky`** rather than being dropped, so the reader
  knows the finding may not reproduce.
- **A public repository is refused** without `--allow-public`, because the body
  carries the staging URL, the page structure, and evidence paths.

The footer that follows the handoff document — an `@mention` that triggers a
coding agent, for instance — comes from `github.issueFooter` in the project
config and nowhere else. Deciding who acts on a verdict is the operator's call.

Exit codes: 0, including when there is nothing to file. 2 for a bad flag value
or when no page resolves. 3 when `GITHUB_TOKEN`/`GITHUB_REPOSITORY` is missing,
when the repository is public without `--allow-public`, or when a GitHub API
call fails. One page's API failure does not stop the others.

## handoff

Renders the latest verdict as a fix-planning task for a coding agent: every
unsettled check with the frozen Given/When/Then it was judged against, the spec
file and `@qa-live-policy` it came from, what the judge reported observing, the
reviewer's flags, and how often the check has flipped across same-spec runs.

| Option          | Default | Required | Effect                                                    |
| --------------- | ------- | -------- | --------------------------------------------------------- |
| `--page=<slug>` | —       | yes      | Page id.                                                  |
| `--all-checks`  | off     | no       | Include passing checks too, not only `fail`/`manual_review`. |
| `--out=<path>`  | —       | no       | Write to this file instead of stdout.                     |

Reads: `<page>-hermes-judgment.json`, falling back to
`<page>-qa-evidence-manifest.json` for per-check results when the judgment
recorded none; `<page>-qa-spec-live.md` for each check's contract;
`<page>-qa-spec.json` for the spec file behind it;
`<page>-hermes-judge-review.json`; `<page>-qa-verdict-history.json`.

Writes: the document to stdout, or to `--out=` when given. It writes nothing
else, and it neither edits a spec nor re-runs a stage — the output stops at a
plan, because a verdict that repairs itself is a verdict nobody can trust.

Everything the judge wrote is quoted, never inlined as instruction, and scanned
with the same injection patterns the runner applies to aria snapshots; a
suspicious line keeps its text and gains an `[!] injection-shaped` marker. This
is the one artifact whose reader holds write access to the repository, so it is
built to be read as evidence rather than obeyed.

Exit codes: 0, including when there is no judgment to hand off. 2 when `--page=`
is missing or `--out=` cannot be written.

## ack

Acknowledges one judged check so the Slack report stops re-alerting on it.

| Option                 | Default            | Required                | Effect                                        |
| ---------------------- | ------------------ | ----------------------- | ----------------------------------------------- |
| `--page=<slug>`        | —                  | yes                     | Page id.                                       |
| `--item=<check>`       | —                  | yes, to add an ack      | Exact check title from the latest judgment.    |
| `--reason=<text>`      | —                  | yes, with `--item=`     | Why it is acknowledged.                        |
| `--by=<name>`          | `$USER`, else `unknown` | no                 | Who acknowledged it.                           |
| `--until=<YYYY-MM-DD>` | 14 days from now   | no                      | Expiry.                                        |
| `--list`               | off                | no                      | Print the current acks for the page.           |
| `--remove=<check>`     | —                  | no                      | Remove one ack.                                |

Reads: `<page>-hermes-judgment.json`, to reject an `--item=` that no judged
check matches, and `<page>-qa-ack.json`.

Writes: `<page>-qa-ack.json`, and appends an `ack` event to
`<page>-qa-runs.jsonl`.

Exit codes: 0. 2 when `--page=`, `--item=`, or `--reason=` is missing, when
`--until=` cannot be parsed, or when `--item=` names no judged check.

## demo

Runs `spec` → `abstract-ai` → `judge` → `review` against the bundled demo app,
offline, with the `fixture` adapter. No credentials, no agent CLI, no network.

| Option        | Default          | Required | Effect                                            |
| ------------- | ---------------- | -------- | --------------------------------------------------- |
| `--out=<dir>` | a temp directory | no       | Write the throwaway project here. Implies `--keep`. |
| `--keep`      | off              | no       | Leave the output directory in place for inspection. |

`demo` is the one command that does not load your project config: it generates
a throwaway config and passes `--config=`, `--project-root=`,
`--auth-required=false`, and `--non-interactive` to each stage it spawns. The
[global options](#global-options) therefore do not apply to it.

Reads: the bundled demo spec and fixture responses.

Writes: the throwaway project's `__QA__` directory, removed on exit unless
`--keep` or `--out=` was passed.

Exit codes: 0 even when a stage exits non-zero — `demo` prints the stage's exit
code and continues, so a deliberately failing stage still demonstrates the whole
pipeline.

## Global options

Every command except `demo` accepts these.

| Option                    | Default                                    | Effect                                                                       |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `--config=<path>`         | upward search from the project root        | Config file path; skips the search.                                          |
| `--project-root=<path>`   | the config file's directory, else cwd      | Project root. `--root=` is an accepted alias.                                |
| `--spec-dir=<template>`   | `src/page/{page}/__tests__`                | Spec directory template. `{page}` and `{root}` are substituted.               |
| `--output-dir=<template>` | `src/page/{page}/__QA__`                   | Output directory template. Same substitution.                                |
| `--strict-config`         | off                                        | Turn config warnings into a usage error. Same as `QA_STRICT_CONFIG=1`.        |
| `--env-file=<path>`       | `./.env.local` then `./.env`               | Load this env file **instead of** both defaults. A missing file exits 2.     |
| `--help`, `-h`            | —                                          | Print help. Placed after a command, prints that command's options.            |
| `--version`, `-V`         | —                                          | Print the package version.                                                   |

Key resolution for everything these flags touch is
**CLI flag > environment variable > config file > built-in default**. See
[Configuration](./configuration.md).

### Environment file load order

At startup the CLI loads `./.env.local`, then `./.env`. **Earlier wins**: a key
already present is never overwritten, and a real environment variable beats both
files, so an exported variable or a CI secret cannot be shadowed by a
checked-out file. Each file that is read prints
`[env] <path>: N applied, M already set in the environment (kept)`. A missing
file is skipped.

`QA_NO_ENV_FILE=1` disables env-file loading. Export it in the real
environment — setting it inside a file that is only read afterwards does
nothing. Node older than 20.12 cannot parse env files; the load is skipped with
a message.

### Exit codes

The exit codes are part of the CLI contract, so CI can branch on them.

| Code | Name          | Meaning                                                                   |
| ---- | ------------- | --------------------------------------------------------------------------- |
| 0    | ok            | Judged green, or nothing to judge.                                        |
| 1    | verdict fail  | The product under test was judged `fail` (or `manual_review` under `--fail-on=manual_review`). |
| 2    | usage         | Wrong flags, a missing `--page=`, or unusable config.                     |
| 3    | environment   | Agent CLI, model, credentials, or staging missing or unreachable.         |
| 4    | agent output  | The adapter ran but returned output the harness cannot use.               |

A verdict failure (1) and an infrastructure failure (3, 4) never share a code: a
nightly that cannot tell "staging is broken" from "staging is down" pages the
wrong person.

An unexpected error — a bug rather than an expected failure — exits 2 and keeps
its stack trace.

## Router and stage-script drift

The router in `bin/playwright-spec-for-ai-agent.mjs` prints the flag list, but
the stage script parses argv. Where the two disagree, the script wins. These
flags work today and are absent from `--help`:

| Flag                            | Accepted by                            | Note                                                                                        |
| ------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `--expected-account-state=`     | `judge`                                | Current name for `--expected-subscription-status=`. **Only the `=` form works** — the router does not rewrite the space-separated form, which is silently dropped. |
| `--dashboard-path=`             | `judge`, `login`                       | Default path used when building login context. The router rewrites the space form.          |
| `--root=`                       | every config-loading command           | Alias of `--project-root=`.                                                                 |
| `--target-path=`                | `slack`                                | `slack` resolves a target path and exits 2 when none resolves for the page.                 |
| `--strict-config`, `--spec-dir=`, `--output-dir=` | every config-loading command | Parsed by the shared config layer, so they work on commands whose `--help` omits them. |

Report any other divergence you find as a bug: the router's `VALUE_FLAGS` set is
what makes the space-separated form safe, and a value flag missing from it is
dropped rather than rejected.

## Related

- [Configuration](./configuration.md) — config keys, environment variables, discovery
- [Annotations](./annotations.md) — the `@qa-*` vocabulary `spec` parses
- [Artifacts](./artifacts.md) — the contents of every file these commands write
- [Adapters](./adapters.md) — which agent backend runs the AI stages
- [Run it in CI](../how-to/ci.md) — exit codes and flags in a workflow
- [Troubleshooting](../troubleshooting.md) — symptom-indexed fixes
