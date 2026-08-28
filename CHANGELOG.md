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
