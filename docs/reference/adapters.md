# Adapters reference

Look up which agent backend a run uses, which environment variables configure
it, and what its capability descriptor declares. This page is for an operator
choosing or debugging a backend; to write your own, see
[Add an adapter](../how-to/add-an-adapter.md).

Every stage that calls a model — `abstract-ai`, `judge`, `review` — goes through
one function:

```
run(query, maxTurns, options) -> parsed JSON
```

`QA_AI_ADAPTER` selects the backend. The default is `hermes`.

```bash
QA_AI_ADAPTER=aside npx playwright-spec-for-ai-agent judge --page=dashboard
```

The value is either a built-in name (`hermes`, `aside`, `exec`, `fixture`) or a
module specifier — anything starting with `@` or containing `/` or `.`, resolved
from the directory the command ran in.

Whichever backend ran is stamped onto the result as
`agentMeta: { adapter, model, durationMs }`, and `source` is set to the adapter
name (`hermes-agent` for `hermes`). Both come from the adapter, not from the
agent's self-reported `source`, which comes from a prompt template and is wrong
whenever the backend is swapped.

## Built-in adapters

| Name      | Runs                              | `auth`                              | `supportsMaxTurns` | `supportsToolsetDisable` | `supportsVideo` | `blocksEventLoop` |
| --------- | --------------------------------- | ----------------------------------- | ------------------ | ------------------------ | --------------- | ----------------- |
| `hermes`  | the `hermes-agent` CLI            | `cdp-attach`                        | `true`             | `true`                   | `true`          | `true`            |
| `aside`   | `aside exec`                      | `self-prelogin`                     | `false`            | `false`                  | `false`         | `true`            |
| `exec`    | the CLI named by `QA_AGENT_CMD`   | `credentials-in-prompt`<sup>1</sup> | `false`            | `false`                  | `false`<sup>1</sup> | `true`        |
| `fixture` | nothing — canned JSON, no network | `credentials-in-prompt`             | `false`            | `false`                  | `false`         | `true`            |

<sup>1</sup> `QA_AGENT_AUTH=cdp-attach` sets both `auth` and `supportsVideo` on
the `exec` adapter. Set it only when the CLI's browser tools honour
`BROWSER_CDP_URL`.

All four spawn their CLI with `spawnSync`, so all four take the descriptor
default `blocksEventLoop: true`.

### `hermes`

Runs the `hermes-agent` CLI, resolved in this order:

1. `~/.hermes/hermes-agent/venv/bin/python ~/.hermes/hermes-agent/run_agent.py`, when both exist;
2. `~/.hermes/hermes-agent/venv/bin/hermes-agent`, when it exists;
3. `hermes-agent` on `PATH`.

| Variable                       | Default                                                      | Effect                                                                   |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `HERMES_INFERENCE_MODEL`       | `model.default` (then `model.model`) in `~/.hermes/config.yaml` | The model passed as `--model`. No model anywhere is an environment error. |
| `HERMES_INFERENCE_BASE_URL`    | `base_url` in `~/.hermes/config.yaml`                        | Passed as `--base_url` for a self-hosted or proxy endpoint.               |
| `HERMES_QA_TIMEOUT_MS`         | `600000`                                                     | Wall-clock bound on the spawned process.                                  |
| `HERMES_QA_DISABLED_TOOLSETS`  | `browser,web,terminal`                                       | Toolsets disabled in text-only mode (`abstract-ai`, `review`) only.       |
| `HERMES_QA_COMMAND`            | `hermes-agent`                                               | Reserved. Any other value aborts the run with a usage error.              |

Every run boots stateless. The adapter creates a throwaway `HERMES_HOME` under
the system temp directory, copies only `auth.json`, `config.yaml`, `.env`, and
`SOUL.md` from the real `~/.hermes`, and deletes it when the process exits. The
`memory` toolset is disabled on every run, in both modes, so nothing learned in
one QA run reaches the next.

### `aside`

Runs `aside exec` and needs the `aside` CLI on `PATH`. The `maxTurns` argument
is ignored: Aside has no turn flag, so the wall-clock timeout is the only bound.

| Variable               | Default                | Effect                                                       |
| ---------------------- | ---------------------- | ------------------------------------------------------------ |
| `ASIDE_QA_MODEL`       | Aside's user settings  | Passed as `-m`. Also recorded as `agentMeta.model`.           |
| `ASIDE_QA_EFFORT`      | Aside's user settings  | Passed as `--effort`.                                        |
| `ASIDE_QA_TIMEOUT_MS`  | `600000`               | Wall-clock bound on the spawned process.                     |
| `ASIDE_QA_COMMAND`     | `aside`                | Reserved. Any other value aborts the run with a usage error.  |

