# Turn verdicts into agent work, and let the next run close them

This page is for someone who already gets nightly verdicts and wants the
unsettled ones to become work items a coding agent can pick up — without letting
anything mark its own homework. You will end with a nightly that files one issue
per failing page, an agent that proposes a fix on it, and a loop that closes the
issue only when staging is re-judged and passes.

For what each command does on its own, see [the CLI reference](../reference/cli.md).
For running unattended in the first place, start at [CI](./ci.md).

## The shape of the loop

```text
nightly --all --with-issues
  ├─ page passes  → an open issue is commented on and closed
  └─ page unsettled → an issue is filed or updated, labelled qa:verdict
                        ↓
              your coding agent, triggered by the label
                        ↓
                  a pull request you review
                        ↓
              next nightly re-judges the deployed page
                        ↓
              passes → the issue closes itself
```

The last two steps are the point. The agent that proposed the fix cannot close
the issue, and neither can merging the pull request: only a fresh judgment
against staging produces the passing verdict that closes it. The agent has no
staging credentials and cannot run `judge`, so it has no way to certify its own
work — the loop supplies the independent check for free.

## 1. Confirm you get verdicts first

```bash
npx playwright-spec-for-ai-agent nightly --all
npx playwright-spec-for-ai-agent report
```

Filing issues from a pipeline that is not yet trustworthy just moves noise into
a new place. If pages come back `manual_review` for harness reasons — no
session, an unreachable origin — fix that first with
[Authentication](./authentication.md) and `doctor`.

## 2. Read one issue body before you file any

The body is the `handoff` document, so you can see exactly what an agent would
receive:

```bash
npx playwright-spec-for-ai-agent handoff --page=dashboard
npx playwright-spec-for-ai-agent issues --page=dashboard --dry-run
```

`--dry-run` prints the title, the routing markers, and the full body without
calling the GitHub API. Check that each unsettled check shows its frozen
Given/When/Then, its spec file, and the reviewer's flags. If the contract is
missing for a check, the document says so rather than inventing one — that is
usually a sign `abstract-ai` never ran for the current spec.

## 3. Give the workflow permission to file

The token needs `issues: write`, and the action cannot grant that for you:

```yaml
name: nightly-qa
on:
  schedule: [{ cron: "0 18 * * *" }]   # 03:00 KST
  workflow_dispatch:

permissions:
  contents: read
  issues: write

jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      # install and authenticate your agent CLI first — this action does not
      - uses: lodado/playwright-spec-for-AI-Agent@v6
        with:
          pages: dashboard,billing
          adapter: hermes
          extra-args: --with-issues
          github-token: ${{ secrets.GITHUB_TOKEN }}
        env:
          STAGING_QA_BASE_URL: ${{ secrets.STAGING_QA_BASE_URL }}
          STAGING_QA_EMAIL: ${{ secrets.STAGING_QA_EMAIL }}
          STAGING_QA_PASSWORD: ${{ secrets.STAGING_QA_PASSWORD }}
```

**On a public repository this refuses to run.** The body carries your staging
URL, the page's structure, and evidence filenames. Pass `--allow-public` in
`extra-args` only if publishing all of that is intended.

## 4. Point an agent at the label

The tool files the issue and stops. What picks it up is yours to choose, and the
trigger lives in your config rather than in this package:

```js
// playwright-spec-for-ai-agent.config.mjs
export default {
  github: {
    issueFooter:
      "@claude Read the checks above, classify each one, and open a PR with the smallest fix. Do not weaken a check to make it pass.",
  },
};
```

Anything that reacts to an issue label works — the Claude Code GitHub Action,
a Codex workflow, or a human. A minimal wiring:

```yaml
name: qa-fix
on:
  issues:
    types: [opened, reopened, labeled]

jobs:
  fix:
    if: contains(github.event.issue.labels.*.name, 'qa:verdict')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      # your agent action here, reading github.event.issue.body
```

Note what that job does **not** get: no staging secrets, and no `issues: write`.
It can open a pull request; it cannot close the issue that sent it.

## 5. Keep the gate at review, not at merge

Two rules keep the loop honest, and both are your responsibility:

- **Never auto-merge these pull requests.** The document tells the agent to
  propose rather than apply, but nothing stops a workflow from merging what it
  proposes. A human reads the diff.
- **Never close the issue by hand to tidy up.** Closing it manually asserts a
  fix that no run confirmed. If a finding is wrong or accepted, record that with
  `ack` instead — an acknowledged check is excluded from filing with its reason
  and expiry intact:

  ```bash
  npx playwright-spec-for-ai-agent ack --page=dashboard \
    --item="shows an account health score" \
    --reason="known upstream outage, tracked in INFRA-412" --until=2026-09-15
  ```

## What lands where

| Outcome | What happens |
| ------- | ------------- |
| Same checks fail again | No comment. Silence means "nothing new", so a comment always means something changed. |
| A different check fails | The body is rewritten and a comment names the change. |
| A previously fixed check breaks again | The original issue reopens, keeping the history of what was tried. |
| The page passes | A closing comment cites the run id, and the issue closes. |
| The judge never ran (quarantine, `HARNESS_DEFECT`) | Nothing is filed — that is ops work. Use `--include-harness` if your team wants it tracked as issues too. |
| A check flips between runs | Filed with `qa:flaky` so the reader knows it may not reproduce. |

## Reading an issue safely

Everything the judge wrote arrives quoted, and anything injection-shaped keeps
its text with a marker naming it as data. That matters here more than anywhere
else in the pipeline: a page can put text on screen, that text can reach the
judge's prose, and the issue is read by something with write access to your
repository. If you see a marker, treat the page as hostile and report it —
do not follow it, and do not let an agent act on it.

## Related

- [reference/cli.md](../reference/cli.md) — every flag `issues` and `handoff` take
- [how-to/ci.md](./ci.md) — exit codes and unattended runs
- [explanation/how-verdicts-are-decided.md](../explanation/how-verdicts-are-decided.md) — why a check came out unsettled
