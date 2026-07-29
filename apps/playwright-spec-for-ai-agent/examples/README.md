# Examples

- `sample-spec.ts` — minimal Playwright spec with `@qa-scenario` / `@qa-live-policy` annotations.
- `ocr-fixture-upload-example.ts` — file-level and test-level fixture annotation example for upload flows.

Point `qa-native execute --spec` at a spec like `sample-spec.ts` to compile and
run its scenarios. Generated QA artifacts belong under **your app's** run
directory (e.g. `.qa/runs/<id>/`), not in this package repo:

```bash
npx qa-native execute \
  --spec=examples/sample-spec.ts \
  --base-url=https://staging.example.com \
  --run-dir=.qa/runs/sample-1 \
  --provider=hermes \
  --mode=adaptive
```
