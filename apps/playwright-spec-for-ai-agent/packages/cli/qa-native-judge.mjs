import { join, relative } from "node:path";
import { validateContract } from "../contracts/index.mjs";
import { judgeEvidence } from "../judge/index.mjs";
import { createHermesSemanticJudge } from "../provider-hermes/index.mjs";
import { loadValidatedExecution } from "./qa-native-result-set.mjs";
import { CliError, writePrivateJsonExclusive } from "./qa-native.mjs";

export async function judgeQaNative({ runDirectory, integrityKey, cwd, failOn }, overrides = {}) {
  const judge = overrides.judge ?? defaultHermesJudge();
  const reportVerdicts = overrides.reportVerdicts ?? defaultReportVerdicts;
  const { qaIr, archive, bundles } = loadValidatedExecution({ runDirectory, integrityKey, cwd });
  const results = [];
  const perScenario = [];
  for (const bundle of bundles) {
    const result = await judge({ qaIr, bundle, manifest: archive.manifest, readBlob: archive.readBlob });
    // The judge outcome fields are provider-controlled enumerations and redacted messages — safe
    // to surface, and the difference between a model outage and a protocol bug lives here.
    if (result?.type === "ERROR") throw new CliError(`QA judgment failed (scenario=${bundle.scenarioId}${result.code === undefined ? "" : ` code=${result.code}`}${result.message === undefined ? "" : ` message=${result.message}`})`);
    validateContract("JudgeResult", result, { qaIr, evidenceBundle: bundle });
    results.push(result);
    perScenario.push({ scenarioId: bundle.scenarioId, verdict: result.verdict, confidence: result.confidence });
  }
  if (results.length === 0) throw new Error("QA evidence is empty");

  writePrivateJsonExclusive(relative(cwd, join(runDirectory, "judgment.json")), results, { cwd });
  const counted = perScenario.reduce((counts, { verdict }) => ({
    pass: counts.pass + (verdict === "PASS" ? 1 : 0),
    fail: counts.fail + (verdict === "FAIL" ? 1 : 0),
    skip: counts.skip + (verdict === "SKIP" ? 1 : 0),
    manualReview: counts.manualReview + (verdict === "MANUAL_REVIEW" ? 1 : 0),
  }), { pass: 0, fail: 0, skip: 0, manualReview: 0 });
  const totals = counted.skip > 0 ? counted : { pass: counted.pass, fail: counted.fail, manualReview: counted.manualReview };
  reportVerdicts({ perScenario, totals });
  if (failOn === "fail" && totals.fail > 0) return 1;
  if (failOn === "manual-review" && (totals.fail > 0 || totals.manualReview > 0)) return 1;
  return 0;
}

function defaultHermesJudge() {
  const semanticJudge = createHermesSemanticJudge();
  return (input) => judgeEvidence({ ...input, semanticJudge });
}

// A run's judgment was previously silent (exit 0, no output) regardless of how many scenarios failed,
// leaving CI and operators to dig through JSON to learn the outcome. Emit one line per scenario plus a
// totals line, and let --fail-on turn FAIL/MANUAL_REVIEW verdicts into a nonzero exit for CI gating.
function defaultReportVerdicts({ perScenario, totals }) {
  for (const { scenarioId, verdict, confidence } of perScenario) {
    process.stdout.write(`qa-native judge: ${scenarioId} ${verdict} (confidence ${confidence})\n`);
  }
  const skipNote = (totals.skip ?? 0) > 0 ? `, ${totals.skip} skip` : "";
  process.stdout.write(`verdicts: ${totals.pass} pass, ${totals.fail} fail${skipNote}, ${totals.manualReview} manual-review\n`);
}
