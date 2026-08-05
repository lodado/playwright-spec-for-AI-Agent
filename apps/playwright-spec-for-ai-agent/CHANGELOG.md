# Changelog

## 5.0.0

### Major Changes

- Release the QA Native v3 pipeline and share canonical hashing through the bundled QA kit.

## 4.0.0

### Major Changes

- Repair the cross-app spec parser import and consolidate Playwright source
  extraction into the shared playwright-spec-extract workspace package.

### Patch Changes

- Updated dependencies
  - playwright-spec-extract@0.1.1

## 3.1.0

### Minor Changes

- Add scenario-aware page selection and AI applicability filtering while hardening batch execution, evidence capture, and reporting.

## 3.0.0

### Major Changes

- Replace the v2 compiler and execution matrix with one evidence-bound AI-native pipeline.
- Persist only authority, behavior, evidence, judgment, review, and report artifacts.
- Replace legacy state/remediation config with the v3 page source, URL, and target schema.

## 2.10.4

### Patch Changes

- Harden adaptive page sweeps across abstraction review, action normalization, startup URLs, and evidence persistence.

## 2.10.3

### Patch Changes

- Remove consumer-specific assumptions and make browser network side effects follow each scenario's code-owned capability lease.

## 2.10.2

### Patch Changes

- Document the full QA Native pipeline, module mechanics, trust boundaries, artifacts, and failure states with diagrams.

## 2.10.1

### Patch Changes

- Decouple compiler schema identity and Hermes transport from orchestration modules.

## 2.10.0

### Minor Changes

- Extract explicit Given, When, and Then semantics before live applicability selection.

## 2.9.0

### Minor Changes

- Add AI-first Playwright spec extraction and judgment review with bounded independent model calls, private content-addressed artifacts, and an abstract adaptive compiler that joins AI meaning to immutable parser-owned test identities, inherited policies, fixtures, and page metadata. Large specs are extracted in bounded batches, and judges receive applicability, authored-flow, and required-route context so redirected pages cannot become false contradiction evidence.
- Retry only timed-out or invalid full-spec batches at a smaller size, and constrain live applicability to runtime-mapped scenario keys and pre-flow prerequisites so copied hashes or post-action titles cannot drop coverage.
- Limit extracted applicability to read-only observable initial state; future mock responses, fixture identities, uploads, destinations, and toasts remain authored flow or claims instead of becoming false preflight skips.
- Allow one additional independently reviewed abstraction revision before failing closed, and invalidate old abstraction cache decisions without changing QA IR or run-artifact schemas.
- Prevent evidence judges from treating absent internal mock/setup requests as applicability conflicts when sealed page evidence directly establishes the authored visible state.

## 2.8.0

### Minor Changes

- Add a cached, fail-closed semantic AI fallback for Playwright tests that static analysis cannot represent. Static actions and policy remain authoritative, while a separate evidence-only AI judge evaluates extracted DOM, URL, network, ordering, and state claims.
- Make strict `--allow-partial` page runs skip scenarios whose parsed actions exceed strict runtime capabilities instead of aborting the entire page.

## 2.7.0

### Minor Changes

- 07b5505: Adaptive (AI-native) execution can now perform `@qa-fixture` file uploads. An `UPLOAD` interaction
  becomes an `upload_observed_element` adaptive action, offered only when the scenario declares an
  upload milestone with a designated `@qa-fixture`. The agent chooses the target element; the file is
  always the author-designated fixture, resolved strictly inside the project root (no symlink escape,
  size cap) before `setInputFiles`. Uploads whose fixture is undeclared stay blocked. The QA IR
  milestone gains an optional `fixture` field and the vocabulary gains `upload_observed_element` (both
  additive).
- 07b5505: `qa-native execute` now defaults to AI-native execution (`--provider=hermes --mode=adaptive`).
  Passing `--mode=strict` (or `--provider=playwright`) still selects the deterministic read-only
  provider; either flag alone infers the matching pair. Runs that previously relied on the implicit
  strict default now run adaptively unless they pass `--mode=strict`.

### Patch Changes

- 6da2c92: Under `--allow-partial`, adaptive execution now skips scenarios that compile cleanly but use an
  expectation or step kind the adaptive runtime cannot build (instead of failing the whole run), emits
  a `SCENARIO_UNRUNNABLE` diagnostic, and narrows the written QA IR to the scenarios that actually ran.
  Also hardens the Playwright AST parser against a variable declaration with no initializer.

## 2.6.0

### Minor Changes

