# Run the pipeline in CI

This page is for whoever owns the nightly QA job. It covers running the pipeline
without a human at the keyboard and making the job's exit code mean something
specific: a red build should say whether the product is broken or the harness
is. When you finish, a scheduled run judges every configured page, uploads its
artifacts, writes the verdict table to the job summary, and exits with a code
your alerting can branch on.

Nothing here installs or authenticates the agent backend. Do that in your own
steps first — see [Adapters](../reference/adapters.md).

## Choose a session path that works unattended

Of the three ways to give the judge a session, only two belong in CI.

| Path                                        | In CI | Why                                                              |
| ------------------------------------------- | ----- | ---------------------------------------------------------------- |
| `staging.storageState`                      | yes   | A file an earlier step generates. Nothing is prompted.           |
| `STAGING_QA_EMAIL` / `STAGING_QA_PASSWORD`  | yes   | Repository secrets, read from the environment.                   |
| `login`                                     | no    | Opens a headed browser for a human to sign in.                   |
| `--cdp-url=` / `QA_BROWSER_CDP_URL`         | no    | Attaches to a browser a human already started and signed into.   |

`--cdp-url` is the answer for identity providers that refuse
automation-controlled browsers, which is exactly what a CI runner cannot
provide. If a provider only lets a human sign in, that page cannot be judged
unattended: arrange a `storageState` for it, or keep it out of the nightly.

Full setup for each path: [Give the judge a signed-in session](./authentication.md).

## Branch on the exit code

The exit code is part of the CLI contract. A verdict failure and an
infrastructure failure never share one, because a nightly that cannot tell
"staging is broken" from "staging is down" pages the wrong person.

| Code | Name                | Meaning                                                            |
| ---- | ------------------- | ------------------------------------------------------------------ |
| 0    | `EXIT_OK`           | Judged green, or there was nothing to judge.                       |
| 1    | `EXIT_VERDICT_FAIL` | The product under test was judged `fail`.                          |
| 2    | `EXIT_USAGE`        | Wrong flags, missing `--page`, unusable or stale config/artifacts. |
| 3    | `EXIT_ENVIRONMENT`  | Agent CLI, model, credentials, or staging missing or unreachable.  |
| 4    | `EXIT_AGENT_OUTPUT` | The adapter ran but returned output we cannot use.                 |

Route 1 to the product owner and 2, 3, and 4 to whoever owns the harness:

```bash
npx playwright-spec-for-ai-agent nightly --all --non-interactive || status=$?
case "${status:-0}" in
  0) ;;
  1) echo "staging is broken"; exit 1 ;;
  *) echo "the QA harness is broken (exit ${status})"; exit "${status}" ;;
esac
```

`nightly` aggregates several pages and several stages by **severity**, not by
"last one wins", so an environment failure in `judge` is never overwritten by a
later Slack failure. The order, worst last, is `0 < 1 < 2 < 4 < 3`; an
unrecognised code outranks all of them, because it is unexplained.

Two commands translate a verdict into an exit code, and both take `--fail-on=`:

| Command  | Flag                                     | Default |
| -------- | ---------------------------------------- | ------- |
| `judge`  | `--fail-on=fail｜manual_review｜never`   | `fail`  |
| `report` | `--fail-on=fail｜manual_review｜never`   | `fail`  |

`report` returns **3**, not 1, when a page is quarantined or its judgment is
unreadable — that is infrastructure, not a verdict.

## Suppress the prompts

`judge` prompts for credentials and target confirmation when stdin is a TTY and
`CI` is unset. GitHub Actions sets `CI=true`, which is enough; pass
`--non-interactive` (aliases `--yes`, `-y`) to be sure on runners that do not.
`nightly` forwards the flag to every stage it runs.

Add `--strict-config` (or `QA_STRICT_CONFIG=1`) so a typo'd config key fails the
run instead of printing a warning nobody reads.

## Use the bundled composite action

`action.yml` ships with the package. It runs `nightly --non-interactive` once
per page, uploads every `**/__QA__/**` directory, appends the `report` table to
the job summary, and finally replays the **worst** exit code across pages — so
the taxonomy above survives a multi-page run.

```yaml
- uses: lodado/playwright-spec-for-AI-Agent@v6
  with:
    pages: dashboard,pricing        # required, comma-separated page slugs
    adapter: hermes                 # QA_AI_ADAPTER; default hermes
    config-path: ""                 # default: auto-discovered from the project root
    extra-args: "--with-slack"      # appended to every nightly run
    node-version: "20"              # default 20; the package requires >= 20
```

`pages` is the only required input. Every page runs even if an earlier one
fails, so one bad page still produces artifacts for the rest. The artifact is
named `qa-artifacts-<run_id>-<run_attempt>` and uploads with
`if-no-files-found: warn`.

The action does **not** install or authenticate the agent CLI it drives, and
does not supply staging credentials. Install the backend and export the secrets
in your own steps before calling it.

## Or run the CLI directly

