# Configuration reference

Every project-config key and environment variable the CLI reads, with its type,
default, and whether it is required. Written for someone writing or auditing
`playwright-spec-for-ai-agent.config.mjs` in their own repository.

Every command resolves its config once, at startup, from four layers:

**CLI flag > environment variable > config file > built-in default.**

The flags themselves are in the [CLI reference](./cli.md).

## Config file discovery

Commands search upward from the current directory — or from `--project-root=` —
and take the first file that exists. The order within a directory is:

```
playwright-spec-for-ai-agent.config.mjs | .js | .cjs | .json
hermes-qa.config.mjs | .js | .cjs | .json                 (legacy)
playwright-spec-qa.config.mjs | .js | .cjs | .json        (legacy)
```

`--config=<path>` skips the search. The file must default-export a plain
object; anything else exits 2 with
`Config file must export a plain object (default export).`

`root` defaults to the config file's directory, and to the current directory
when there is no config file. `--project-root=` overrides both.

## `defineConfig`

`defineConfig` is an identity function. It exists so editors autocomplete and
type-check the config through its JSDoc typedefs, with no build step.

```js
// playwright-spec-for-ai-agent.config.mjs
import { defineConfig } from "playwright-spec-for-ai-agent/config";

export default defineConfig({
  staging: { baseUrl: "https://staging.acme.dev", loginPath: "/login" },
  pages: {
    pricing: { targetPath: "/pricing", authRequired: false },
  },
});
```

That is a complete, working config. Everything else on this page is optional.

## Top-level keys

