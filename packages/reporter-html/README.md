# Persona Runtime HTML Reporter

<p align="center">
  <strong>Render a sealed behavioral run into a static, drill-down HTML report.</strong><br>
  Validity warnings, outcome distribution, findings, timelines, evidence anchors, runtime issues, and cost metadata render without a browser session.
</p>

<p align="center">
  <img alt="Static HTML" src="https://img.shields.io/badge/output-static_HTML-111827?style=flat-square">
  <img alt="No client JS" src="https://img.shields.io/badge/client_JS-none-047857?style=flat-square">
  <img alt="Secrets redacted" src="https://img.shields.io/badge/secrets-redacted-b91c1c?style=flat-square">
</p>

## Where it fits

```text
Canonical JSON report
  └─ renderBehavioralHtmlReport()
      └─ single static HTML document
```

HTML is a presentation layer only. Business logic belongs in contracts, runtime, and evaluator packages.

## Public surface

| Export | Purpose |
|---|---|
| `renderBehavioralHtmlReport(input, { secrets })` | Returns a complete HTML string. |
| `renderHtmlReport` | Alias for `renderBehavioralHtmlReport`. |
| `writeBehavioralHtmlReport({ input, outputPath, secrets })` | Writes the HTML file and returns `{ path, bytes }`. |

## Minimal example

```js
import { renderBehavioralHtmlReport } from "@persona-runtime/reporter-html";

const html = renderBehavioralHtmlReport({
  summary: { title: "Signup study", status: "complete" },
  validity: { calibration: { level: "uncalibrated" }, recommendedUse: "human_review_required" },
  findings: [],
});

console.log(html.includes("Signup study")); // true
```

## Rendered sections

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

Validity appears before outcomes so readers see calibration and forbidden interpretations before reading findings.

## Safety boundaries

- Text is escaped before it enters HTML.
- Secret strings and common token patterns are redacted.
- Private absolute paths are replaced with `[redacted-path]`.
- Evidence links are relative page anchors, not local `file:` links or absolute filesystem paths.
- The report does not fetch remote assets or execute client-side JavaScript.

## Workspace commands

```bash
pnpm --filter @persona-runtime/reporter-html test
pnpm --filter @persona-runtime/reporter-html typecheck
pnpm --filter @persona-runtime/reporter-html build
```
