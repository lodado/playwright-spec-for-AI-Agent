# Design Convergence — Roadmap & Status

Live status of the phased plan in this directory. Phase specs are `00`–`10`;
this file tracks what is actually built and what is next. Update it as phases
land.

Legend: ✅ shipped · ⏳ in progress · 📋 planned

## Snapshot

| Phase | Scope                                                              | State                      |
| ----- | ------------------------------------------------------------------ | -------------------------- |
| 00    | Repository fit, package boundaries                                 | ✅                         |
| 01    | Foundation: config, schema, error/provenance/path/secret contracts | ✅                         |
| 02    | Figma fixture → canonical normalization, manual binding schema     | ✅                         |
| 03    | Test-only Babel instrumentation + Next.js example                  | ✅                         |
| 04    | Browser capture, normalization, deterministic diff, JSON output    | ⏳ core done, live pending |
| 05    | React source index + AI binding validation                         | 📋                         |
| 06    | Source attribution + shared-cause grouping                         | 📋                         |
| 07    | Patch policy + AI patch proposal                                   | 📋                         |
| 08    | Isolated worktree verification                                     | 📋                         |
| 09    | Reporting (JSON/HTML/Markdown) + GitHub draft PR                   | 📋                         |
| 10    | Hardening + public release                                         | 📋                         |

## Packages

| Package                                     | Phase | State                                                         |
| ------------------------------------------- | ----- | ------------------------------------------------------------- |
| `@design-convergence/shared`                | 01    | ✅                                                            |
| `@design-convergence/config`                | 01    | ✅ (gained `bindings` path in 03)                             |
| `@design-convergence/figma`                 | 02    | ✅                                                            |
| `@design-convergence/instrumentation`       | 03    | ✅                                                            |
| `design-convergence` (CLI app)              | 01→   | ✅ `run --case`: config + case + static preflight             |
| `examples/design-convergence-next-tailwind` | 03    | ✅ enabled/disabled build proof                               |
| `@design-convergence/comparison`            | 04    | ✅ ΔE + registry + severity + metrics + diff                  |
| `@design-convergence/browser`               | 04    | ⏳ rendered-style normalizer done; Playwright capture pending |

Related PRs: #44 (Phase 3), #45 (Phase 4 core, stacked on #44).

## Done

- **Phase 0–2.** Config/schema/secret/path/error contracts; Figma raw fixture →
  `CanonicalStyleNode`; manual binding schema (never `validated` on authorship).
- **Phase 3.** `resolveTarget` maps one binding to exactly one JSX element
  (identity = `elementName`+`occurrence`; `sourceRange`/`sourceHash` stale
  guards; no nearest-element fallback). Babel `PluginObj` injects the runtime
  attribute in the test build only; disabled path never reads binding files;
  conflicting attribute rejected, identical idempotent. Next.js example proves
  enabled → one `data-design-node`, default → none, via a real `next build`.
  `run --case` statically preflights bindings before any app starts.
- **Phase 4 core (pure, no live browser).** `comparison` diffs two canonical
  nodes over a fixed property registry: CIEDE2000 ΔE (verified against the
  Sharma dataset), spec-default severity bands (>20% size → critical; 3/8px
  length bands), and the fidelity/weighted-difference formula; pass/fail from
  blocking severities, not the score. `browser` normalizes a bounded raw
  computed-style capture into a canonical node, recording `unsupported` values
  instead of coercing them.

Tests: shared 46 · config 21 · figma 7 · instrumentation 12 · app 15 ·
example 5 · comparison 16 · browser 7.

## Next — finish Phase 4 (live vertical slice)

Ends when `run --case pricing-desktop` renders the example, extracts the bound
element's style, diffs it, and writes evidence. Requires a live Chromium
(`npx playwright install chromium`), so these were deferred from the pure core:

