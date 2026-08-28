# Changelog

> **About the 0.8.0 → 6.0.0 jump.** This file has no entries for 1.x through
> 5.x because none of those releases came from the history behind `main`. Their
> tags (`playwright-spec-for-ai-agent@1.0.0` … `@5.0.0`) still exist in the
> repository, but no commit they point at is reachable from `main`, so
> release-please had nothing to write. 6.0.0 was cut from `main` and, per its
> own entry below, restored the v0.8.0 runtime as the published package.
>
> Entries from 0.4.0 through 0.8.0 are commit subjects copied verbatim, and a
> few of them are Korean one-liners that say little. They are left as they are —
> rewriting released changelog entries breaks the links they carry. Going
> forward, commit subjects are written in English (see `CONTRIBUTING.md`),
> because release-please publishes each one unedited.

## [7.0.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v6.3.0...v7.0.0) (2026-08-28)


### ⚠ BREAKING CHANGES

* `{slug}-qa-spec-abstracted.json` is no longer written and `--strict-parser` is gone. Spec artifacts no longer carry `expectations`, `steps`, `parserCoverage`, `parserIntegrity`, or `unsupportedConstructs`. `parserVersion` is `2.0.0`, which invalidates cached plans built from 1.x artifacts. `scripts/dashboard-spec-parser.mjs` is now `scripts/spec-annotation-reader.mjs` and `parseDashboardSpecFile` is `parseSpecFile`.

### Features

* remove the Playwright assertion parser ([c41164d](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/c41164d1ffbe4574889d2b6835f8f1a06624bdc8))


### Bug Fixes

* **abstract-ai:** state the no-confirm rule and keep setup steps in When ([711674d](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/711674d3a620078d9b67861b70ffc33ae3c2849f))

## [6.3.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v6.2.0...v6.3.0) (2026-08-28)


### Features

* add strict parser integrity gate ([b03a21d](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/b03a21d63b6847ac3f2e231efa079e024e999358))
* cap parser gaps at manual review ([ae1f89d](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/ae1f89dc767da667803cfb11ab0786dee8f8938f))
* confirm the plan against the page, not against its own wording ([ccb616f](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/ccb616f94b6bf58f54cda20fdba379ce7a470aa2))
* cross-check the live plan against what the parser read ([9ab3f33](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/9ab3f33c4ca49538298582a8c50f4ff6e0b1aad0))
* derive the live plan from playwright source, not parsed expectations ([d2ef52f](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/d2ef52fc2c30ac5c78b7d2a2532170ae629d722a))
* extract ordered playwright action steps ([f4b4126](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/f4b4126a45760a7f57aed7053d57f6b3cf1bc6e8))
* parse common playwright locator assertions ([0f22372](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/0f223726571899b1577eece3c1e14555572c3cb1))
* prevent silent playwright assertion loss ([217470b](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/217470bfc9fa92722d763bf81cb64a25dc60a699))
* reuse a session instead of asking an agent to log in ([f23ca9f](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/f23ca9fd528f7ae60c0ee47385f591a83fcdf56d))
* settle the account state before judging, then judge only that state ([e7631ee](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/e7631ee69a4b25103364eee853afad28833ebce4))
* show playwright source for every runnable check ([803ed10](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/803ed10948e6b1fc35bbe8ed1dd9790c65764031))
* verify verdicts in the harness instead of trusting agent prose ([947c436](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/947c4366b92077221cfbd2511fe4148673cbe103))


### Bug Fixes

* keep spec appendices when a live plan supplies the body ([e7e99a8](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/e7e99a847a3fe9ae63a341652ad4e02b222248bc))
* name the verdict for a mocked precondition the account cannot meet ([d13f17b](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/d13f17bc0e5ed0461b0e35dab421a4a5a30061fd))
* parse playwright test details objects ([d67eb83](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/d67eb83736482e5d8829da649822d8823fe424af))
* read assertions with options args and locators held in a local ([64fb2f2](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/64fb2f2536d6967f1b00557ca602dedadac77ccb))
* stop the cross-check from demanding literals the prompt generalizes ([2f00324](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/2f00324080cd3af1cd7e564fe3730e6301babb7a))

## [6.2.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v6.1.0...v6.2.0) (2026-08-27)


### Features