Exactly these eight are recognised. Any other top-level key is an unknown-key
issue (see [Validation](#validation-and-errors)).

| Key            | Type                  | Default                      | Required | Meaning                                              |
| -------------- | --------------------- | ---------------------------- | -------- | ------------------------------------------------------ |
| `root`         | string                | config file directory, else cwd | no    | Project root. Every relative path resolves from it.  |
| `paths`        | object                | see [`paths`](#paths)        | no       | `specDir` and `outputDir` templates.                 |
| `pages`        | `{slug: object}`      | `{}`                         | no       | Per-page settings, keyed by page slug.               |
| `targetPaths`  | `{slug: string}`      | `{}`                         | no       | Legacy alias of `pages.{page}.targetPath`.           |
| `staging`      | object                | see [`staging`](#staging-and-pagespage) | no | Defaults applied to every page.                  |
| `fixtures`     | `{name: repoPath}`    | `{}`                         | no       | Default upload fixtures for every page.              |
| `livePolicies` | `{name: object}`      | `{}`                         | no       | Project-specific `@qa-live-policy` names.            |
| `hooks`        | object                | `{}`                         | no       | `onJudgment` and `onReview` callbacks.               |

### `paths`

| Key         | Type   | Default                     | Required | Meaning                                      |
| ----------- | ------ | --------------------------- | -------- | ---------------------------------------------- |
| `specDir`   | string | `src/page/{page}/__tests__` | no       | Where `spec` looks for `*.spec.ts`.          |
| `outputDir` | string | `src/page/{page}/__QA__`    | no       | Where every stage writes its artifacts.      |

`{page}` and `{root}` are substituted in both.

Override order for `specDir`: `--spec-dir=` > `pages.{page}.specDir` >
`paths.specDir`.

Override order for `outputDir`: `QA_OUTPUT_DIR` > `DASHBOARD_QA_OUTPUT_DIR`
(only for the page named `dashboard`) > `--output-dir=` >
`pages.{page}.outputDir` > `paths.outputDir`. The two environment variables win
over the flag, which is the one place where the standard resolution order does
not hold.

### `staging` and `pages.{page}`

`staging` sets defaults for every page; a `pages.{page}` entry overrides them
for one page. Both accept the same account and URL keys.

| Key                          | Type              | Default                | Required | Meaning                                                                       |
| ---------------------------- | ----------------- | ---------------------- | -------- | ------------------------------------------------------------------------------- |
| `baseUrl`                    | string (URL)      | `https://your-staging-url.example.com` | in practice | Staging origin. `STAGING_QA_BASE_URL` and `--base-url=` win over it. The built-in default is a placeholder that validation rejects, so a live run needs a real value. |
| `loginPath`                  | string            | `/login`               | no       | Login page path. `STAGING_QA_LOGIN_PATH` and `--login-path=` win.             |
| `authRequired`               | boolean           | `true`                 | no       | `false` skips login entirely for that page.                                    |
| `expectedAccountState`       | string            | `""`                   | no       | The `@qa-scenario` account state to judge against, for example `ACTIVE`. Uppercased. |
| `expectedSubscriptionStatus` | string            | `""`                   | no       | Legacy alias of `expectedAccountState`. Still read.                            |
| `expectedPlan`               | string            | `""`                   | no       | Plan label the scenarios assume.                                               |
| `accountNotes`               | string            | `""`                   | no       | Free text forwarded verbatim into the agent prompt.                            |
| `fixtures`                   | `{name: path}`    | `{}`                   | no       | Upload fixtures, repo-relative. Merged `fixtures` → `staging` → page.          |
| `allowedOrigins`             | `string[] ｜ false` | the `baseUrl` origin | no       | Origins the browser layer may navigate to. See [`allowedOrigins`](#allowedorigins). |
| `versionUrl`                 | string (URL)      | none                   | no       | Deploy-version endpoint `nightly` uses to skip an unchanged build.              |
| `storageState`               | string (path)     | none                   | no       | Playwright storage state holding an existing session. See [`storageState`](#storagestate). |
| `dashboardPath`              | string            | `/dashboard`           | no       | `staging` only. Default path used when building login context.                 |

`pages.{page}` additionally accepts:

| Key          | Type   | Default | Required | Meaning                                                                  |
| ------------ | ------ | ------- | -------- | -------------------------------------------------------------------------- |
| `targetPath` | string | none    | no       | Path joined onto the effective `baseUrl`.                                |
| `pageUrl`    | string (URL) | none | no    | Absolute URL. Wins over `targetPath`; `--target-path=` wins over both.    |
| `specDir`    | string | none    | no       | Per-page override of `paths.specDir`.                                    |
| `outputDir`  | string | none    | no       | Per-page override of `paths.outputDir`.                                  |

`judge`, `review`, `slack`, and `nightly` need a target for the page. Set
`pages.{page}.pageUrl`, `pages.{page}.targetPath`, or `targetPaths.{page}`, or
pass `--target-path=`; without one the run exits 2.

A page that sets its own `baseUrl` does **not** inherit the global
`allowedOrigins`. Otherwise a second app in a monorepo would be pinned to the
first app's origin and every navigation would be blocked.

### `allowedOrigins`

Defaults to the single origin derived from the effective `baseUrl`. Set an
explicit array to widen it, or `false` to disable origin pinning altogether. A
placeholder or unparseable `baseUrl` yields an empty list, which means "no
restriction" — pinning needs a real origin to pin to.

What enforcement looks like depends on the adapter. An adapter that leaves the
Node event loop free gets live request interception, and off-origin main-frame
navigations are aborted; a blocking adapter gets the same coverage from
post-run HAR inspection. See [Adapters](./adapters.md).

### `versionUrl`

`nightly` fetches this endpoint before judging and looks for the first of
`buildId`, `build`, `version`, `commit`, `sha`, `revision` in a JSON body. A
plain-text body is used as-is, truncated to 200 characters.

When that build id matches the one the last **passing** judgment ran against
*and* the spec hash is unchanged, `judge` and `review` are skipped.
`--force-judge` overrides. An unreachable or non-OK endpoint judges anyway: the
gate is a cost optimisation, never a block.

### `storageState`

Unset by default. Point it at a Playwright storage-state JSON that already holds
a valid session — normally the file the project's own e2e auth setup writes. A
relative path resolves from `root`, so an absolute path is used as given.
`pages.{page}.storageState` overrides `staging.storageState`.

```js
staging: {
  storageState: "playwright/.auth/user.json",
},
```

This is the session path for an app with no login form to drive: a project whose
e2e suite mints a session in code — a signed cookie, a magic token, a service
account — leaves the `login` command nothing to type. No credential enters this
tool; nothing is prompted and nothing is stored here. When a storage state is
configured, `judge` stops asking for `STAGING_QA_EMAIL` and
`STAGING_QA_PASSWORD`.

The replay happens for an adapter whose `auth` capability is `self-prelogin`
(today, `aside`). Before the judge run, the cookies whose domain matches the
target origin and that origin's `localStorage` entries are seeded into the
adapter's own browser, and the seed replaces the credential prelogin rather than
running alongside it. Cookies go in through `document.cookie`, which cannot set
an httpOnly cookie: an httpOnly cookie in the file is an environment error
naming the cookies, not a run that silently judges as an anonymous visitor. For
those, attach to a browser you already signed into with `judge --cdp-url=`,
which sets cookies over CDP.

The file must exist, parse as JSON, and contain at least one `cookies` or
`origins` entry; otherwise the run stops with a usage error naming the path.
[Authenticate a run](../how-to/authentication.md) compares the three session
paths.

### `livePolicies`

Keys are `@qa-live-policy` **annotation names**, and the block is consulted
*before* the built-in table — so it can add a new name or redefine a built-in
one.

| Key             | Type   | Default                                          | Required | Meaning                                          |
| --------------- | ------ | ------------------------------------------------ | -------- | -------------------------------------------------- |
| `liveRunPolicy` | string | none                                             | yes      | One of the seven built-in verbs.                 |
| `stagingMode`   | string | the staging mode of the built-in policy sharing the same verb | no | Overrides that inferred mode.        |

The seven verbs:

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

An entry whose `liveRunPolicy` is not in the list is reported by validation and
dropped by the config layer. A spec that then uses that annotation name fails
with `Unknown @qa-live-policy: …`. See [Annotations](./annotations.md) for how
the names reach a spec file.

### `hooks`

| Key          | Type     | Default | Required | Payload                                    |
| ------------ | -------- | ------- | -------- | -------------------------------------------- |
| `onJudgment` | function | none    | no       | `{ page, judgment, paths, target }`        |
| `onReview`   | function | none    | no       | `{ page, review, paths, packetPath }`      |

```js
hooks: {
  onJudgment: ({ page, judgment }) => console.log(`[qa] ${page}: ${judgment.status}`),
  onReview: ({ page, review }) => console.log(`[qa] ${page} review: ${review.overallReview}`),
}
```

A hook runs after the artifact is written. A throwing hook is caught and logged
as `[hooks] onJudgment failed: …` or `[qa-hooks] onReview failed: …`. A hook can
notify, but it can never change what the run decided.

## Environment variables

| Variable                                  | Read by                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `STAGING_QA_EMAIL`                        | `login`; `judge` only when it has no session path                          |
| `STAGING_QA_PASSWORD`                     | same                                                                       |
| `STAGING_QA_BASE_URL`                     | staging origin; wins over config                                           |
| `STAGING_QA_LOGIN_PATH`                   | login path                                                                 |
| `STAGING_QA_DASHBOARD_PATH`               | dashboard path                                                             |
| `STAGING_QA_AUTH_REQUIRED`                | `false`/`0`/`no`/`n`/`off` skips login; `true`/`1`/`yes`/`y`/`on` requires it |
| `STAGING_QA_EXPECTED_ACCOUNT_STATE`       | expected `@qa-scenario` account state                                      |
| `STAGING_QA_EXPECTED_SUBSCRIPTION_STATUS` | legacy alias of the above                                                  |
| `STAGING_QA_EXPECTED_PLAN`                | expected plan label                                                        |
| `STAGING_QA_ACCOUNT_NOTES`                | free-text note forwarded to the prompt                                     |
| `QA_STRICT_CONFIG=1`                      | same as `--strict-config`                                                  |
| `QA_OUTPUT_DIR`                           | output directory for every page                                            |
| `DASHBOARD_QA_OUTPUT_DIR`                 | output directory for the `dashboard` page only                             |
| `QA_NO_ENV_FILE=1`                        | do not load `.env.local` / `.env`                                          |
| `QA_AI_ADAPTER`                           | adapter name or module specifier — see [Adapters](./adapters.md)           |
| `QA_BROWSER_CDP_URL`                      | attach the judge to a browser you already run; `--cdp-url=` wins over it   |
| `QA_JUDGE_MAX_TURNS`                      | override the judge's computed turn budget (otherwise `12 + 8 × executable tests`, clamped to 20–150) |
| `QA_RECORD_VIDEO`                         | any non-empty value records webm — runner-launched browser only            |
| `QA_FIXTURE_DIR`                          | directory of per-stage `<stage>.json` responses for the `fixture` adapter  |
| `QA_AGENT_CMD`                            | agent CLI for the `exec` adapter                                           |
| `QA_AGENT_AUTH`                           | `cdp-attach` to declare the exec CLI honours `BROWSER_CDP_URL`             |
| `QA_AGENT_TIMEOUT_MS`                     | `exec` adapter timeout (default 600000)                                    |
| `HERMES_INFERENCE_MODEL`                  | Hermes model; otherwise read from `~/.hermes/config.yaml`                  |
| `HERMES_INFERENCE_BASE_URL`               | self-hosted or proxy inference endpoint                                    |
| `HERMES_QA_TIMEOUT_MS`                    | Hermes adapter timeout (default 600000)                                    |
| `HERMES_QA_DISABLED_TOOLSETS`             | override the toolsets disabled in text-only stages                         |
| `HERMES_QA_COMMAND`                       | reserved: any value other than `hermes-agent` aborts the run               |
| `ASIDE_QA_MODEL`, `ASIDE_QA_EFFORT`       | Aside model and effort; otherwise Aside's own settings apply               |
| `ASIDE_QA_TIMEOUT_MS`                     | Aside adapter timeout (default 600000)                                     |
| `ASIDE_QA_COMMAND`                        | reserved: any value other than `aside` aborts the run                      |
| `<PROVIDER>_API_KEY`                      | `doctor`'s `adapter provider` check, for the provider named in `~/.hermes/config.yaml` |
| `BROWSER_CDP_URL`                         | set by `judge` for the agent; do not set it yourself                       |
| `SLACK_WEBHOOK_URL`                       | required by `slack`                                                        |
| `CI=true` or `CI=1`                       | no interactive prompts; any other value is ignored                         |
| `GITHUB_STEP_SUMMARY`                     | when set, `judge` and `report` append markdown to it                       |
| `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID` | build the Slack "GitHub Actions" run link                  |
| `USER`                                    | default `--by=` for `ack`                                                  |

The CLI loads `./.env.local` then `./.env` at startup, and a real environment
variable beats both. The full rule is in
[Environment file load order](./cli.md#environment-file-load-order).

## Validation and errors

Unknown keys, wrong types, invalid URLs, and placeholder base URLs are collected
during config load. By default each one prints as a `[qa-config] …` warning and
the run continues. `--strict-config` or `QA_STRICT_CONFIG=1` turns the whole set
into a single usage error and exits 2. Use strict mode in CI.

| Issue                       | Message shape                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| Unknown key                 | `unknown config key "staging.baseURL" — did you mean "baseUrl"?`                          |
| Wrong type                  | `"pages.pricing.authRequired" must be a boolean, got string`                              |
| Invalid URL                 | `"staging.baseUrl" is not a valid URL: staging.acme.dev`                                  |
| Invalid `allowedOrigins`    | `"staging.allowedOrigins" must be an array of origin strings, or false to disable origin pinning` |
| Placeholder base URL        | `"staging.baseUrl" is a placeholder (https://staging.example.com) — set a real staging origin before judging` |
| Unknown live-run verb       | `"livePolicies.x.liveRunPolicy" must be one of: executable-readonly, …`                   |
| Non-function hook           | `"hooks.onJudgment" must be a function, got string`                                       |

The unknown-key suggestion is the closest allowlisted key by edit distance,
compared case-insensitively, and only when the distance is at most
`max(2, floor(key length / 3))`. Nothing near enough means no suggestion.

A base URL counts as a placeholder when it is empty, unparseable, hosted under
a reserved documentation domain — `example`, `example.com`, `example.org`,
`example.net`, **and every subdomain of them**, so `https://staging.example.com`
is rejected — or when the hostname contains `your-`, `yourdomain`, `changeme`,
or `todo`.

`doctor` captures these warnings into its table instead of letting them scroll
away above the output.

## A representative config

```js
// playwright-spec-for-ai-agent.config.mjs
import { defineConfig } from "playwright-spec-for-ai-agent/config";

export default defineConfig({
  paths: {
    specDir: "e2e/{page}",
    outputDir: "qa-output/{page}",
  },

  staging: {
    baseUrl: "https://staging.acme.dev",
    loginPath: "/login",
    authRequired: true,
    expectedAccountState: "INACTIVE",
    expectedPlan: "BASIC",
    accountNotes: "QA account on staging — do not mutate billing",
    allowedOrigins: ["https://staging.acme.dev", "https://cdn.acme.dev"],
    versionUrl: "https://staging.acme.dev/version.json",
    storageState: "playwright/.auth/user.json",
  },

  pages: {
    pricing: { targetPath: "/pricing", authRequired: false },
    settings: { targetPath: "/settings/profile" },
    billing: {
      // A second app in the monorepo: its own origin, login flow, and session.
      baseUrl: "https://billing-staging.acme.dev",
      loginPath: "/accounts/sign-in",
      targetPath: "/settings/billing",
      expectedAccountState: "ACTIVE",
      storageState: "apps/billing/playwright/.auth/user.json",
    },
  },

  fixtures: {
    avatar: "tests/fixtures/qa-avatar.png",
  },

  livePolicies: {
    "payments-mutation": { liveRunPolicy: "blocked-subscription-mutation" },
  },

  hooks: {
    onJudgment: ({ page, judgment }) => console.log(`[qa] ${page}: ${judgment.status}`),
  },
});
```

## Limits and cautions

- Config is loaded once per process. A second `loadProjectConfig()` call with
  different flags re-resolves and warns; load it once, in the entry script.
- `demo` ignores your config entirely: it generates a throwaway project and
  passes its own `--config=`.
- `targetPaths` is kept for compatibility. New configs should use
  `pages.{page}.targetPath`; both are honoured, and a `pages` entry's
  `targetPath` is copied into `targetPaths` internally.
- `expectedSubscriptionStatus` remains a supported alias of
  `expectedAccountState`. When both are present, `expectedAccountState` wins.
- The default `specDir` and `outputDir` templates assume a `src/page/{page}/`
  layout. Set `paths` for anything else.

## Related

- [CLI reference](./cli.md) — the flags that override these keys
- [Annotations](./annotations.md) — the `@qa-*` vocabulary `spec` parses
- [Adapters](./adapters.md) — `QA_AI_ADAPTER` and adapter capabilities
- [Authenticate a run](../how-to/authentication.md) — choosing a session path
- [Run it in CI](../how-to/ci.md) — strict config and secrets in a workflow
- [Troubleshooting](../troubleshooting.md) — symptom-indexed fixes
