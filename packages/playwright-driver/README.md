<div align="center">

# playwright-driver

**Direct Playwright browser evidence for Personaut.**

![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Playwright peer](https://img.shields.io/badge/peer-Playwright_%3E%3D1.48-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)
![Private workspace](https://img.shields.io/badge/workspace-private-0f766e?style=for-the-badge)

<br />

![Playwright](https://img.shields.io/badge/%23Playwright-2EAD33?style=flat-square)
![Browser Evidence](https://img.shields.io/badge/%23BrowserEvidence-2563eb?style=flat-square)
![Semantic Snapshot](https://img.shields.io/badge/%23SemanticSnapshot-7c3aed?style=flat-square)
![Safe Automation](https://img.shields.io/badge/%23SafeAutomation-b91c1c?style=flat-square)

<br />

[Quick start](#quick-start) · [Driver contract](#driver-contract) · [Outputs](#outputs) · [Safety](#safety) · [Test](#test)

</div>

---

> [!NOTE]
> This driver exposes only perceived browser observations and observation-local actions to Personaut. It keeps selectors and raw Playwright control inside the driver boundary.

`playwright-driver` creates isolated Playwright browser contexts, captures visible semantic and visual evidence, executes allowed observation-local actions, and blocks unsafe navigation or destructive interactions.

```text
trusted start URL → isolated BrowserContext → observe visible UI → execute allowed action → evidence refs → close
```

### Browser evidence example

> **One runtime session** → direct Playwright context → semantic snapshot + screenshot/trace/video evidence.

<table>
<tr>
  <td align="center"><strong>① start</strong><br/><code>allowed origin</code></td>
  <td align="center">→</td>
  <td align="center"><strong>② observe</strong><br/><code>visible elements only</code></td>
  <td align="center">→</td>
  <td align="center"><strong>③ execute</strong><br/><code>observation-local action</code></td>
</tr>
</table>

---

## Table of Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [Driver contract](#driver-contract)
- [Quick start](#quick-start)
- [Outputs](#outputs)
- [Safety](#safety)
- [Test](#test)
- [Limits](#limits)

## Why this exists

Personaut needs real browser evidence, but persona policy should not receive raw selectors, arbitrary JavaScript, or broad browser control. The driver is the narrow Playwright boundary: it turns the live page into perceived observations and accepts only actions that came from that observation.

## What it does

`playwright-driver` owns:

- direct Playwright `BrowserContext` lifecycle per session
- semantic snapshots of visible headings, landmarks, text, and interactive elements
- observation-local element IDs while selectors stay private inside the driver
- screenshot, trace, video, console, network, download, popup, and dialog evidence
- origin, navigation, mutation, upload, destructive-action, and storage-state guards
- secret redaction in page title, URL, semantic text, runtime issues, and evidence policy downgrades

It does not own session orchestration, persona decisions, oracle evaluation, report rendering, or arbitrary shell/browser actions.

## Driver contract

`createPlaywrightDriver()` returns an object with:

| Method | Purpose |
| --- | --- |
| `start(input)` | Launches browser/context/page and navigates to the trusted start URL. |
| `observe(handle)` | Captures a stabilized observation and evidence references. |
| `execute(handle, action)` | Performs an allowed action from the latest observation. |
| `close(handle)` | Stops tracing/video, closes context/browser, and returns close evidence. |
| `closeAll()` | Closes all live sessions owned by the driver. |

## Quick start

Import the driver and pass it into `@persona-runtime/runtime-core` or the `personaut` CLI path:

```js
import { createPlaywrightDriver } from "playwright-driver";

const driver = createPlaywrightDriver({ browserName: "chromium" });

console.log(typeof driver.start);
console.log(typeof driver.observe);
console.log(typeof driver.execute);
console.log(typeof driver.close);
```

For an end-to-end browser run with evidence sealing and evaluation gates, use the CLI:

```bash
pnpm personaut run examples/hidden-cta/study.yaml --output=.qa/hidden-cta
```

## Outputs

Evidence entries can include:

```text
screenshot
trace
video
console_issue
network_failure
download
```

`observe()` returns a semantic observation with page metadata, visible text, landmarks, headings, interactive elements, runtime issues, and evidence references. `close()` returns close evidence and releases browser resources.

## Safety

- Only `http:` and `https:` base URLs are accepted.
- Metadata hosts such as `169.254.169.254` are blocked.
- `allowedOrigins` gates all requests.
- `allowExternalOrigin: false` keeps navigation on the base origin.
- Hidden, occluded, off-viewport controls are not exposed to persona policy.
- Forged or stale element IDs are blocked.
- Destructive confirmation/payment-like controls are blocked when `stopBeforeConfirmation` is enabled.
- `storageStatePath` must resolve within the workspace.
- If `valueRefs` contain secrets, screenshot, trace, and video evidence are disabled for that session.

## Test

```bash
pnpm --filter playwright-driver test
pnpm --filter playwright-driver typecheck
pnpm --filter playwright-driver build
```

## Limits

- This package is a driver, not a full runtime. Use runtime-core or CLI for sealing, evaluation, and reports.
- It does not expose raw selectors to persona policy.
- It rejects unsafe URLs and cross-origin behavior unless explicitly allowed by policy.
- It cannot prove business success by itself; it only captures and executes browser-facing evidence.