* add repository-pattern AI agent adapter (Hermes + Aside) ([f9b2f24](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/f9b2f24ecb7ea85ee0d74bc9d2b44c57aa76e143))
* pre-authenticated judge sessions, settle-aware judging, and failed-run quarantine ([b39a0e0](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/b39a0e0e3b399be556a1e9ae9bdf25e1d0300ac9))
* verdict floor, aside prelogin, runner contract suite, and judge hardening ([058e401](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/058e401c0ff084c6f1348673bcd3002f1347d55d))

## [6.1.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v6.0.0...v6.1.0) (2026-08-12)


### Features

* boot Hermes stateless per QA run ([f4c9694](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/f4c96940581e5e1ff812576a34b7675e55865e4c))

## [6.0.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.8.0...v6.0.0) (2026-08-12)


### Miscellaneous Chores

* restore v0.8.0 runtime as the published package ([15a21ef](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/15a21ef254e8e5da87dc1ac90986fb77b77ff614))

## [0.8.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.7.0...v0.8.0) (2026-06-21)


### Features

* login flag option 추가 ([c06ec8f](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/c06ec8f9c79fbee308a87cfbfaad6742362f6ba5))

## [0.7.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.6.0...v0.7.0) (2026-06-09)


### Features

* enhance live QA test handling with new filtering and reporting functions ([1f226f5](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/1f226f5740d6b5216802658d75088d0bf545a289))

## [0.6.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.5.0...v0.6.0) (2026-06-09)


### Features

* abstract-qa 문구 수정 ([0ab43a7](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/0ab43a714a846f55d704cc212ff277bad2bd33c6))

## [0.5.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.4.2...v0.5.0) (2026-06-08)


### Features

* resolve judge target from config pageUrl with interactive override ([b1202c2](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/b1202c28b80c44999825dabd9e64027f04ae5ae5))

## [0.4.2](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.4.1...v0.4.2) (2026-06-06)


### Bug Fixes

* **ci:** ensure hermes-runner tests pass without local Hermes config ([82de29f](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/82de29f62e3796228b8b13cbd940435359f2f7da))

## [0.4.1](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.4.0...v0.4.1) (2026-06-06)


### Bug Fixes

* **ci:** ensure hermes-runner tests pass without local Hermes config ([4250348](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/42503480081d42640aba0ee3d0e2e04bff4b8423))

## [0.4.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.3.0...v0.4.0) (2026-06-06)


### Features

* add abstract option ([825336d](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/825336dfb32ae09213d230d0a7611f3eecfd038a))
* add review command and functionality for post-judge QA assessment ([1dab5e4](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/1dab5e4ef744a2fd990a0f551e1e287d1f338bbe))
* enhance QA tooling with new artifacts and updates ([fcc51a6](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/fcc51a650b905bfeea0083f873282989cd36cf2f))
* spec 옵션 추가 ([b1c082c](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/b1c082cd1dfd77a82ee2b0f69a0c0a9aeebcd91f))
* 프롬프트 정제 ([3b7ad27](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/3b7ad27cbed13036481a3e513e7a0ec2cff7b466))
* 피드백 반영 ([49f5136](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/49f51364868069b727e8005682aa73e41890ba27))


### Bug Fixes

* adjust argument handling for disabled_toolsets in buildHermesAgentArgs ([f316b6e](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/f316b6e98630bcfc5cf2540dc83d879871347b90))
* 에러 수정 ([e8c8d48](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/e8c8d486bc32c4f45a296d5823101b86697a7bcc))

## [0.3.0](https://github.com/lodado/playwright-spec-for-AI-Agent/compare/v0.2.0...v0.3.0) (2026-05-31)


### Features

* add example ([ae16491](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/ae16491e1b342d54007a2218ada138817a4bbd9b))
* add release-please configuration for automated releases ([87eafc6](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/87eafc6cf2ecc6caf61449b4223ceff1f6786d39))
* implement upload fixture support for live testing ([c18a586](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/c18a586ada893465f160743a246757ff882931c0))
* publish npx CLI and configurable project paths ([6c08d3b](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/6c08d3b4b9eaae1ae99156e84e60a9b517b066e4))
* rename package and update configuration for AI-assisted QA ([60ab7f7](https://github.com/lodado/playwright-spec-for-AI-Agent/commit/60ab7f7f60b7f6904eb06403b100c29ce0537013))
