import { rmSync } from "node:fs";
import { join, relative } from "node:path";
import { RUNTIME_OUTCOME_VERSION, canonicalHash, validateContract } from "../contracts/index.mjs";
import { readEvidenceArchive } from "../evidence/index.mjs";
import { judgeWithHermes } from "../provider-hermes/index.mjs";
import { validateAdaptiveExecutionEvidence } from "./qa-native-adaptive-evidence.mjs";
import { readAuthenticatedRunEnvelope, verifyRunEnvelopeBindings } from "./qa-native-run-envelope.mjs";
import { createExclusiveQaDirectory, readPrivateJson, writePrivateJsonExclusive } from "./qa-native.mjs";

export async function judgeQaNative({ runDirectory, integrityKey, cwd, failOn }, overrides = {}) {
  const judge = overrides.judge ?? judgeWithHermes;
  const reportVerdicts = overrides.reportVerdicts ?? defaultReportVerdicts;
  const outcome = readPrivateJson(relative(cwd, join(runDirectory, "run.json")), { cwd });
  validateContract("RuntimeOutcome", outcome);
  if (outcome.stage !== "execute" || outcome.type !== "COMPLETED") throw new Error("QA execution is incomplete");

  const qaIr = readPrivateJson(relative(cwd, join(runDirectory, "qa-ir.json")), { cwd });
  validateContract("QaIrDocument", qaIr);
  const archive = readEvidenceArchive({ directory: join(runDirectory, "evidence"), integrityKey });
  const envelope = readAuthenticatedRunEnvelope({ runDirectory, cwd, integrityKey });
  let bundles = archive.bundles;
  if (envelope.mode === "adaptive") {
    const agentInputs = readPrivateJson(relative(cwd, join(runDirectory, "execution-agent-inputs.json")), { cwd });
    const agentOutcomes = readPrivateJson(relative(cwd, join(runDirectory, "execution-agent-outcomes.json")), { cwd });
    if (!Array.isArray(agentInputs) || !Array.isArray(agentOutcomes) || agentInputs.length === 0 || agentInputs.length !== agentOutcomes.length) throw new Error("adaptive execution metadata is invalid");
    agentInputs.forEach((agentInput, index) => {
      validateContract("ExecutionAgentInput", agentInput);
      validateContract("ExecutionAgentOutcome", agentOutcomes[index], { input: agentInput });
      if (agentInput.runId !== archive.manifest.runId) throw new Error("adaptive execution metadata does not match evidence");
    });
    verifyRunEnvelopeBindings({ envelope, runId: envelope.runId, mode: "adaptive", qaIr, runtimeOutcome: outcome, evidenceManifest: archive.manifest, executionAgentInputs: agentInputs, executionAgentOutcomes: agentOutcomes });
    const finalBundles = agentInputs.map((agentInput, index) => {
      const scenarioBundles = archive.bundles.filter((bundle) => bundle.scenarioId === agentInput.scenarioId);
      // A non-COMPLETED scenario may have failed before sealing any evidence — there is nothing to
      // judge, so skip it rather than failing the whole judgment.
      if (scenarioBundles.length === 0 && agentOutcomes[index].type !== "COMPLETED") return undefined;
      validateAdaptiveExecutionEvidence({ input: agentInput, outcome: agentOutcomes[index], bundles: scenarioBundles, manifest: archive.manifest, readBlob: archive.readBlob });
      const finalBundle = scenarioBundles.at(-1);
      if (finalBundle === undefined) throw new Error("adaptive final evidence is missing");
      return finalBundle;
    }).filter((bundle) => bundle !== undefined);
    bundles = finalBundles;
  } else {
    const executionPlan = readPrivateJson(relative(cwd, join(runDirectory, "execution-plan.json")), { cwd });
    verifyRunEnvelopeBindings({ envelope, runId: envelope.runId, mode: "strict", qaIr, runtimeOutcome: outcome, evidenceManifest: archive.manifest, executionPlan });
  }
  const results = [];
  const perScenario = [];
  for (const bundle of bundles) {
    const result = await judge({ qaIr, bundle, manifest: archive.manifest, readBlob: archive.readBlob });
    if (result?.type === "ERROR") throw new Error("QA judgment failed");
    validateContract("JudgeResult", result, { qaIr, evidenceBundle: bundle });
    results.push(result);
    perScenario.push({ scenarioId: bundle.scenarioId, verdict: result.verdict, confidence: result.confidence });
  }
  if (results.length === 0) throw new Error("QA evidence is empty");

  const judgmentHash = shortHash(results.map((result) => result.resultId));
  const judgmentDirectory = join(runDirectory, "judgments", `judge-${judgmentHash}`);
  let created = false;
  try {
    createExclusiveQaDirectory(relative(cwd, judgmentDirectory), { cwd });
    created = true;
    for (const result of results) {
      writePrivateJsonExclusive(
        relative(cwd, join(judgmentDirectory, `judge-result-${shortHash(result.evidenceBundleId)}.json`)),
        result,
        { cwd },
      );
    }
    writePrivateJsonExclusive(relative(cwd, join(judgmentDirectory, "run.json")), {
      schemaVersion: RUNTIME_OUTCOME_VERSION,
      stage: "judge",
      type: "COMPLETED",
    }, { cwd });
    const totals = perScenario.reduce((counts, { verdict }) => ({
      pass: counts.pass + (verdict === "PASS" ? 1 : 0),
      fail: counts.fail + (verdict === "FAIL" ? 1 : 0),
      manualReview: counts.manualReview + (verdict === "MANUAL_REVIEW" ? 1 : 0),
    }), { pass: 0, fail: 0, manualReview: 0 });
    reportVerdicts({ perScenario, totals });
    if (failOn === "fail" && totals.fail > 0) return 1;
    if (failOn === "manual-review" && (totals.fail > 0 || totals.manualReview > 0)) return 1;
    return 0;
  } catch (error) {
    if (created) rmSync(judgmentDirectory, { recursive: true, force: true });
    throw error;
  }
}

// A run's judgment was previously silent (exit 0, no output) regardless of how many scenarios failed,
// leaving CI and operators to dig through JSON to learn the outcome. Emit one line per scenario plus a
// totals line, and let --fail-on turn FAIL/MANUAL_REVIEW verdicts into a nonzero exit for CI gating.
function defaultReportVerdicts({ perScenario, totals }) {
  for (const { scenarioId, verdict, confidence } of perScenario) {
    process.stdout.write(`qa-native judge: ${scenarioId} ${verdict} (confidence ${confidence})\n`);
  }
  process.stdout.write(`verdicts: ${totals.pass} pass, ${totals.fail} fail, ${totals.manualReview} manual-review\n`);
}

function shortHash(value) {
  return canonicalHash(value).slice("sha256:".length, "sha256:".length + 16);
}
