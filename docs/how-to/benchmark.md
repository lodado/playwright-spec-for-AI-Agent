# Benchmark verdicts

Run the frozen corpus before changing evidence validation or choosing an adapter:

```bash
npm run qa:benchmark -- --repeat=3 --output=benchmark.json
# From an installed package:
npx playwright-spec-for-ai-agent benchmark --repeat=3 --output=benchmark.json
```

The default `offline-harness-validation` mode needs no model, browser, project
configuration, or credentials. It ignores `QA_AI_ADAPTER` and normalizes canned
responses against local evidence. The 30 cases include duplicate titles, wrong
check IDs, fabricated observations, and read-only violations. CI runs the corpus
three times on each supported Node version and uploads the JSON report.

Zero mismatches means those normalization cases passed. It does not establish
model accuracy or browser task success.

## Compare adapters using frozen evidence

`--adapter` explicitly enables model calls, which may incur provider charges.
Configure the adapter first; for Stagehand, follow [its setup guide](stagehand.md).
The supported Stagehand version remains `3.7.3`.

```bash
npx playwright-spec-for-ai-agent benchmark --adapter=stagehand --repeat=1 --output=stagehand-benchmark.json
```

This runs the 26 semantic cases in `evidence-only-adapter` mode. The four
harness-specific probes are excluded and counted in `skippedHarnessCases`.
Each request receives the check intent, stable IDs, and that case's ARIA text;
the expected verdict and canned response are withheld. Returned passes must
quote text present in the supplied evidence.

The adapter must advertise tool-disabling support. Calls use `text-only` mode
and request browser, web, and terminal tools to be disabled. A custom adapter
is trusted executable code and must honor that contract; the benchmark is not
a sandbox. Adapters without the capability are rejected before invocation.

Neither mode logs in, navigates staging, measures action replay, or tests whether
a browser agent can gather the right evidence. Run live-browser evaluations
separately before making claims about end-to-end accuracy or speed.

## Read the report

`corpusCases` counts evaluated cases per repetition. `runs` retains each verdict
and duration; adapter runs also retain available `agentMeta`, with `null` for an
unknown model. The confusion matrix uses expected verdicts as rows and actual
verdicts as columns. Counts and denominators include every repetition.

| Field | Meaning |
| --- | --- |
| `falsePassRate` | Reported passes on expected non-pass cases, divided by expected non-pass cases. |
| `falseFailRate` | Reported failures on expected-pass cases, divided by expected-pass cases. |
| `abstentionCount` | Expected-pass cases returned as `manual_review`, counted separately from false failures. |
| `mismatchCount` | Every verdict differing from its expected verdict, including fail-to-manual-review. |
| `manualReviewRate` | All `manual_review` results divided by all evaluated cases. |
| `latencyMs.p50/p95` | Per-case elapsed-time percentiles across repetitions. |

Offline latency measures normalization only. Adapter latency includes the
adapter call and normalization, but excludes initial adapter loading and
temporary directory setup. It is not live-browser startup or task latency. The report does not
estimate tokens or cost.

`--repeat` accepts an integer from 1 to 100 and defaults to 1. `--output` writes
JSON to a file in an existing directory; JSON is also printed to stdout. Exit
code 0 means every evaluated verdict matched, 1 means at least one mismatch,
and 2 indicates invalid arguments or a local benchmark error. Adapter errors
retain their existing exit codes, including 3 for environment errors and 4 for
unusable agent output.
