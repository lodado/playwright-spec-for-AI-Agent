# Configuration

Every command resolves its project config once, at startup, from three layers —
**CLI flag > environment variable > config file > built-in default**.

## Config file discovery

Commands search upward from the current directory (or from `--project-root=`)
and take the first match:

```
playwright-spec-for-ai-agent.config.mjs | .js | .cjs | .json
hermes-qa.config.mjs | .js | .cjs | .json                 (legacy)
playwright-spec-qa.config.mjs | .js | .cjs | .json        (legacy)
```

`--config=<path>` skips the search. The file must default-export a plain object.
`root` defaults to the config file's directory, or the current directory when
there is no config file.

## `defineConfig`

`defineConfig` is an identity function. It exists so editors autocomplete and
type-check the config through its JSDoc typedefs, with no build step:

```js
import { defineConfig } from "playwright-spec-for-ai-agent/config";

export default defineConfig({ /* ... */ });
```

## Strict config

Unknown keys, wrong types, invalid URLs, and placeholder base URLs are reported
as `[qa-config] …` warnings by default. `--strict-config` (or
`QA_STRICT_CONFIG=1`) turns them into a usage error (exit 2). Unknown keys get a
closest-match suggestion: `unknown config key "staging.baseURL" — did you mean
"baseUrl"?`. Recommended in CI.

`doctor` captures these warnings into its table instead of letting them scroll
away above the output.

## Top-level keys

Only these eight are recognised: `root`, `paths`, `pages`, `targetPaths`,
`staging`, `fixtures`, `livePolicies`, `hooks`.

| Key            | Type                | Purpose                                                              |
| -------------- | ------------------- | -------------------------------------------------------------------- |
| `root`         | string              | Project root. Default: config file directory, else cwd.              |
| `paths`        | object              | `specDir` / `outputDir` templates.                                   |
| `pages`        | object              | Per-page settings, keyed by page slug.                               |
| `targetPaths`  | `{page: path}`      | Legacy alias of `pages.{page}.targetPath`. Still honoured.           |
| `staging`      | object              | Defaults applied to every page.                                      |
| `fixtures`     | `{name: repoPath}`  | Default upload fixtures for every page.                              |
| `livePolicies` | object              | Custom `@qa-live-policy` names (see below).                          |
| `hooks`        | object              | `onJudgment` / `onReview` callbacks.                                 |

### `paths`

| Key         | Default                     | Notes                                     |
| ----------- | --------------------------- | ----------------------------------------- |
| `specDir`   | `src/page/{page}/__tests__` | `{page}` and `{root}` are substituted.    |
| `outputDir` | `src/page/{page}/__QA__`    | Same templating.                          |

Override order for both: `--spec-dir=` / `--output-dir=` flag >
`pages.{page}.specDir` / `.outputDir` > `paths.*`. The output directory has two
extra environment overrides that win over everything: `QA_OUTPUT_DIR` (all
pages) and `DASHBOARD_QA_OUTPUT_DIR` (only the page named `dashboard`).

### `staging` and `pages.{page}`

`staging` sets defaults; a `pages.{page}` entry overrides them for one page.
Both accept the same account and URL keys.

| Key                          | Type              | Meaning                                                                                     |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `baseUrl`                    | string (URL)      | Staging origin. Env `STAGING_QA_BASE_URL` and `--base-url=` win over it.                    |
| `loginPath`                  | string            | Login path. Env `STAGING_QA_LOGIN_PATH` / `--login-path=` win.                              |
| `authRequired`               | boolean           | Default `true`. `false` skips login entirely for that page.                                 |
| `expectedAccountState`       | string            | The `@qa-scenario` account state to judge against, e.g. `ACTIVE`. Uppercased.               |
| `expectedSubscriptionStatus` | string            | Legacy alias of `expectedAccountState`. Still read.                                         |
| `expectedPlan`               | string            | Plan label the scenarios assume.                                                            |
| `accountNotes`               | string            | Free text forwarded verbatim into the agent prompt.                                         |
| `fixtures`                   | `{name: path}`    | Upload fixtures, repo-relative. Merged root → `staging` → page.                             |
| `allowedOrigins`             | `string[]｜false` | Origins the browser layer may navigate to. See below.                                       |
| `versionUrl`                 | string (URL)      | Deploy-version endpoint used by `nightly` to skip an unchanged build.                       |
| `dashboardPath`              | string            | `staging` only. Default path used when building login context.                              |

`pages.{page}` additionally accepts:

| Key          | Meaning                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| `targetPath` | Path joined onto the effective `baseUrl`.                                   |
| `pageUrl`    | Absolute URL. Wins over `targetPath`. `--target-path=` still wins over both.|
| `specDir`    | Per-page override of `paths.specDir`.                                       |
| `outputDir`  | Per-page override of `paths.outputDir`.                                     |

A page that sets its own `baseUrl` does **not** inherit the global
`allowedOrigins` — otherwise a second app in a monorepo would be pinned to the
first app's origin and every navigation would be blocked.

### `allowedOrigins`

Defaults to the single origin derived from the effective `baseUrl`. Set an
explicit array to widen it, or `false` to disable origin pinning altogether. A
placeholder or unparseable `baseUrl` yields an empty list, which means "no
restriction" — pinning needs a real origin to pin to.

What it does depends on the adapter: an adapter that leaves the Node event loop
free gets live request interception (off-origin main-frame navigations are
aborted); a blocking adapter gets the same coverage from post-run HAR
inspection. See [verdicts.md](./verdicts.md).

### `versionUrl`

