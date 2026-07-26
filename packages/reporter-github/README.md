<div align="center">

# @persona-runtime/reporter-github

**Evidence-backed PR comments and Check conclusions for behavioral release runs.**

![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)
![GitHub Checks](https://img.shields.io/badge/GitHub-Checks-111827?style=for-the-badge&logo=github&logoColor=white)
![Idempotent](https://img.shields.io/badge/comments-idempotent-2563eb?style=for-the-badge)

<br />

![PR Comments](https://img.shields.io/badge/%23PRComments-0f766e?style=flat-square)
![Release Gate](https://img.shields.io/badge/%23ReleaseGate-b45309?style=flat-square)
![Safe Links](https://img.shields.io/badge/%23SafeLinks-047857?style=flat-square)

<br />

[Quick start](#quick-start) · [API](#api) · [Outputs](#outputs) · [Safety](#safety) · [Workspace](../../README.md)

</div>

---

> [!NOTE]
> This package formats and publishes behavioral release results. It does not run studies, upload artifacts, open browsers, or create code changes.

```text
findings + comparison + artifact links → GitHub reporter → marker-scoped PR comment + optional Check Run
```

### Input → output example

```js
import { renderBehavioralPrComment } from "@persona-runtime/reporter-github";

const markdown = renderBehavioralPrComment({
  studyId: "signup-flow",
  outcome: { conclusion: "neutral", summary: "Behavioral warnings detected" },
  comparisonReport: { status: "insufficient_evidence" },
  findings: [],
  artifactLinks: [
    { label: "HTML report", url: "https://github.com/owner/repo/actions/runs/1?token=hidden#logs" },
  ],
});

console.log(markdown.startsWith("<!-- persona-runtime-check: study=signup-flow -->"));
```

```text
true
```

---

## Table of Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [API](#api)
- [Quick start](#quick-start)
- [Outputs](#outputs)
- [Safety](#safety)
- [Test](#test)
- [Limits](#limits)

## Why this exists

Behavioral release checks need to show up where releases are reviewed. This reporter gives CI a bounded way to post one updatable PR comment and an optional Check conclusion without spamming reviewers.

## What it does

The package:

1. Classifies runtime, finding, comparison, and release-gate signals.
2. Renders sanitized Markdown for a PR comment.
3. Creates stable marker lines for idempotent updates.
4. Uses the GitHub CLI as a bounded transport.
5. Optionally creates a Check Run for the PR head SHA.

## API

| Export | Purpose |
| --- | --- |
| `classifyReporterOutcome(input)` | Maps findings, release gate, comparison status, and runtime errors to a product/infrastructure outcome. |
| `renderBehavioralPrComment(input)` | Returns sanitized Markdown for one PR comment. |
| `markerLine(studyId)` | Builds the idempotency marker. |
| `createGitHubCliTransport(options)` | Creates a `gh api` transport with bounded payloads and safe environment forwarding. |
| `publishBehavioralGitHubReport(input)` | Creates or updates the marker comment and optionally creates a Check Run. |

## Quick start

```js
import { classifyReporterOutcome, renderBehavioralPrComment } from "@persona-runtime/reporter-github";

const outcome = classifyReporterOutcome({ comparisonStatus: "insufficient_evidence", findings: [] });
const comment = renderBehavioralPrComment({
  studyId: "signup-flow",
  outcome,
  findings: [],
  comparisonReport: { status: "insufficient_evidence" },
});

console.log(comment.includes("persona-runtime-check"));
```

## Outputs

| Signal | Default Check conclusion |
| --- | --- |
| No blocking finding | `success` |
| Warning, baseline-better, insufficient evidence, or uncalibrated single behavioral session | `neutral` |
| Blocking functional/high or reproduced critical behavioral finding | `failure` |
| Unstable comparison or required human validation | `action_required` |
| Runtime infrastructure error | `neutral`, unless configured as `failure` |

## Safety

- PR comments are scoped by `<!-- persona-runtime-check: study=... -->` and updated idempotently.
- Artifact and details URLs must be safe HTTPS URLs; query strings and fragments are stripped.
- Comment text is sanitized to remove HTML comments, image embeds, unsafe mentions, and oversized payloads.
- The GitHub CLI transport forwards only an allowlisted environment.
- Ambiguous marker comments from the trusted bot fail instead of overwriting blindly.

## Test

```bash
pnpm --filter @persona-runtime/reporter-github test
pnpm --filter @persona-runtime/reporter-github typecheck
pnpm --filter @persona-runtime/reporter-github build
```

## Limits

- Requires authenticated `gh` when using the default transport.
- `repository` must be `owner/name`; `headSha`, when provided, must be a commit SHA.
- It publishes report text only. Artifact upload is the caller's responsibility.
