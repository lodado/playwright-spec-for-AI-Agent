<div align="center">

# Personaut

**Let bounded AI personas explore a web product—and turn every decision into reviewable evidence.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.60-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev)
[![npm](https://img.shields.io/npm/v/@lodado/personaut?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/@lodado/personaut)

[Mental model](#the-30-second-mental-model) · [Quick start](#5-minute-quick-start) · [Policy modes](#choose-a-policy-mode) · [Use your site](#use-personaut-with-your-site) · [Safety](#safety-and-limits) · [Workspace](../../README.md)

</div>

Personaut is an evidence-first browser exploration tool built on Playwright. Give it a task and a seeded persona; it observes only the visible page, chooses bounded actions, and records what happened for review.

> **AI chooses. Code constrains. Evidence decides.**

## The 30-second mental model

| 🧠 AI chooses | 🛡️ Code constrains | 🔎 Evidence decides |
| --- | --- | --- |
| A deterministic policy or Hermes chooses the next visible action using persona hints. | StudySpec, runtime, and the Playwright driver independently reject unsafe actions. | Live oracles decide when to stop; post-close evaluation verifies sealed evidence. |

```text
task + persona hint
        ↓
observe → choose → validate → act → observe again
        ↓
close browser → seal evidence → evaluate oracles → report
```

This separation is the core philosophy:

1. **A persona is a hint, not a script.** Hermes may decide differently from a hard-coded ranking.
2. **A model never receives browser authority.** It proposes one small action; normal code validates and executes it.
3. **A model never declares success.** URL, text, element, or event oracles make that decision from sealed evidence.
4. **Failures keep their provenance.** Provider and driver failures remain infrastructure errors instead of becoming fake UX findings.

> [!IMPORTANT]
> Personaut produces synthetic exploratory evidence. It does **not** replace deterministic Playwright tests, analytics, accessibility audits, or human user research—and it does not predict conversion.

### When should I use it?

| Good fit | Use something else |
| --- | --- |
| Explore where different seeded behaviors stall | Prove one exact regression never returns → Playwright test |
| Compare relative behavior across baseline and candidate | Measure real-user conversion → product analytics |
| Collect reproducible, evidence-linked friction signals | Make demographic claims → calibrated human research |

## 5-minute quick start

### 1. Install Personaut and Chromium

```bash
pnpm add -D @lodado/personaut
pnpm exec playwright install chromium
```

Requirements: Node.js 20 or newer and a URL the machine can reach.

### 2. Create a safe starter study

```bash
pnpm exec personaut init study.yaml
```

The generated study targets `https://example.com`, allows reading and navigation, disables clicks and mutations, and runs one `impatient_new_user` session. It captures screenshots only when a driver action fails or is blocked; `on_failure` does not add terminal screenshots for oracle failure, partial completion, abandonment, or success. `init` refuses to overwrite an existing file.

### 3. Validate before opening a browser

```bash
pnpm exec personaut validate study.yaml
```

Expected output:

```text
Valid study-spec/0.1: example-page
```

### 4. Run the study

```bash
pnpm exec personaut run study.yaml --output=.personaut/example
```

Expected output:

```text
Report: <project>/.personaut/example/reports/report.html
```

Open the report and inspect the machine-readable summary:

```text
.personaut/example/
├── summary.json
├── validity.json
├── findings.json
├── reports/report.html
└── sessions/<session-id>/
```

The starter result is marked `exploration_only`. Personaut does not claim that synthetic sessions represent real-user conversion.

## How a StudySpec works

A StudySpec answers five questions:

| Field | Question |
| --- | --- |
| `environment` | Which URL and origins may the browser visit? |
| `tasks` | What goal should the persona attempt? |
| `successOracles` | What deterministic evidence counts as success? |
| `safetyPolicy` | Which browser actions are allowed? |
| `personas` + `runtime.seeds` | Which behaviors run, and how many sessions are created? |

Personaut evaluates `personas × tasks × seeds`. Two personas, two tasks, and three seeds create twelve isolated sessions.

The action policy and the success oracle are intentionally separate. Changing how a persona explores must not change what counts as success.

## Use Personaut with your site

Start from the generated `study.yaml` and change these fields first:

```yaml
study:
  id: pricing-check
  name: Pricing page exploration

product:
  description: Public pricing experience

environment:
  baseUrl: https://staging.example.test
  allowedOrigins:
    - https://staging.example.test

tasks:
  - id: open-pricing
    name: Open pricing
    goal: Find and open the pricing page
    successOracles:
      - id: pricing-url
        type: url
        operation: contains
        value: /pricing
```

Keep `allowedOrigins` exact. Personaut blocks navigation outside this list unless the study explicitly permits external origins.

### Success oracles

| Type | Example use |
| --- | --- |
| `url` | The session reached `/complete`. |
| `visible_text` | The page visibly contains expected copy. |
| `element` | A visible, enabled, disabled, hidden, or checked element exists. |
| `event` | A named browser action occurred. |
| `custom` | Mark imported intent for manual review; arbitrary study code is not executed. |

Run `personaut validate` after every StudySpec edit.

## Persona presets

| Preset | Typical behavior |
| --- | --- |
| `impatient_new_user` | Explores little and abandons quickly. |
| `careful_business_buyer` | Reads deeply and retries cautiously. |
| `low_domain_knowledge_user` | Backtracks more and has weaker product expectations. |
| `exploratory_power_user` | Explores broadly and retries often. |
| `price_sensitive_user` | Reacts strongly to pricing and signup friction. |

Seeds make policy sampling repeatable. Reusing the same StudySpec and seeds makes baseline/candidate comparison meaningful.

## Choose a policy mode

| Mode | Who chooses the next action? | Best for |
| --- | --- | --- |
| Deterministic, default | Repository code uses seeded persona rules. | Repeatable baseline exploration with no model dependency. |
| Hermes, opt-in | Hermes chooses from a strict action schema using persona hints. | Exploring paths that should not be pre-ranked by application code. |

Unknown action-model names keep the deterministic path for compatibility. Only the exact value `hermes` activates Hermes.

### Opt-in Hermes actions

Install and configure `hermes-agent`, then use this local-only v0.1 configuration:

```yaml
runtime:
  seeds: [101]
  concurrency: 1
  modelRoles:
    action: hermes
    evaluator: deterministic-oracle

evidence:
  screenshot: off
  trace: false
  video: off
  semanticSnapshot: every_action
```

#### What does Hermes see?

| Hermes receives | Hermes never receives |
| --- | --- |
| Task goal and bounded context | Whole StudySpec or oracle definitions |
| Path-only route and visible semantic text | URL query/hash/user info or raw DOM |
| Visible element IDs, roles, names, and state | Selectors, fingerprints, test IDs, hidden elements |
| Recent three canonical event summaries | Full event history, console, or network internals |
| Persona hints and remaining budget | Screenshot, trace, video, auth, or storage state |
| Fixture **names** such as `email` | Fixture **values** such as an actual email or password |

Hermes may return only `click`, `type(valueRef)`, `scroll`, `back`, `wait`, `finish`, or `abandon`. The task safety policy can narrow that list further.

```text
Hermes: { type: "type", elementId: "el_1", valueRef: "email" }
                                      │
                                      └─ the driver resolves the real value in memory
```

The fixture value never needs to enter the model prompt, event stream, session JSON, manifest, or error message.

Invalid output gets one format-repair attempt. Timeout and provider failures are not retried, and none of these failures fall back to the deterministic policy. Sealed manifests contain digest-only model attempt provenance, never raw prompts or model output.

> [!NOTE]
> No fallback is deliberate. A silent switch to deterministic behavior would make it impossible to tell whether Hermes or repository code chose the action.

## Commands

```text
personaut init [study.yaml]
personaut validate <study.yaml>
personaut run <study.yaml> [--output=.qa/run]
personaut compare <study.yaml> --baseline=<url> --candidate=<url> [--output=.qa/run]
personaut import-playwright --spec-dir=<dir> --base-url=<url> --output=<study.yaml>
```

### Import Playwright specs

Compile existing Playwright intent into a StudySpec:

```bash
pnpm exec personaut import-playwright \
  --spec-dir=tests/e2e \
  --base-url=https://staging.example.test \
  --output=study.yaml

pnpm exec personaut validate study.yaml
```

Review imported manual-review or blocked policies before running. Annotation details live in the [Playwright Spec Adapter reference](https://github.com/lodado/playwright-spec-for-AI-Agent/blob/main/packages/playwright-spec-adapter/README.md#playwright-annotations).

### Compare two variants

```bash
pnpm exec personaut compare study.yaml \
  --baseline=https://baseline.example.test \
  --candidate=https://candidate.example.test \
  --output=.personaut/comparison
```

Comparison uses paired policy sampling and reports relative synthetic differences. It does not predict real-user conversion.

## Read the output

| File | Purpose |
| --- | --- |
| `summary.json` | Overall run status and recommended use. |
| `validity.json` | Calibration, diversity, stability, and interpretation warnings. |
| `findings.json` | Repeated evidence-linked friction and failure signals. |
| `variant-comparison.json` | Baseline/candidate deltas from `compare`. |
| `reports/report.html` | Human-readable report. |
| `sessions/*/evidence-manifest.json` | Sealed artifact membership and hashes. |
| `sessions/*/events.jsonl` | Browser action and result stream. |
| `sessions/*/observations.jsonl` | Per-action semantic observations. |

Evidence files are verified against the sealed manifest before an outcome is reported as successful.

For Hermes runs, `model_attempt` evidence stores only provider/model identity, prompt version, attempt number, input/output digests, latency, and outcome code. Digests are audit identifiers—not copies of model content and not proof that a model decision was correct.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Executable doesn't exist` | Run `pnpm exec playwright install chromium`. |
| StudySpec validation fails | Run `personaut validate`, then compare required fields with the generated starter. |
| Navigation is blocked | Add the exact origin, including scheme and port, to `environment.allowedOrigins`. |
| Sessions never click | Check `safetyPolicy.allowClick` and make the task goal match visible button/link wording. |
| Everything becomes manual review | Prefer deterministic URL, text, or element success oracles. |
| Hermes preflight rejects the study | Hermes v0.1 requires a loopback URL, `concurrency: 1`, `semanticSnapshot: every_action`, and no auth or storage state. |
| Report says `uncalibrated` or `exploration_only` | This is expected without a human reference dataset; do not present the result as real-user behavior. |

## Safety and limits

- AI output is treated as untrusted input and must pass the action contract before execution.
- Browser contexts are isolated per session.
- Hidden or occluded controls are not offered to persona policy as perceived choices.
- Study safety policy gates navigation, clicking, typing, uploads, mutations, external origins, and confirmation stopping.
- Browser capability closes before browserless evaluation begins.
- Study files are trusted operator input; keep secrets in operator-controlled configuration or environment variables.
- Hermes v0.1 is restricted to loopback test environments because its CLI query is passed through process arguments; external beta and production use are intentionally blocked.
- Invalid model output gets one repair attempt; timeout and provider failures get none and never fall back silently.
- Synthetic findings support release decisions but do not replace deterministic tests, analytics, or human research.

For the full schema and trust-boundary details, see the [StudySpec contracts reference](https://github.com/lodado/playwright-spec-for-AI-Agent/blob/main/packages/contracts/README.md).

## Workspace development

When working in this monorepo, replace `pnpm exec personaut` with `pnpm personaut` and use [`examples/hidden-cta`](../../examples/hidden-cta/README.md) for the local browser fixture.
