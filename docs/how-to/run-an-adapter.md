# Run an adapter

Choose an AI backend, configure its browser access, and run one page through
`abstract-ai`, `judge`, and `review`. This guide assumes you already have a
project config and annotated specs. Start with [Get started](../get-started.md)
if you do not.

**An adapter chooses the agent. A browser provider chooses the browser.**
`QA_AI_ADAPTER` defaults to `hermes`; `QA_BROWSER_PROVIDER` defaults to `local`.
Browserbase is a browser provider, not an AI adapter. Its judge path requires
`cdp-attach`, so use Hermes or a correctly configured exec/custom adapter. Aside,
fixture, and credentials-in-prompt execution cannot use that path.

## 1. Prepare the project

- Use Node.js 20 or newer and install `playwright-spec-for-ai-agent` in the project.
- Configure a page, its staging URL, and annotated specs as in
  [Get started](../get-started.md#part-2--judge-one-of-your-own-pages).
- Run from the project root. Replace `pricing` below with your configured page.
- For a real agent, install and authenticate its CLI through your organization's
  supported setup. Installing this package does not install or sign in to Hermes,
  Aside, Claude Code, or Codex. Agent runs can incur model charges.
- For a local runner-owned browser, install `@playwright/test` and Chromium as
  described in [authentication](./authentication.md). For a public page, set
  `authRequired: false`. For a protected page, complete the adapter-specific
  authentication step below before judging.

Examples use POSIX shell syntax. Set the equivalent environment variables in
PowerShell if needed. Use a fresh shell for each recipe, or clear the previous
adapter's settings. These recipes explicitly select the local browser provider:

```bash
export QA_BROWSER_PROVIDER=local
npx playwright-spec-for-ai-agent spec --page=pricing
```

The `spec` stage reads annotations and does not call an AI adapter.

## 2. Configure an adapter

### Hermes

**Prerequisite:** a working Hermes installation with model-provider credentials
and browser tools. The harness first checks the Python installation under
`~/.hermes/hermes-agent`, then its virtual-environment CLI, then `hermes-agent`
on `PATH`. See the [resolution order](../reference/adapters.md#hermes).

**Configure:**

```bash
export QA_AI_ADAPTER=hermes
# Set this to a model supported by your existing Hermes provider.
# export HERMES_INFERENCE_MODEL='your-provider/model-name'
```

Omit `HERMES_INFERENCE_MODEL` if `~/.hermes/config.yaml` already supplies
`model.default` or `model.model`. An optional `HERMES_INFERENCE_BASE_URL`
overrides the configured endpoint. Keep provider credentials in Hermes's own
private configuration, not in `QA_AGENT_CMD` or a QA prompt.

For a protected local page, run
`npx playwright-spec-for-ai-agent login --page=pricing` and finish sign-in, or
configure an existing `storageState`. Hermes attaches to the browser the runner
provides. Each QA call uses a temporary Hermes home and disables memory tools.

In runner-owned browse sessions, Hermes also receives `qa_checkpoint` and
`qa_upload_fixture` through an isolated native plugin. A checkpoint saves the
current screenshot and ARIA snapshot under the exact planned `checkId`; the
agent should capture a dialog or progress state before it disappears. Uploads
attach only the declared fixture bytes to one main-frame file input on an
allowed page. The returned receipt records the filename, size, SHA-256 hash,
and owning check ID. It proves attachment, so the agent must still observe and
capture the application's result. An unknown upload outcome blocks automatic
retry. Fixture preflight exercises the runner upload path and verifies the
browser's file bytes without another model call. Only `executable-interaction`
checks authorize attachment; a no-confirm policy may forbid even selecting a
file because the application could submit it immediately. These tools are
unavailable in text-only runs.

**Run and verify:** use the [shared run sequence](#3-run-and-verify). `doctor`
should identify `hermes` with `auth=cdp-attach`; the result should report
`agentMeta.adapter: "hermes"` and `source: "hermes-agent"`.

### Aside

**Prerequisite:** the `aside` CLI on `PATH`, authenticated for model access, with
its own persistent browser available. The harness calls `aside exec` and, when
needed, `aside repl`.

**Configure:**

```bash
export QA_AI_ADAPTER=aside
# Optional: use a model name from your Aside setup.
# export ASIDE_QA_MODEL='your-model-name'
export ASIDE_QA_TIMEOUT_MS=600000
```

Omit `ASIDE_QA_MODEL` to use Aside's settings. `ASIDE_QA_EFFORT` is optional.
Aside ignores the turn budget; the timeout is its execution bound.

For a protected page, configure `staging.storageState` or a per-page
`storageState`. Otherwise provide `STAGING_QA_EMAIL` and `STAGING_QA_PASSWORD`
through a private environment file and pass `--env-file=<file>` to the commands.
The harness sends the prelogin script to Aside on stdin, not in the model prompt.
This browser is separate from the runner's `login` profile. State seeding uses
`document.cookie`, which cannot set httpOnly cookies. See
[authentication](./authentication.md) for the limitation and alternatives.

**Run and verify:** use the [shared run sequence](#3-run-and-verify). Expect
`aside` with `auth=self-prelogin` in `doctor` and `agentMeta.adapter: "aside"`.
Do not select Browserbase for this adapter.

### Exec with Claude Code

**Prerequisite:** an authenticated `claude` CLI and a Playwright MCP server
configuration supported by your installed versions. The browser tool must
inherit `PLAYWRIGHT_MCP_CDP_ENDPOINT` and attach to it. Merely setting
`QA_AGENT_AUTH` does not add that capability to a CLI.

Create `qa-mcp.json` in the project root:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--isolated", "--headless"]
    }
  }
}
```

This example resolves the MCP package when the agent starts. For reproducible
runs, pin a version your team has tested or use your existing installed server.
Do not hard-code a CDP endpoint in the file.

**Configure:**

```bash
export QA_AI_ADAPTER=exec
export QA_AGENT_AUTH=cdp-attach
export QA_AGENT_CMD='claude -p --output-format json --mcp-config ./qa-mcp.json --allowed-tools mcp__playwright'
```

Configure protected-page authentication with the runner's `login` or
`storageState` flow. `--allowed-tools` permits the configured browser tools, so
use a staging account whose permissions match the intended test.

**Run and verify:** use the [shared run sequence](#3-run-and-verify). Expect
`exec` with `auth=cdp-attach`. The adapter supports a Claude-style `result`
containing a JSON object or a JSON string, including one fenced JSON block.

### Exec with Codex

**Prerequisite:** an authenticated `codex` CLI that accepts prompts on stdin and
writes its final answer to stdout in plain execution mode, plus a compatible
Playwright MCP server. Check the flags against your installed CLI version.

Add this server to your existing `~/.codex/config.toml`. Merge it without
replacing your other settings or defining the same server twice:

```toml
[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@latest", "--isolated", "--headless"]
env_vars = ["PLAYWRIGHT_MCP_CDP_ENDPOINT"]
```

The environment allowlist passes the runtime CDP endpoint to the server. Apply
your organization's Codex workspace-trust and tool-permission policy before
running unattended. Pin the MCP version for reproducibility as described above.

**Configure:**

```bash
export QA_AI_ADAPTER=exec
export QA_AGENT_AUTH=cdp-attach
export QA_AGENT_CMD='codex exec -'
```

The trailing `-` requests stdin. Keep the MCP argument array in TOML rather than
nesting shell and TOML quotes inside `QA_AGENT_CMD`. The harness does not run a
shell and its tokenizer is not a full shell parser.

Do **not** add `--json` to this recipe: Codex's JSON event stream is not the same
as a Claude-style `result` envelope. The adapter does not decode Codex
`item.completed`/`agent_message` events. It needs the final stage JSON on stdout.
If your CLI version cannot provide that output, use a wrapper that emits only
the final JSON, or a [custom adapter](./add-an-adapter.md).

**Run and verify:** configure protected-page authentication with the runner's
`login` or `storageState` flow, then use the [shared run sequence](#3-run-and-verify).
Expect `exec` with `auth=cdp-attach`. Inspect the raw output if parsing fails.
These Claude/Codex recipes describe the harness's input/output contract, not a
claim that every CLI/MCP version has been tested end to end.

### Fixture

**Prerequisite:** no agent CLI, model credentials, or browser tools. Fixture
returns deterministic JSON in-process and does not spawn a CLI.

**Configure and run the bundled demo:**

```bash
npx playwright-spec-for-ai-agent demo --keep
```

The demo selects fixture itself and serves the bundled app locally. It makes no
model call and needs no external staging site. `--keep` retains the throwaway
project so you can inspect its outputs.

To select fixture in your own project instead:

```bash
export QA_AI_ADAPTER=fixture
# Optional: directory containing abstract.json, judge.json, and/or review.json.
# export QA_FIXTURE_DIR='./qa-fixtures'
```

Omit `QA_FIXTURE_DIR` to use built-ins. If set, the directory must exist. A
missing stage file falls back to that stage's built-in fixture. Then use the
shared run sequence. The fixture adapter itself is offline, but `judge` still
performs normal staging preflight checks. Use the bundled demo for a self-contained
exercise, and never treat replayed output as evidence of real browsing.

**Verify:** the built-in judge returns `manual_review` with `HARNESS_DEFECT`,
and review is `flagged`. Review exits 1 intentionally; the demo as a whole exits
0. No page was browsed or verified by the fixture agent.

### Custom module

Implement or install an adapter following [Add an adapter](./add-an-adapter.md),
then select its module from the project root:

```bash
export QA_AI_ADAPTER='./qa/my-adapter.mjs'
```

Its exported `run(query, maxTurns, options)` must return parsed JSON, directly or
through a Promise. Async adapters should declare `blocksEventLoop: false` only
when they keep the runner responsive. Declare browser/auth capabilities accurately and test against the documented
contract, using the repository's adapter contract tests as examples, before the
shared sequence below.

## 3. Run and verify

With one adapter configured, run these commands in order:

```bash
npx playwright-spec-for-ai-agent doctor --page=pricing
npx playwright-spec-for-ai-agent abstract-ai --page=pricing
npx playwright-spec-for-ai-agent judge --page=pricing
npx playwright-spec-for-ai-agent review --page=pricing
npx playwright-spec-for-ai-agent show --page=pricing
```

Resolve relevant `doctor` failures first. Without `--check-network`, doctor is
an environment/configuration check, not proof of valid provider authentication,
a working browser tool, or a successful model call. `abstract-ai`, `judge`, and
`review` invoke the selected real adapter and may incur charges. Review requires
a judgment and its evidence packet.

Verify the reported adapter, then inspect the generated judgment and evidence in
your configured output directory. `agentMeta.adapter` identifies the backend;
for `exec`, `agentMeta.model` contains the command string, not a verified model ID.
A completed command does not imply a passing verdict. Check per-test coverage,
evidence, and any `manual_review`, `flagged`, or harness-defect findings. See
[Artifacts](../reference/artifacts.md) and [Troubleshooting](../troubleshooting.md).

## Use Browserbase instead of local Chromium

Keep the adapter selection and follow [Run QA in Browserbase](./browserbase.md)
for private secrets, Context login, doctor, and judge commands. Only a
`cdp-attach` adapter is accepted, and `--credentials-in-prompt` is rejected.

On local exec runs, a pre-existing `PLAYWRIGHT_MCP_CDP_ENDPOINT` wins over the
runner's forwarded value. Clear a stale override if the agent uses the wrong
browser. On Browserbase runs, the isolated agent worker overrides both
`BROWSER_CDP_URL` and `PLAYWRIGHT_MCP_CDP_ENDPOINT` with the allocated session.
The parent environment is unchanged. Do not override the endpoint in MCP config.

Browserbase runs the agent in a separate process so a synchronous CLI cannot
freeze the owning CDP connection. This does not enable the local HAR-based or
live interception guards on the remote path. Follow the provider guide's evidence
and safety limits. Offline checks do not establish real cloud or model validation.

## Related pages

- [Adapters reference](../reference/adapters.md): variables, capabilities, errors.
- [Authenticate a judge run](./authentication.md): local session setup.
- [Run QA in Browserbase](./browserbase.md): remote browser setup and limitations.
- [Add an adapter](./add-an-adapter.md): the custom module contract.
