# design-convergence-example-next-tailwind

Test-only Next.js (App Router) fixture for Design Convergence Phase 3. A single
`/pricing` route renders one `PricingCard` whose root `<section>` is bound to a
Figma node in `design-bindings.json`. The Babel plugin injects the runtime
attribute **only** in the instrumented build.

This package is `private` and is never published.

## Install

The repo's supply-chain policy (`pnpm-workspace.yaml`) blocks `@babel/core`
(it pulls `semver@6.3.1`, a provenance downgrade under `trustPolicy: no-downgrade`)
and holds back `turbo`'s freshly-published platform binaries under
`minimumReleaseAge`. `@babel/core` is a dev-only dependency of this private
example, so relax the trust check **at the install boundary only** — the
committed policy that protects the published packages stays strict:

```bash
pnpm install \
  --config.trustPolicy=allow-downgrade \
  --config.minimumReleaseAgeExclude='turbo' \
  --config.minimumReleaseAgeExclude='@turbo/*'
```

## Verify the instrumentation

Unit proof (real `@babel/core` transform, both modes + stale binding):

```bash
pnpm --filter design-convergence-example-next-tailwind test
```

Real Next.js build proof — the injected attribute must appear exactly once when
enabled and never in the default build:

```bash
# instrumented: prerenders <section ... data-design-node="1:2">
DESIGN_CONVERGENCE=true pnpm --filter design-convergence-example-next-tailwind build
grep -o 'data-design-node="[^"]*"' .next/server/app/pricing.html   # -> data-design-node="1:2"

# default: no design-node attribute
rm -rf .next
pnpm --filter design-convergence-example-next-tailwind build
grep -c data-design-node .next/server/app/pricing.html             # -> 0
```

Clear `.next` between modes: Next's webpack/Babel cache is keyed on file content,
not the `DESIGN_CONVERGENCE` env, so a stale cache from the other mode is reused
otherwise.

## Notes

- `babel.config.js` (not `.cjs`/`.mjs` — Next's Babel loader rejects those).
  Its presence disables SWC, so `next/font` is forbidden here.
- Fonts use a system stack for now; Phase 4's `document.fonts.check` gate needs a
  committed local `@font-face` woff2 (see `app/globals.css`).