- 8a94e84: `qa-native execute` now takes a spec source that is either an explicit `--spec=<file>` or a
  `--page=<name>`. Page mode reads the project config (`hermes-qa.config.mjs` /
  `playwright-spec-for-ai-agent.config.mjs`) and runs only the specs it designates for the page: from
  the page's `__tests__` directory, the specs whose `@qa-scenario` matches the page's
  `expectedSubscriptionStatus` (case-insensitive; page config, then the `staging` default), plus any
  `// @qa-always-run: true`, minus any `// @qa-live-skip: true`. When no status is configured the whole
  directory is designated. Navigation uses the config's per-page `targetPath`, and `--base-url`
  defaults to `batch.defaultBaseUrl`. An explicit `--spec` always wins; giving both or neither is an
  error. This keeps a run tied to the specs designated for a page's state instead of an ad-hoc plan.
- 19b7203: Strict execution now performs `@qa-fixture` file uploads. An `UPLOAD` interaction (a
  `setInputFiles("name")` call) replays the file declared by `// @qa-fixture: name=path` into the
  target input via Playwright's `setInputFiles`. The fixture path is repo-relative and resolved
  strictly inside the project root (no symlink escape, 32 MB cap) before the browser touches it; an
  upload whose argument names no declared fixture is blocked (`UPLOAD_FIXTURE_UNRESOLVED`) rather than
  run. Upload stays a strict-mode-only exception — the adaptive/AI provider never uploads. The QA IR
  scenario gains an optional `fixtures` map and execution-plan interaction nodes an optional `value`
  (both additive; no schemaVersion bump).

### Patch Changes

- cd2bb5d: Collapse duplicated adaptive-protocol rules into single sources. The action vocabulary is now
  defined once as `ACTION_SPECS` in contracts — lease building, safe-recovery, milestone semantics,
  the gateway guard, parameter-key validation, element-bound actions, the audit artifact shape, and
  the Hermes execution prompt version all derive from it instead of keeping their own copies. Audit
  artifact shape ("five snapshots plus report_blocked's VISIBLE_TEXT") is defined once as
  `auditArtifactShape` and consumed by both the provider seal and the evidence validator. The
  observation-settle wait is defined once as `observationSettleBudget` in core and shared by strict
  observation and adaptive snapshot capture. Behaviour-invariant: the sealed lease order and
  completion semantics are unchanged (equivalence tests lock them); the Hermes execution prompt
  version string changes because it now hashes `ACTION_SPECS`.
- babeb28: Adaptive gateway now settles the page after every navigation (document fully loaded plus a 300ms DOM-mutation quiet window, capped at 5s and bounded by the remaining run budget) before sealing snapshot evidence, so testids attached only after client hydration reach the judge instead of the pre-hydration SSR markup.
- cd2bb5d: CLI internal errors no longer collapse to an opaque "command failed". stderr now names the failure
  category — a CliError's message, or an internal error's stable `.code` or class name — so a failure
  is never silently swallowed. The raw message and stack, which may embed sensitive data such as
  evidence bytes, stay behind `QA_NATIVE_DEBUG`.

## 2.5.1

### Patch Changes

- 6f0403e: Extract the Hermes CLI transport into a shared private package `@persona-runtime/hermes-transport` so personaut no longer deep-imports a file inside the sibling app (`../../playwright-spec-for-ai-agent/scripts/hermes-runner.mjs`) with no declared dependency edge. personaut now imports the package and bundles it. qa-native ships raw `.mjs`, so its `scripts/hermes-runner.mjs` re-exports the package in the monorepo and a `prepack` step inlines the package back into that path for publish, keeping the published artifact self-contained. No runtime behavior changes for either package.

## 2.5.0

### Minor Changes

- Fix the strict one-shot race, surface failure detail, and stop deleting failed-run evidence.
  - Strict element observation no longer races the node timeout: visibility waits apply only to VISIBLE/CONTAINS_TEXT expectations under a bounded shared budget, NOT_VISIBLE/PRESENT targets snapshot `isVisible()` immediately, and an element detached mid-observation records a MISSING fact. Consumer reproduction: strict one-shot 0/4 → 5/5 consecutive no-DEBUG runs.
  - Strict runs allow page-initiated same-site (registrable domain) GET/HEAD requests before any interaction, so apps serving their API from a sibling origin render fully; mutations, foreign-site reads, and the stricter post-interaction same-origin rule are unchanged. Observation also waits for VISIBLE/CONTAINS_TEXT targets still rendering, and NAVIGATE retries once when the landing bounces off the target path.
  - Execution failures print the runtime outcome (`type=… code=… message=… bundles=N`) instead of an opaque "QA execution failed", and every failed run — strict or adaptive — is quarantined as `<run-dir>.invalid` with its sealed partial evidence instead of being deleted (POLICY_VIOLATION evidence stays withheld).
  - The judge skips empty evidence items, resamples the model once when a decision violates the SemanticJudgeDecision contract (never coerced), names the failing scenario and outcome code in errors, and surfaces underlying errors with `QA_NATIVE_DEBUG`.
  - The judge slices evidence around the routed expectations' clues (testId, accessible name, expected text) instead of head-first, with budgets raised to 16KB/item, 64KB evidence, 128KB input — a 51KB DOM whose relevant section sat at the tail previously judged as TRUNCATED_DOM manual review. The adaptive scroll_view path (lazy-rendered content) is covered end to end by the policy-matrix suite.