`nightly` fetches it before judging and looks for the first of `buildId`,
`build`, `version`, `commit`, `sha`, `revision` in a JSON body (a plain-text
body is used as-is, truncated to 200 characters). When that build id matches the
one the last **passing** judgment ran against *and* the spec hash is unchanged,
`judge` and `review` are skipped. `--force-judge` overrides. An unreachable or
non-OK endpoint judges anyway — the gate is a cost optimisation, never a block.

### `livePolicies`

Keys are **`@qa-live-policy` annotation names**, and the block is consulted
*before* the built-in table — so it can add a new name or redefine a built-in
one. Each entry must name a `liveRunPolicy` from this list, or the run fails:

```
executable-readonly
executable-interaction
judgment-interaction-no-confirm
judgment-mock-api
blocked-subscription-mutation
blocked-auth-mock
blocked-live-skip
```

```js
livePolicies: {
  // enables `// @qa-live-policy: cancel-subscription` in a spec file
  "cancel-subscription": { liveRunPolicy: "blocked-subscription-mutation" },
},
```

`stagingMode` is optional; it defaults to the staging mode of the built-in
policy that shares the same `liveRunPolicy`. An entry whose `liveRunPolicy` is
not in the list is dropped by the config layer, and a spec that then uses that
annotation name fails with `Unknown @qa-live-policy: …`.

### `hooks`

Both must be functions; anything else is a config issue.

```js
hooks: {
  onJudgment: ({ page, judgment, paths, target }) => { /* ... */ },
  onReview: review => { /* ... */ },
}
```

A hook runs after the artifact is written. A throwing hook is caught and logged
as `[hooks] onJudgment failed: …` — a hook can notify, but it can never change
what the run decided.

## Environment variables

Loaded from `./.env` (or `--env-file=<path>`) at CLI startup. **Real environment
variables always win** over the file; the CLI prints `[env] <path>: N applied, M
already set in the environment (kept)`. `QA_NO_ENV_FILE=1` disables loading.
Node older than 20.12 cannot parse env files and the load is skipped with a
message.

| Variable                                 | Used by                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `STAGING_QA_EMAIL`                       | `login`, `judge` (credentials-in-prompt mode)                            |
| `STAGING_QA_PASSWORD`                    | same                                                                     |
| `STAGING_QA_BASE_URL`                    | staging origin; wins over config                                         |
| `STAGING_QA_LOGIN_PATH`                  | login path                                                               |
| `STAGING_QA_DASHBOARD_PATH`              | dashboard path                                                           |
| `STAGING_QA_AUTH_REQUIRED`               | `false`/`0`/`no`/`off` skips login                                       |
| `STAGING_QA_EXPECTED_ACCOUNT_STATE`      | expected `@qa-scenario` account state                                    |
| `STAGING_QA_EXPECTED_SUBSCRIPTION_STATUS`| legacy alias of the above                                                |
| `STAGING_QA_EXPECTED_PLAN`               | expected plan label                                                      |
| `STAGING_QA_ACCOUNT_NOTES`               | free-text note forwarded to the prompt                                   |
| `QA_STRICT_CONFIG=1`                     | same as `--strict-config`                                                |
| `QA_OUTPUT_DIR`                          | output directory for every page                                          |
| `DASHBOARD_QA_OUTPUT_DIR`                | output directory for the `dashboard` page only                           |
| `QA_NO_ENV_FILE=1`                       | do not load `.env`                                                       |
| `QA_AI_ADAPTER`                          | adapter name or module specifier — see [adapters.md](./adapters.md)      |
| `QA_JUDGE_MAX_TURNS`                     | override the judge's computed turn budget                                |
| `QA_RECORD_VIDEO`                        | any truthy value records the judge session as webm                       |
| `QA_FIXTURE_DIR`                         | directory of `<stage>.json` files for the `fixture` adapter              |
| `QA_AGENT_CMD`                           | agent CLI for the `exec` adapter                                         |
| `QA_AGENT_AUTH`                          | `cdp-attach` to declare the exec CLI honours `BROWSER_CDP_URL`           |
| `QA_AGENT_TIMEOUT_MS`                    | `exec` adapter timeout (default 600000)                                  |
| `HERMES_INFERENCE_MODEL`                 | Hermes model; otherwise read from `~/.hermes/config.yaml`                |
| `HERMES_INFERENCE_BASE_URL`              | self-hosted / proxy inference endpoint                                   |
| `HERMES_QA_TIMEOUT_MS`                   | Hermes adapter timeout (default 600000)                                  |
| `HERMES_QA_DISABLED_TOOLSETS`            | override the toolsets disabled in text-only stages                       |
| `HERMES_QA_COMMAND`                      | reserved: any value other than `hermes-agent` aborts the run             |
| `ASIDE_QA_MODEL` / `ASIDE_QA_EFFORT`     | Aside model and effort; otherwise Aside's own settings apply             |
| `ASIDE_QA_TIMEOUT_MS`                    | Aside adapter timeout (default 600000)                                   |
| `ASIDE_QA_COMMAND`                       | reserved: any value other than `aside` aborts the run                    |
| `BROWSER_CDP_URL`                        | set by `judge` for the agent; do not set it yourself                     |
| `SLACK_WEBHOOK_URL`                      | required by `slack`                                                      |
| `CI`                                     | when set, `judge` never prompts interactively                            |
| `GITHUB_STEP_SUMMARY`                    | when set, `judge`/`report` append markdown to it                         |
| `GITHUB_SERVER_URL` / `GITHUB_REPOSITORY` / `GITHUB_RUN_ID` | build the Slack "GitHub Actions" run link            |
| `USER`                                   | default `--by=` for `ack`                                                |
