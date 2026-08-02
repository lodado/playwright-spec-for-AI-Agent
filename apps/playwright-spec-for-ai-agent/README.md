<div align="center">

# Playwright Spec for AI Agent

**Turn annotated Playwright specs into evidence-bound AI QA.**

[Architecture](ARCHITECTURE.md) · [Operator guide](docs/qa-native.md) · [Overfitting audit](docs/qa-native-overfitting-audit.md)

</div>

QA Native v3 has one production pipeline:

```text
spec → static-authority → abstract-ai → runtime → evidence → judge → review → report
```

Static code owns test identity, policy, origins, fixtures, budgets, redaction, and
artifact integrity. AI extracts reviewed Given/When/Then behavior, autonomously
gathers evidence inside those capabilities, judges the sealed evidence, and
independently reviews the judgment. The browser agent never declares PASS or
FAIL.

v3 is intentionally breaking. It has no AST semantic compiler, strict executor,
provider/compiler/mode matrix, applicability preflight, v2 artifact reader,
partial recovery, remediation, or publication commands.

## Requirements

- Node.js 20+
- `@playwright/test` 1.48+
- Hermes Agent configured with an inference model
- macOS or Linux; private artifacts rely on POSIX permissions

```bash
npm install -D playwright-spec-for-ai-agent @playwright/test
npx playwright install chromium
export QA_NATIVE_INTEGRITY_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"
```

## Annotate a spec

```ts
// @qa-scenario: VISITOR_PRICING
// @qa-page: /pricing

import { expect, test } from "@playwright/test";

// @qa-live-policy: readonly
test("shows pricing options", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
});
```

Supported live policy annotations:

| Annotation | Browser/network authority |
| --- | --- |
| `readonly` | DOM/ARIA observation; leased-origin GET/HEAD; no WebSocket |
| `safe-interaction` | bounded interaction; all methods and WebSocket on exact leased origins |
| `safe-interaction-no-confirm` | same runtime authority; semantic judgment remains mandatory |
| `mock-judgment` | collect live evidence instead of replaying mocks |
| missing, unknown, or blocked value | no browser session |

`@qa-fixture <id> <repo-relative-path>` is the only way to authorize an upload
file. The execution model cannot add a path, origin, selector, policy, fixture,
or verdict.

## Run the complete pipeline

```bash
npx qa-native run \
  --spec=tests/e2e/pricing.spec.ts \
  --base-url=https://staging.example.com \
  --run-dir=.qa/runs/pricing-1
```

A configured page may be used instead:

```bash
npx qa-native run --page=pricing --run-dir=.qa/runs/pricing-1
```

`--page` resolves every non-skipped spec, target path, and default base URL from
`playwright-spec-for-ai-agent.config.mjs`. Exactly one of `--spec` and `--page`
is required. `--spec` also requires `--base-url`.

```js
export default {
  specDir: "src/page/{page}/__tests__",
  baseUrl: "https://staging.example.com",
  pages: {
    pricing: { targetPath: "/pricing" },
  },
};
```

Per-page `specDir`, `baseUrl`, `targetPath`, and `pageUrl` may override the
defaults. v2 state selection, output, remediation, and publication settings are
rejected instead of silently ignored.

The stage commands use the same functions as `run` and exist only for debugging:

```bash
npx qa-native abstract --spec=tests/e2e/pricing.spec.ts
npx qa-native execute --spec=tests/e2e/pricing.spec.ts --base-url=https://staging.example.com --run-dir=.qa/runs/pricing-1
npx qa-native judge --run-dir=.qa/runs/pricing-1
npx qa-native review --run-dir=.qa/runs/pricing-1
npx qa-native report --run-dir=.qa/runs/pricing-1
```

There are no provider, mode, compiler, partial, judgment-selection, repository,
or publication flags.

## Behavioral abstraction

The extractor receives the complete source plus immutable static authority and
returns one entry per code-owned test ID:

```json
{
  "testId": "code-owned-id",
  "given": ["observable conditions before the flow"],
  "when": ["the authored user or system flow"],
  "then": ["observable outcomes the evidence must support"],
  "classification": "LIVE_EXECUTABLE"
}
```

A fresh reviewer either returns corrected final tests or `MANUAL_REVIEW`.
Approved results are cached by source, authority, model, and prompt hashes. There
is no extractor/reviewer revision loop. Given is judge context and is never sent
to the execution agent as an instruction; execution receives only When and Then.

## Runtime safety

- Every HTTP request must target an exact leased origin.
- Read-only policy permits only GET/HEAD and blocks WebSocket.
- Interaction policy permits every method and WebSocket only on leased origins.
- Direct model-supplied selectors, origins, fixture paths, and credentialed URLs
  are rejected.
- Actions, turns, time, tokens, evidence count, and byte sizes are bounded.
- Pending route-policy decisions drain before evidence is sealed.
- URL, header, structured JSON, free text, screenshots, and traces use
  context-specific redaction.
- A browser-started failure is preserved as `<run-dir>.invalid`; downstream
  commands refuse quarantined runs.

Authentication state can be supplied with owner-only files:

```bash
chmod 600 .private/storage-state.json
npx qa-native run --spec=tests/e2e/pricing.spec.ts \
  --base-url=https://staging.example.com \
  --storage-state=.private/storage-state.json \
  --run-dir=.qa/runs/pricing-1
```

`--allowed-origin` adds explicit exact origins. `--auth-bootstrap` accepts a
bounded private JSON file for an initial login flow; it does not weaken the
scenario lease after bootstrap.

## Artifacts

```text
.qa/runs/<id>/
├── authority.json
├── behavior.json
├── evidence/
├── judgment.json
├── review.json
└── report.md
```

The evidence archive HMAC binds the authority and behavior hashes. Judgment
citations must reference sealed evidence from that run. Review may approve the
judgment or require manual review; it cannot replace the verdict.

## Verdicts

- `PASS`: sealed evidence supports the required Then claims.
- `FAIL`: sealed evidence contradicts at least one required claim.
- `SKIP`: the judge finds the authored behavior not applicable from evidence.
- `MANUAL_REVIEW`: evidence or grounding is insufficient or ambiguous.

## Development

```bash
pnpm test
git diff --check
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for contracts, trust boundaries, and the
full data-flow diagram.