- `qa-native report` prints a one-line summary and treats an all-pass run as success; failure diagnosis classifies judge-flagged context/auth mismatches as ENVIRONMENT; code location ranks the executed spec file first among pure route matches; `QA_NATIVE_TRACE_TIMING=1` prints per-node timing.
  - GitHub publication works against current gh and fresh repositories: payloads reach spawnSync as buffers (Node 24), issue labels are created idempotently (including dynamic `scenario:<id>` labels), `--jq` is no longer combined with `--slurp`, and jq's null-for-absent `pull_request` no longer misclassifies issues as draft PRs.

## 2.4.0

### Minor Changes

- Sync the adaptive evidence validator with the runtime and preserve rejected evidence.
  - Fix three validator/runtime divergences that made adaptive runs reject their own output: the startup-navigation URL rewrite vs the first-audit page equality check, sealed empty `satisfiedMilestoneIds` vs observe-only milestone completion, and `report_blocked`'s sixth VISIBLE_TEXT artifact vs the exact-five artifact count. Completion semantics now live in a single exported `milestoneCompletionRule` shared by the runtime and the validator.
  - A run whose sealed adaptive evidence fails validation is no longer deleted: it is quarantined as `<run-dir>.invalid` with the evidence archive inside, and every qa-native command refuses to read `.invalid` paths.
  - New adaptive policy-matrix fixture suite (semantic / readonly / safe-interaction / report_blocked / budget-exhausted) guards the protocol in CI without a model or network.

## 2.3.0

### Minor Changes

- Move AI reasoning into the execution path so non-deterministic live behavior is judged, not literal-matched. Adaptive scenario failures and budget exhaustion now record ERROR/BLOCKED outcomes and keep their sealed evidence instead of throwing and deleting it; `@qa-live-policy: mock-judgment` scenarios route to observe-only milestones and carry a `SEMANTIC` hint so the judge rules on structural equivalence; a `report_blocked` terminal action lets the agent surrender an unreachable milestone with sealed, judge-verified evidence; element observation waits for visibility instead of snapshotting; mock-judgment contradictions classify as `TEST_DATA`; and `execute` gains `--budget-*` flags while `judge` gains a verdict summary and `--fail-on` exit codes.

## 2.2.0

### Minor Changes

- Make `execute --allow-partial` work on real specs and surface run outcomes.
  - Attribute AST-level compile diagnostics (opaque/dynamic assertion and action targets) to the owning test by source range, so a single unparseable scenario blocks only itself instead of failing the whole file closed.
  - Record live-policy blocked scenarios (skip, auth-mock, subscription-mutation) as blocked so `--allow-partial` prunes them, instead of exploding `createExecutionPlan` on a NAVIGATE step under a blocked policy.
  - Surface internal failure detail (message + stack) under `QA_NATIVE_DEBUG`; the default stays a secret-safe opaque message.
  - Emit a one-line success summary (executed vs. skipped scenarios and the artifact path) instead of running silently.

## 2.1.0

### Minor Changes

- 6917cc4: Compile Playwright specs per scenario instead of failing the whole file closed. Opaque/dynamic steps now block only the scenario that owns them; the adapter records blocked scenario ids in `qaIr.extensions.blockedScenarioIds`, and `qa-native execute --allow-partial` runs the statically compilable scenarios while printing skipped-scenario diagnostics to stderr.

### Patch Changes

- 677463d: Compile role-only Playwright locators (e.g. `getByRole("dialog")`) instead of throwing: role alone is a valid semantic identity, so `accessibleName` is now attached only when the locator carries an explicit name.

## 2.0.0

### Major Changes

- Remove the legacy page-QA CLI. The `playwright-spec-for-ai-agent <spec|abstract-ai|judge|review|slack|nightly>` bin, its scripts, and the `./cli` export are deleted; the evidence-driven `qa-native` CLI is now the only entry point. Config files keep only the `remediation` section (`loadProjectConfig`); page/staging/paths config no longer drives a command.

