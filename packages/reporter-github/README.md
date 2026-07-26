# Persona Runtime GitHub Reporter

<p align="center">
  <strong>Publish behavioral release evidence to pull requests without spamming comments.</strong><br>
  It renders marker-scoped PR comments, maps outcomes to GitHub Check conclusions, and uses the GitHub CLI as a bounded transport.
</p>

<p align="center">
  <img alt="GitHub Checks" src="https://img.shields.io/badge/GitHub-Checks-111827?style=flat-square">
  <img alt="Idempotent comments" src="https://img.shields.io/badge/comments-idempotent-2563eb?style=flat-square">
  <img alt="Safe links" src="https://img.shields.io/badge/links-HTTPS_only-047857?style=flat-square">
</p>

## Where it fits

```text
Variant comparison + findings + artifact links
  └─ GitHub reporter
      ├─ PR comment with <!-- persona-runtime-check: study=... --> marker
      └─ optional Check Run for the PR head SHA
```

This package is the PR publication layer. It does not run studies or upload artifacts.

## Public surface

| Export | Purpose |
|---|---|
| `classifyReporterOutcome(input)` | Maps runtime errors, findings, release gate, and comparison status to a product/infrastructure outcome. |
| `renderBehavioralPrComment(input)` | Returns sanitized Markdown for one PR comment. |
| `markerLine(studyId)` | Builds the idempotency marker. |
| `createGitHubCliTransport(options)` | Creates a `gh api` transport with bounded payloads and safe environment forwarding. |
| `publishBehavioralGitHubReport(input)` | Creates or updates the marker comment and optionally creates a Check Run. |

## Minimal example

```js
import { renderBehavioralPrComment } from "@persona-runtime/reporter-github";

const markdown = renderBehavioralPrComment({
  studyId: "signup-flow",
  outcome: { conclusion: "neutral", summary: "Behavioral warnings detected" },
  comparisonReport: { status: "insufficient_evidence" },
  findings: [],
  artifactLinks: [{ label: "HTML report", url: "https://github.com/owner/repo/actions/runs/1?token=hidden#logs" }],
});

console.log(markdown.startsWith("<!-- persona-runtime-check: study=signup-flow -->")); // true
```

## Outcome mapping

| Signal | Default Check conclusion |
|---|---|
| No blocking finding | `success` |
| Warning, baseline-better, insufficient evidence, or uncalibrated single behavioral session | `neutral` |
| Blocking functional/high or reproduced critical behavioral finding | `failure` |
| Unstable comparison or required human validation | `action_required` |
| Runtime infrastructure error | `neutral`, unless configured as `failure` |

## Safety boundaries

- PR comments are scoped by `<!-- persona-runtime-check: study=... -->` and updated idempotently.
- Artifact and details URLs must be safe HTTPS URLs; query strings and fragments are stripped.
- Comment text is sanitized to remove HTML comments, image embeds, unsafe mentions, and oversized payloads.
- The GitHub CLI transport forwards only an allowlisted environment, including GitHub tokens and proxy variables.
- Ambiguous marker comments from the trusted bot are treated as transport failures instead of overwriting blindly.

## Required runtime environment

- `gh` must be installed and authenticated when using the default transport.
- `repository` must be `owner/name`.
- `headSha`, when provided, must be a commit SHA.
- `studyId` must be marker-safe: letters, numbers, `.`, `_`, `:`, or `-`.

## Workspace commands

```bash
pnpm --filter @persona-runtime/reporter-github test
pnpm --filter @persona-runtime/reporter-github typecheck
pnpm --filter @persona-runtime/reporter-github build
```
