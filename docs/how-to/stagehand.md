# Run QA with Stagehand

Stagehand is an optional, model-configurable adapter, not a replacement for the
QA pipeline or a requirement to use Claude Code, Codex, or Hermes. The browser
runs locally; external model API requests are billed by your model provider.
CLI subscription credentials are not reused.

## Install and configure

In the project you are inspecting:

```sh
npm install --save-dev @browserbasehq/stagehand@3.7.3
export QA_AI_ADAPTER=stagehand
export QA_BROWSER_PROVIDER=local
export QA_STAGEHAND_MODEL=openai/gpt-4.1-mini
export OPENAI_API_KEY=... # keep the real value in your secret manager/env file
```

The adapter is tested against **3.7.3**, not v4, which has a different API.
The SDK's `experimental` flag is enabled for structured agent output and abort
signals; `disableAPI: true` keeps execution out of the hosted Stagehand API.
Stagehand requires Node **^20.19.0 or >=22.12.0**; other adapters retain this
package's existing Node requirements. No SDK is imported for other adapters.

Use an explicit provider/model supported by Stagehand v3. Provider-native keys
such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` are supported. Alternatively set
`QA_STAGEHAND_API_KEY`. `QA_STAGEHAND_BASE_URL` overrides the model endpoint;
compatibility and tool-calling quality depend on that endpoint. A local browser
does **not** mean a local or free model.

## Prepare a session, then inspect a page

```sh
npx playwright-spec-for-ai-agent doctor --page=dashboard
npx playwright-spec-for-ai-agent login --page=dashboard
npx playwright-spec-for-ai-agent judge --page=dashboard
```

For a multi-state spec, if you have independently confirmed the signed-in account
state, pass its exact scenario ID (for example `--state=INACTIVE`). The local
state-discovery phase currently precedes the runner's CDP session; if discovery
cannot attach, the harness falls back to judging every scenario. An observed
state override avoids that extra work; never guess a state to manufacture a pass.

You can also use an existing project-configured `storageState`, or explicitly
attach to a dedicated signed-in QA browser using `--cdp-url=http://127.0.0.1:9222`.
The runner supplies `BROWSER_CDP_URL`; the adapter never launches an unrelated
browser or sends staging credentials to a different agent as a fallback.

Use a dedicated staging account. An externally attached browser has the existing
harness limitations: no launch-time HAR/video and no request interception on
that attach path. Screenshots/ARIA may include other tabs in its default context.
Prefer the runner-owned login profile for isolation and live request guards.

## What each stage does

- `abstract-ai` / `review`: call the configured SDK model client without browser
  initialization or tools. They do not invoke Hermes.
- `judge`: attach Stagehand's DOM agent to the runner's browser. Request a
  structured final QA JSON object; preserve the existing check schema, evidence
  reconciliation and downgrade-only verdict rules. Task completion is not a QA
  pass; incomplete execution is an adapter error.
- The harness owns screenshots, ARIA, traces and session cleanup. Stagehand
  disconnects from an externally owned browser rather than closing that browser.

The SDK runs in an isolated async worker so the parent event loop can service
Playwright guards. A hard deadline terminates the worker, and partial logs plus
final output go through the existing secret-redaction and artifact pipeline.
Text and browse stages share the same model selection. Browse tool support can
differ by provider/model, so validate your chosen model before a full batch.

## Limits and diagnostics

| Variable | Default | Meaning |
| --- | --- | --- |
| `QA_STAGEHAND_MODEL` | required | Explicit provider/model; no silently billed default |
| `QA_STAGEHAND_API_KEY` | provider environment | Optional model key override |
| `QA_STAGEHAND_BASE_URL` | provider default | Optional model endpoint override |
| `QA_STAGEHAND_TIMEOUT_MS` | `120000` | Hard wall-clock deadline, including SDK startup/cleanup |
| `QA_STAGEHAND_MAX_STEPS` | `20` | Browse step ceiling; the smaller harness turn budget wins |

`doctor` checks the pinned dependency, Node version, explicit model, limits and
recognized key presence without calling the model. It cannot validate billing,
key validity or staging login without a live run.

Free model tiers may have daily request quotas and per-minute input-token limits.
A non-empty key does not guarantee enough quota for an interactive QA run. Keep
provider/quota failures separate from product failures; the run's invalid marker
prevents a previous successful report from being mistaken for the failed run.

The pinned SDK has a substantial transitive dependency tree. Review your package
manager's audit output before adopting it in a production environment; pinning
the compatible API does not imply that all transitive security advisories are
resolved.

Start with the `local` provider. Browserbase compatibility is not yet validated
for this adapter. Speed is not guaranteed by replacing Hermes: compare equal
plans/models/evidence, startup-inclusive elapsed time, retries and final verdicts.
