# Examples

- `sample-spec.ts` — minimal Playwright spec with `@qa-scenario` / `@qa-live-policy` annotations.

Generated QA artifacts (`{page}-qa-spec*.json`, `{page}-qa-spec-live.md`, `*-hermes-judgment.*`) belong in **your app's** output directory (e.g. `.qa/{page}/`), not in this package repo. Run:

```bash
npx playwright-spec-for-ai-agent spec --page=dashboard
```

in a project that points `specDir` at specs like `sample-spec.ts`.