1. **Task 4.1 — app process.** `spawn(executable, args, { shell:false })` from
   validated config; minimal sanitized env with Figma/GitHub/AI creds removed;
   poll `readyURL`; bounded/redacted output; full process-tree teardown. Requires
   `execution.allowProjectCode: true`.
2. **Task 4.2 — deterministic Playwright case.** Fresh Chromium context per case;
   viewport/locale/timezone/scale; prepare module bundled via esbuild to a
   root-contained temp ESM; animation/caret suppression; wait for ready selector +
   `document.fonts.ready`; capture `before.png` as secondary evidence.
3. **Task 4.3 (remaining) — extract Rendered Style Tree in-page.** Locate the
   single element carrying the configured attribute; capture computed style +
   `getBoundingClientRect` + root/parent bounds + pseudo-elements as bounded raw
   strings, then feed `@design-convergence/browser`'s normalizer (already built).
4. **Task 4.4 — runtime binding validation.** `found`/`unique`/`visible`/non-zero;
   text overlap when the Figma node has meaningful text; size/position/parent/
   sibling plausibility. Promote the binding to `validated` only after static +
   runtime checks pass.
5. **Task 4.7 — atomic run artifacts.** `.design-convergence/artifacts/<run-id>/`
   with `figma.raw/normalized`, `browser.normalized`, `bindings`, `diffs`,
   `before.png`, `report.json`; run metadata (schema version, commit, redacted
   config/binding/payload hashes, browser version); no tokens or raw env in any
   hash. `.gitignore` the artifact root.
6. **Task 4.8 — wire `run --case` end to end.** Static-validate → instrument →
   start → runtime-validate → capture → normalize → `diffCanonicalNodes` →
   persist, in that order. Print per-property expected/actual/delta/tolerance/
   severity, validated binding count, compared count, fidelity, artifact path,
   and honest status. Exit `1` on a deterministic mismatch (verify the
   intentionally-mismatched fixture exits `1`; add a passing variant that exits
   `0`).

Also for Phase 4 completeness: a committed local `@font-face` woff2 in the
example so `document.fonts.check` is deterministic (currently a system stack —
see `examples/design-convergence-next-tailwind/app/globals.css`).

New package to add: `@design-convergence/browser` gains its Playwright layer
(peer `@playwright/test`); `comparison` must stay Playwright-free.

## Phase 4 exit gate

One manually bound card compared end to end with no AI. Binding reaches
`validated` only after the full static+runtime record passes. Height, padding,
background, radius, typography, color, border mismatches are property-level
records. Missing element / font failure / app-startup failure / unsupported
values keep distinct provenance. JSON artifacts validate against versioned
schemas. Production output stays uninstrumented. Both a passing and an
intentionally failing CLI case have runnable checks. **Do not start Phase 5
until this is green.**

## Later phases (unchanged from the specs)

- **05** React AST index; AI provider abstraction; AI binding proposals that are
  never trusted before static+runtime validation.
- **06** CDP-based attribution to CSS / CSS Modules / Tailwind declarations;
  shared-cause grouping of repeated mismatches.
- **07** Narrowed, CSS-oriented AI patch proposals gated by source hash + an
  allowed/forbidden patch policy.
- **08** Disposable worktree; configured checks; target + full-suite regression
  gate; good patch accepted, regression patch rejected.
- **09** JSON/HTML/Markdown reports; accepted-only Git branch/commit/draft PR
  with linked evidence.
- **10** Three examples; fixture/security matrix; required user docs; package +
  release smoke; Changesets for the packages made public
  (`design-convergence`, `@design-convergence/config`).

## Working rules

- Implement in document order; do not start a phase before the prior exit gate +
  root verification commands pass.
- Each checkbox cluster is one reviewable increment: failing test → minimal
  implementation → package gate → root gate.
- No completion claim without real command output. See AGENTS.md §5 and
  `apps/playwright-spec-for-ai-agent` for the verification bar.
- All new workspaces stay `private` until Phase 10; private packages need no
  changeset.
