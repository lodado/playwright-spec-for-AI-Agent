<div align="center">

# @persona-runtime/reporter-html

**Static, secret-redacted HTML reports for sealed behavioral runs.**

![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Static HTML](https://img.shields.io/badge/output-static_HTML-111827?style=for-the-badge)
![No client JS](https://img.shields.io/badge/client_JS-none-047857?style=for-the-badge)

<br />

![Evidence Viewer](https://img.shields.io/badge/%23EvidenceViewer-2563eb?style=flat-square)
![Validity First](https://img.shields.io/badge/%23ValidityFirst-7c3aed?style=flat-square)
![Secret Redaction](https://img.shields.io/badge/%23SecretRedaction-b91c1c?style=flat-square)

<br />

[Quick start](#quick-start) · [API](#api) · [Outputs](#outputs) · [Safety](#safety) · [Workspace](../../README.md)

</div>

---

> [!NOTE]
> This reporter is presentation only. It renders already-computed runtime outputs into one static HTML document and does not run browser sessions, fetch remote assets, or execute client-side JavaScript.

```text
summary + validity + findings + sessions → renderBehavioralHtmlReport() → report.html
```

### Input → output example

```js
import { renderBehavioralHtmlReport } from "@persona-runtime/reporter-html";

const html = renderBehavioralHtmlReport({
  summary: { title: "Signup study", status: "complete" },
  validity: {
    calibration: { level: "uncalibrated" },
    recommendedUse: "human_review_required",
  },
  findings: [],
});

console.log(html.includes("Signup study"));
```

```text
true
```

---

## Table of Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [API](#api)
- [Quick start](#quick-start)
- [Outputs](#outputs)
- [Safety](#safety)
- [Test](#test)
- [Limits](#limits)

## Why this exists

Behavioral findings need a shareable report that keeps validity warnings, evidence anchors, and session timelines together. A static HTML artifact works in CI, local runs, and artifact stores without a live server.

## What it does

The package:

1. Escapes report text before HTML rendering.
2. Redacts configured secret strings and common token patterns.
3. Renders validity before outcome claims.
4. Shows outcome distribution, repeated findings, persona comparison, variant comparison, timelines, and evidence anchors.
5. Writes a complete HTML file when requested.

## API

| Export | Purpose |
| --- | --- |
| `renderBehavioralHtmlReport(input, { secrets })` | Returns a complete HTML string. |
| `renderHtmlReport` | Alias for `renderBehavioralHtmlReport`. |
| `writeBehavioralHtmlReport({ input, outputPath, secrets })` | Writes the HTML file and returns `{ path, bytes }`. |

## Quick start

```js
import { writeBehavioralHtmlReport } from "@persona-runtime/reporter-html";

await writeBehavioralHtmlReport({
  input: {
    summary: { title: "Signup study", status: "complete" },
    validity: { calibration: { level: "uncalibrated" } },
    findings: [],
  },
  outputPath: ".qa/signup/report.html",
  secrets: ["staging-secret"],
});
```

## Outputs

Rendered sections include:

1. Limitations / Validity
2. Outcome Distribution
3. Repeated Findings
4. Persona Comparison
5. Variant Comparison
6. Session Timeline
7. Evidence Viewer
8. Runtime Issues
9. Cost / Model Usage
10. Model Card, when provided

## Safety

- Text is escaped before entering HTML.
- Secret strings and common token patterns are redacted.
- Private absolute paths become `[redacted-path]`.
- Evidence links are relative page anchors, not `file:` links or absolute filesystem paths.
- The report does not fetch remote assets or execute client-side JavaScript.

## Test

```bash
pnpm --filter @persona-runtime/reporter-html test
pnpm --filter @persona-runtime/reporter-html typecheck
pnpm --filter @persona-runtime/reporter-html build
```

## Limits

- The reporter trusts caller-provided JSON shape; validation belongs in contracts/evaluator layers.
- It renders reports only; it does not upload artifacts or publish comments.
- Very large evidence sets should be summarized before rendering into one HTML file.
