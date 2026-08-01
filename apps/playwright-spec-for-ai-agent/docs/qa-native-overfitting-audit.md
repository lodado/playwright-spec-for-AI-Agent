# QA Native overfitting audit

This audit checks whether production behavior depends on one consumer
application's routes, product names, account states, DOM labels, fixture values,
or repository layout. Test fixtures and documentation examples are not runtime
overfitting unless production code uses them as rules.

## Audit criteria

A finding is considered runtime overfitting when at least one of these is true:

1. A prompt teaches the model a consumer-specific product value as a general
   semantic rule.
2. A branch selects behavior from a hard-coded consumer route, page name,
   endpoint, plan, status, locator, or visible string.
3. A default works only for one application's page inventory when a generic
   derivation is available.
4. A parser guesses authority from application-domain syntax rather than an
   explicit QA annotation.
5. A reporter or judge treats one repository layout or business domain as
   evidence.

## Module-by-module result

| Module                                         | Result                             | Evidence and decision                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`                           | Pass                               | Contains protocol vocabulary, versions, limits, and action contracts only. No consumer route, label, or product state controls validation.                                                                                                            |
| `scripts/playwright-ast-parser.mjs`            | Pass                               | Parses TypeScript/Playwright syntax structurally. Examples live in tests, not runtime branches.                                                                                                                                                       |
| `scripts/dashboard-spec-parser.mjs`            | Pass with legacy debt              | Active `parsePlaywrightSource` requires explicit `@qa-live-policy`. Historical subscription/mock inference exports and the filename are retained for compatibility but are not called to grant current runtime authority.                             |
| `scripts/expectation-abstractor.mjs`           | Fixed                              | Removed the `Credit` template/count and `user is on ... plan` runtime special cases. The AST compatibility path now keeps unresolved templates exact and only applies shape-based numeric/format rules.                                               |
| `scripts/hermes-qa-project-config.mjs`         | Fixed                              | `expectedScenario` is now the generic selection key and unconfigured targets derive as `/<page>`. `expectedSubscriptionStatus`, dashboard output environment support, and the FSD-style default spec directory remain compatibility aliases/defaults. |
| `scripts/hermes-runner.mjs`, `packages/hermes-transport` | Pass                    | The runner is a re-export of the shared transport. The transport owns generic Hermes CLI discovery, ephemeral homes, JSON extraction, redaction, and protocol checks; it contains no consumer route, product state, or repository-layout branch.       |
| `scripts/hermes-runner-smoke.mjs`               | Pass                               | The optional operator smoke test verifies only the generic Hermes CLI protocol and inference credential with a fixed JSON echo. It does not inspect or configure a consumer application.                                                             |
| `packages/adapter-playwright`                  | Pass with compatibility vocabulary | Static policy is annotation-owned. `blocked-subscription-mutation` remains as an explicit legacy deny label; it does not infer a subscription operation or grant extra capability.                                                                    |
| `packages/abstract-playwright`                 | Pass                               | Uses source, manifest test IDs, reviewed GWT, and generic classifications. It contains no consumer paths, status values, or DOM labels.                                                                                                               |
| `packages/provider-hermes`                     | Fixed                              | Removed consumer-specific pricing tiers/statuses and exact sample counts from production prompts. Prompts now describe generic tier/status/container context and independently observable counts.                                                     |
| `packages/core`                                | Pass                               | Plans from QA IR, capabilities, milestones, budgets, and origins. No application-domain branch was found.                                                                                                                                             |
| `packages/provider-playwright`                 | Pass                               | Operates generic Playwright pages, observed elements, network methods, origins, and fixtures. Network side effects derive from the scenario click lease: read-only permits GET/HEAD, click-enabled permits all methods and WebSocket on exact leased origins. No consumer endpoint or locator is privileged. |
| `packages/evidence`                            | Pass                               | Redaction, limits, content hashing, HMAC, and archive structure are content-agnostic.                                                                                                                                                                 |
| `packages/cli/qa-native-adaptive-evidence.mjs` | Pass                               | Validates shared action and milestone contracts; it does not recognize application states.                                                                                                                                                            |
| `packages/judge`                               | Pass                               | Consumes QA IR semantics and sealed evidence. Verdict mapping contains no consumer page or business-domain rule.                                                                                                                                      |
| `packages/review`                              | Pass                               | Reuses the bounded semantic evidence projection and checks grounding only.                                                                                                                                                                            |
| `packages/cli/*`                               | Pass                               | CLI handlers compose configured paths, providers, contracts, and artifacts. Page-specific values enter through config or compiled QA IR.                                                                                                              |
| `bin/qa-native.mjs`                            | Pass                               | The executable only wires command names to CLI handlers and forwards arguments. It contains no page inventory, consumer path, policy inference, or business-domain default.                                                                            |
| `packages/repository-provider`                 | Pass                               | Repository paths and revisions are supplied and bounded; no framework-specific source directory is assumed.                                                                                                                                           |
| `packages/remediation`                         | Pass                               | Patch limits and verification stages are generic. Commands come from trusted config rather than a consumer package script name.                                                                                                                       |
| `packages/reporter-markdown`                   | Pass                               | Renders supplied artifacts without recognizing consumer states.                                                                                                                                                                                       |
| `packages/reporter-github`                     | Pass                               | Publication, fingerprints, labels, and occurrence records derive from authenticated results rather than application names.                                                                                                                            |

## Changes made by this audit

### Generic abstraction prompts

Removed prompt examples tied to one pricing implementation:

- product tiers and subscription status names;
- one consumer's exact summary counts;
- plan/subscription-specific reviewer wording.

The replacement rule is structural: keep an initial value in Given only when it
is independently visible before the flow and materially changes Then. Preserve
product context by scoping Then to its relevant container or label.

### Generic AST expectation compatibility

Removed the consumer-derived `Credit` and plan-label branches from the legacy
AST expectation adapter. Unknown template expressions now remain exact rather
than being rewritten into an unrelated product label. Numeric, percentage,
score, and date rules remain because they derive from value shape rather than a
consumer product name.

### Generic page configuration

Preferred configuration:

```js
export default {
  staging: {
    expectedScenario: "READY",
  },
  pages: {
    "account/settings": {
      targetPath: "/app/account/settings",
    },
  },
};
```

`expectedSubscriptionStatus` remains accepted so existing consumer configs do
not break. When `targetPath` is absent, `billing/settings` now derives
`/billing/settings`; there is no built-in dashboard/pricing page list.

## Accepted compatibility debt

These items look application-specific but do not currently bias the active
runtime. Removing them would be a breaking cleanup rather than a bug fix:

| Item                                              | Why retained                                                                      | Removal trigger                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `dashboard-spec-parser.mjs` filename              | Existing imports and direct script consumers                                      | next major version with a generic re-export migration                         |
| legacy subscription/mock inference exports        | Existing direct consumers may still call them; active parser does not             | usage telemetry or a major-version removal plan                               |
| `expectedSubscriptionStatus`                      | Existing config compatibility                                                     | major version after `expectedScenario` migration period                       |
| `DASHBOARD_QA_OUTPUT_DIR`                         | Legacy environment compatibility; not used by the current QA Native run directory | removal of the legacy output API                                              |
| `src/page/{page}/__tests__` default               | Existing zero-config FSD consumers; fully configurable through `paths.specDir`    | major version or evidence that generic `tests/{page}` is the dominant default |
| `subscription-mutation` / `auth-mock` annotations | Explicit fail-closed aliases, not inferred authority                              | generic annotation migration with old aliases preserved for artifact reads    |

## Regression guard

Provider prompt tests assert that consumer-specific tier/status wording is absent
and that generic Given/When/Then rules remain present. Config tests cover the new
generic selector, nested page-derived target paths, and the legacy selector
alias.
