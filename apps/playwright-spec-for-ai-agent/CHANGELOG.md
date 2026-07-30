# Changelog

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
