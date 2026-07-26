# Hidden CTA demo

Run the local fixture and study in separate terminals:

```bash
pnpm fixture:hidden-cta
pnpm persona-runtime run examples/hidden-cta/study.yaml --output=.qa/hidden-cta
```

Open `.qa/hidden-cta/reports/report.html`. The study uses three behavioral
personas and three seeds; sessions may legitimately succeed or abandon.
