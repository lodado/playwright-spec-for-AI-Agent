# Examples

- `sample-spec.ts` — minimal Playwright spec with `@qa-scenario` / `@qa-live-policy` annotations.
- `ocr-fixture-upload-example.ts` — `@qa-fixture` (PDF) file-level + test-level override example for upload flows.

Generated QA artifacts belong in **your app's** output directory (e.g. `.qa/{page}/`), not in this package repo:

```bash
npx playwright-spec-for-ai-agent spec --page=dashboard
npx playwright-spec-for-ai-agent abstract-ai --page=dashboard
```

`qa-spec-live.md` is created only by `abstract-ai` (Given/When/Then `livePlan`).

in a project that points `specDir` at specs like `sample-spec.ts`.