## 1.2.0

### Minor Changes

- Enable one-shot QA Native: multi-scenario adaptive execution into one sealed manifest, same-origin read-after-click network policy, run envelope v0.2, Hermes runner protocol probe, and auto-discovered shared login at `.private/storage-state.json`.

## 1.1.2

### Patch Changes

- Complete authenticated adaptive one-shot QA with safer bounded action handling.

## 1.1.1

### Patch Changes

- Add private storage-state injection and bounded auth-bootstrap support for authenticated QA sessions.

## 1.1.0

### Minor Changes

- faf85a2: Parse Playwright specs with the TypeScript AST, preserve structured actions and assertions in live plans, and fail closed on unresolved executable syntax.

## 1.0.0

### Major Changes

- Release the stable 1.0.0 version of the Playwright live staging QA CLI.

## [0.9.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.8.0...v0.9.0) (2026-07-19)

### Features

- boot Hermes stateless per QA run ([0c8272e](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/0c8272e7331b242cd16f0a0f1cbe54e5ceacd81d))
- boot Hermes stateless per QA run ([ebc9ee4](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/ebc9ee464b32737043e420745f154550c7ac004d))

## [0.8.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.7.0...v0.8.0) (2026-06-21)

### Features

- login flag option 추가 ([c06ec8f](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/c06ec8f9c79fbee308a87cfbfaad6742362f6ba5))

## [0.7.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.6.0...v0.7.0) (2026-06-09)

### Features

- enhance live QA test handling with new filtering and reporting functions ([1f226f5](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/1f226f5740d6b5216802658d75088d0bf545a289))

## [0.6.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.5.0...v0.6.0) (2026-06-09)

### Features

- abstract-qa 문구 수정 ([0ab43a7](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/0ab43a714a846f55d704cc212ff277bad2bd33c6))

## [0.5.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.4.2...v0.5.0) (2026-06-08)

### Features

- resolve judge target from config pageUrl with interactive override ([b1202c2](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/b1202c28b80c44999825dabd9e64027f04ae5ae5))

## [0.4.2](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.4.1...v0.4.2) (2026-06-06)

### Bug Fixes

- **ci:** ensure hermes-runner tests pass without local Hermes config ([82de29f](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/82de29f62e3796228b8b13cbd940435359f2f7da))

## [0.4.1](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.4.0...v0.4.1) (2026-06-06)

### Bug Fixes

- **ci:** ensure hermes-runner tests pass without local Hermes config ([4250348](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/42503480081d42640aba0ee3d0e2e04bff4b8423))

## [0.4.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.3.0...v0.4.0) (2026-06-06)

### Features

- add abstract option ([825336d](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/825336dfb32ae09213d230d0a7611f3eecfd038a))
- add review command and functionality for post-judge QA assessment ([1dab5e4](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/1dab5e4ef744a2fd990a0f551e1e287d1f338bbe))
- enhance QA tooling with new artifacts and updates ([fcc51a6](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/fcc51a650b905bfeea0083f873282989cd36cf2f))
- spec 옵션 추가 ([b1c082c](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/b1c082cd1dfd77a82ee2b0f69a0c0a9aeebcd91f))
- 프롬프트 정제 ([3b7ad27](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/3b7ad27cbed13036481a3e513e7a0ec2cff7b466))
- 피드백 반영 ([49f5136](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/49f51364868069b727e8005682aa73e41890ba27))

### Bug Fixes

- adjust argument handling for disabled_toolsets in buildHermesAgentArgs ([f316b6e](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/f316b6e98630bcfc5cf2540dc83d879871347b90))
- 에러 수정 ([e8c8d48](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/e8c8d486bc32c4f45a296d5823101b86697a7bcc))

## [0.3.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.2.0...v0.3.0) (2026-05-31)

### Features

- add example ([ae16491](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/ae16491e1b342d54007a2218ada138817a4bbd9b))
- add release-please configuration for automated releases ([87eafc6](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/87eafc6cf2ecc6caf61449b4223ceff1f6786d39))
- implement upload fixture support for live testing ([c18a586](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/c18a586ada893465f160743a246757ff882931c0))
- publish npx CLI and configurable project paths ([6c08d3b](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/6c08d3b4b9eaae1ae99156e84e60a9b517b066e4))
- rename package and update configuration for AI-assisted QA ([60ab7f7](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/60ab7f7f60b7f6904eb06403b100c29ce0537013))