Aside drives its own persistent browser, so `judge` authenticates that browser
before the run. A configured `staging.storageState` (or
`pages.{page}.storageState`) wins: its cookies and `localStorage` are seeded
into Aside's browser and `prelogin` is never called. Without one, `prelogin`
pipes a login script to `aside repl` on stdin, keeping credentials out of the
prompt, out of argv, and out of session logs. Seeding goes through
`document.cookie`, which cannot set an httpOnly cookie — see
[httpOnly session cookies cannot be seeded](../troubleshooting.md#httponly-session-cookies-cannot-be-seeded).

### `exec`

Runs whichever agent CLI a team already has. The stage prompt goes on **stdin**,
never argv, because argv is world-readable in `ps` and a credentials-in-prompt
prompt carries secrets.

```bash
QA_AI_ADAPTER=exec QA_AGENT_CMD="claude -p --output-format json" \
  npx playwright-spec-for-ai-agent judge --page=pricing
```

| Variable                | Default                  | Effect                                                                                  |
| ----------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `QA_AGENT_CMD`          | none — required          | The command line. Split on whitespace, honouring single and double quotes.                |
| `QA_AGENT_AUTH`         | unset                    | `cdp-attach` sets `auth: "cdp-attach"` and `supportsVideo: true`; any other value is ignored. |
| `QA_AGENT_TIMEOUT_MS`   | `600000`                 | Wall-clock bound on the spawned process.                                                  |

`QA_AGENT_CMD` is also recorded as `agentMeta.model`. A missing `QA_AGENT_CMD`
is an environment error carrying the fix.

#### Handing the CLI our browser

Under `QA_AGENT_AUTH=cdp-attach` the runner owns the browser and knows its CDP
endpoint only at run time, so a static MCP config file can never name it. The
adapter therefore copies `BROWSER_CDP_URL` into the child environment under the
names browser MCP servers read:

| Forwarded as                   | Read by                    |
| ------------------------------ | -------------------------- |
| `PLAYWRIGHT_MCP_CDP_ENDPOINT`  | `@playwright/mcp`          |

A value already present in the environment is never overwritten, so an operator
pointing a server somewhere else keeps that choice. Nothing is forwarded when
`QA_AGENT_AUTH` is anything but `cdp-attach`, or when no runner browser is open.

Two working invocations:

```bash
# Claude Code driving a headless Playwright MCP browser
QA_AI_ADAPTER=exec QA_AGENT_AUTH=cdp-attach \
QA_AGENT_CMD="claude -p --output-format json --mcp-config ./qa-mcp.json --allowed-tools mcp__playwright" \
  npx playwright-spec-for-ai-agent judge --page=dashboard

# Codex, same server declared inline
QA_AI_ADAPTER=exec QA_AGENT_AUTH=cdp-attach \
QA_AGENT_CMD="codex exec --json -c mcp_servers.playwright.command=npx -c mcp_servers.playwright.args=[\"-y\",\"@playwright/mcp@latest\",\"--isolated\",\"--headless\"]" \
  npx playwright-spec-for-ai-agent judge --page=pricing
```

`qa-mcp.json` needs no CDP endpoint of its own:

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

Both CLIs wrap their answer in a JSON envelope with the payload in `result`,
often fenced. The adapter unwraps one envelope and one fence, so no output
shim is needed.

A CLI whose browser cannot attach to ours should leave `QA_AGENT_AUTH` unset. It
then authenticates itself and the prompt carries staging credentials, which
`judge` warns about.

### `fixture`

Offline, deterministic, shape-correct stage output: no model, no network. It is
what `demo` and the pipeline tests run on.

| Variable          | Default | Effect                                                                              |
| ----------------- | ------- | ------------------------------------------------------------------------------------ |
| `QA_FIXTURE_DIR`  | unset   | Directory of `abstract.json`, `judge.json`, `review.json` replayed instead of the built-ins. |

The stage is inferred from the keys the caller required: `livePlan` → abstract,
`criteria` or `overallReview` → review, otherwise judge. `QA_FIXTURE_DIR` is
per-stage — a missing `<stage>.json` falls back to that stage's built-in
fixture, so you can pin only the stage you care about. A `QA_FIXTURE_DIR` that
does not exist at all is an environment error.

The built-in fixtures read the prompt they were handed, which is what lets
`QA_AI_ADAPTER=fixture` drive any project's pipeline rather than only the
bundled demo:

| Stage      | Built-in output                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `abstract` | One `livePlan` block per real scenario/test parsed from the prompt's `## Payload` JSON. With no parseable payload, one block that names no test.                     |
| `judge`    | `status: "manual_review"`, `cause: "HARNESS_DEFECT"`, summary `Fixture adapter output — nothing was browsed or verified. Not a real verdict.` One check per `### <scenario> — <title>` heading found in the prompt, each `manual_review` with `confidence: "low"` and no evidence refs. |
| `review`   | `overallReview: "flagged"`, echoing the `packetSha256` found in the prompt so the packet-digest gate sees the packet it reviewed.                                    |

An offline run therefore can never be mistaken for a green verdict, and the
echoed titles exercise the real coverage gate instead of tripping it.

## Capability descriptor

Callers branch on what a backend declares, never on its name.

```js
{
  auth: "cdp-attach" | "self-prelogin" | "credentials-in-prompt",
  supportsMaxTurns: boolean,
  supportsToolsetDisable: boolean,
  supportsVideo: boolean,
  blocksEventLoop: boolean,
}
```

Any field a backend omits falls back to the default below.

| Field                    | Type                  | Default                   | Read by                                                                                     |
| ------------------------ | --------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `auth`                   | one of three literals | `"credentials-in-prompt"` | `judge`, to pick the session path; `doctor`, to print it.                                       |
| `supportsMaxTurns`       | boolean               | `false`                   | `judge`: `false` passes `maxTurns: null` and skips the computed turn budget entirely.           |
| `supportsToolsetDisable` | boolean               | `false`                   | Nothing. Descriptive only — the `hermes` adapter disables its own toolsets without reading it.  |
| `supportsVideo`          | boolean               | `false`                   | `doctor`, to print `video=…`. Recording itself is gated by `QA_RECORD_VIDEO` plus a runner-launched browser, not by this field. |
| `blocksEventLoop`        | boolean               | `true`                    | `judge`: only `false` enables live request interception. Everything else falls back to post-run HAR inspection. |

`blocksEventLoop` is the load-bearing one. A `spawnSync` adapter freezes this
process for the whole agent run, so a Playwright `context.route` handler could
never be serviced and the browser would stall waiting for it. Origin pinning and
mutation blocking are therefore live only under `blocksEventLoop: false`;
blocking adapters get the same two checks from the recorded HAR after the run.
See [Violation floors](../explanation/how-verdicts-are-decided.md#violation-floors).

### What `auth` selects

| Value                    | Where the judge's session comes from                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `cdp-attach`             | The runner launches or attaches to a browser and hands the agent `BROWSER_CDP_URL` for the run. `--cdp-url=` / `QA_BROWSER_CDP_URL` outranks the `login` profile when both exist. |
| `self-prelogin`          | The adapter drives its own browser. The harness seeds a `storageState` into it, or calls `prelogin()`, and never sets `BROWSER_CDP_URL`. |
| `credentials-in-prompt`  | No session to hand over: staging credentials go into the prompt and therefore into the agent's session logs. `judge` prints a `[security]` warning. |

`judge --credentials-in-prompt` forces the last mode whatever the adapter
declares. Full setup for each path is in
[Authenticate a judge run](../how-to/authentication.md).

Read the resolved descriptor with `doctor`:

```
PASS  adapter   hermes (auth=cdp-attach maxTurns=true video=true blocksEventLoop=true)
```

## Timeouts

Every CLI adapter is bounded by wall clock. The default is 600000 ms (10
minutes) for all three. A timeout surfaces as an environment error naming the
variable to raise.

| Adapter   | Variable                | Default  |
| --------- | ----------------------- | -------- |
| `hermes`  | `HERMES_QA_TIMEOUT_MS`  | `600000` |
| `aside`   | `ASIDE_QA_TIMEOUT_MS`   | `600000` |
| `exec`    | `QA_AGENT_TIMEOUT_MS`   | `600000` |
| `fixture` | none                    | —        |

## Errors

| Message                                                        | Exit | Cause                                                     |
| -------------------------------------------------------------- | ---- | ----------------------------------------------------------- |
| `Unknown QA_AI_ADAPTER: "…".`                                   | 2    | Not a built-in name and not a module specifier.             |
| `QA_AI_ADAPTER module "…" was never loaded: call prepareAdapter() first.` | 2 | `runAgent` called without `await prepareAdapter()`. |
| `Hermes model is not configured. …`                             | 3    | No `HERMES_INFERENCE_MODEL` and no model in `config.yaml`.  |
| `QA_AI_ADAPTER=exec needs QA_AGENT_CMD (the agent CLI to run).`  | 3    | `exec` selected with no command.                            |
| `<Adapter> command not found: <command>.`                       | 3    | The CLI is not installed.                                   |
| `<Adapter> timed out after <n>ms.`                              | 3    | Wall-clock bound hit.                                       |
| `<Adapter> did not return valid JSON (required: …).`            | 4    | The CLI ran but its output is unusable.                     |

Exit codes are listed in [CLI reference](./cli.md). Symptom-by-symptom fixes are
in [Troubleshooting](../troubleshooting.md).

## Limits

- One module-specifier adapter per process. `prepareAdapter()` caches it, and
  changing `QA_AI_ADAPTER` mid-process re-imports.
- `runAgent` is synchronous, so `run` must return parsed JSON, not a Promise.
- `supportsToolsetDisable` is declared but unread; do not rely on it to change
  behaviour.
- `aside` ignores `maxTurns` entirely.

## Related pages

- [Add an adapter](../how-to/add-an-adapter.md) — the module contract and the
  published contract test suite.
- [Authenticate a judge run](../how-to/authentication.md) — `login`,
  `storageState`, and `--cdp-url=`.
- [Artifacts reference](./artifacts.md) — what a run writes, including
  `agentMeta` and the runner-captured evidence.
- [Configuration reference](./configuration.md) — config keys and precedence.
- [Glossary](../glossary.md)