```yaml
name: nightly-qa
on:
  schedule: [{ cron: "0 3 * * *" }]
  workflow_dispatch:

jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci

      - name: Preflight
        run: npx playwright-spec-for-ai-agent doctor --strict-config

      - name: Nightly QA
        env:
          STAGING_QA_EMAIL: ${{ secrets.STAGING_QA_EMAIL }}
          STAGING_QA_PASSWORD: ${{ secrets.STAGING_QA_PASSWORD }}
          STAGING_QA_BASE_URL: ${{ secrets.STAGING_QA_BASE_URL }}
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
        run: >
          npx playwright-spec-for-ai-agent nightly
          --all --with-slack --non-interactive --strict-config

      - name: Cross-page digest
        if: always()
        run: npx playwright-spec-for-ai-agent report --fail-on=fail

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: qa-artifacts
          path: src/page/*/__QA__/
```

`doctor` exits 3 when any required check fails, so it is a real gate, not a
diagnostic print. Add `--check-network` to also fetch each configured target URL
(HEAD/GET, 10-second timeout), and `--json` for a machine-readable report.

## Read the result without opening the logs

### `$GITHUB_STEP_SUMMARY`

When the variable is set, `judge` appends a per-page block — status, cause, run
id, adapter and model, the summary, a checks table capped at 10 rows, coverage,
and evidence filenames — and `report` appends its cross-page table. Pipes and
newlines are escaped and cells are truncated at 120 characters, so a check
detail cannot break out of a markdown cell.

Every failure in this path is swallowed on purpose: a read-only or broken CI
environment must never be the reason a QA run fails. Outside GitHub Actions
nothing is written.

### CTRF

`judge` writes `{slug}-qa-report.ctrf.json` on every run — the
[CTRF](https://ctrf.io) projection of the judgment, readable by the existing
GitHub/Slack/Jira/Jenkins CTRF reporters without any adapter of ours. Field
mapping is in [Artifacts](../reference/artifacts.md).

`report --format=json --out=<path>` is the other machine-readable surface: one
row per configured page with status, cause, check counts, coverage, adapter,
model, `judgedAt`, age, and run id.

## Post to Slack

`slack` posts to `SLACK_WEBHOOK_URL`. Without it the command fails with an
environment error rather than silently doing nothing. `nightly --with-slack`
runs this stage after `review`.

| `--notify=` | Posts when                                        |
| ----------- | ------------------------------------------------- |
| `failures`  | default — anything that is not an explicit `pass` |
| `always`    | every run, including a green heartbeat            |
| `never`     | nothing                                           |

`failures` covers `skip` and unrecognised statuses too: those mean nothing was
verified, which is the outcome most worth seeing.

Three behaviours worth knowing:

- **A quarantined judge run posts `[ERRORED]`** naming the quarantine reason and
  saying "No verdict was produced for this page — this is not a pass", then
  exits 3. A crashed judge is otherwise the quietest outcome there is.
- **Only `pass` is treated as green.** Any status the reporter does not
  recognise renders as `UNKNOWN`.
- **Everything the agent wrote is untrusted text**: escaped for Slack mrkdwn
  (`&`, `<`, `>`) and truncated before it reaches a payload.

Failing and `manual_review` checks are listed, minus any with an active `ack`;
the acked count is reported in the headline instead. When `GITHUB_SERVER_URL`,
`GITHUB_REPOSITORY`, and `GITHUB_RUN_ID` are set, the message links back to the
Actions run.

## File issues instead of only alerting

`nightly --with-issues` runs the `issues` stage after `review`. It files one
GitHub issue per page that still needs action, using the `handoff` document as
the body, so a verdict becomes a work item a coding agent can pick up. It needs
`permissions: issues: write` and refuses to run on a public repository without
`--allow-public`, because the body carries your staging URL and page structure.

An unchanged failure set produces no comment, and only a later passing verdict
closes the issue — merging a fix closes nothing, which is what keeps the loop
from certifying itself. The full walkthrough, including how to point an agent at
the label, is [Close the loop](./close-the-loop.md).

## Skip work that provably did not change

Two `nightly` stages are skipped when their inputs are unchanged. Both are cost
optimisations; both can be forced.

- **`abstract-ai`** is skipped when the live plan's stamped `sourceHash` equals
  the hash of the spec `spec` just wrote. `--force-abstract` regenerates it.
- **`judge` and `review`** are skipped when `staging.versionUrl` reports a build
  id that already produced a `pass` with this exact spec hash. `--force-judge`
  re-judges. An unreachable or non-OK version endpoint judges anyway.

`--review-on=` controls the review stage: `fail` (default) runs it only when the
verdict is not `pass` or some check is failing; `always` and `never` are the
other two. `--skip-review` is an alias of `--review-on=never`.

## Related

- [Close the loop](./close-the-loop.md) — turn failing verdicts into agent work items.
- [CLI reference](../reference/cli.md) — every flag named here.
- [Configuration](../reference/configuration.md) — `staging.versionUrl`, `staging.storageState`, and the environment variables.
- [Artifacts](../reference/artifacts.md) — what lands in `__QA__/`, including the CTRF field mapping.
- [How verdicts are decided](../explanation/how-verdicts-are-decided.md) — why a `pass` can still be downgraded.
