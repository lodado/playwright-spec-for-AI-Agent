import { lstatSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { RUNTIME_OUTCOME_VERSION, canonicalHash, validateContract } from "../contracts/index.mjs";
import { readEvidenceArchive } from "../evidence/index.mjs";
import { judgeWithHermes } from "../provider-hermes/index.mjs";
import { validateAdaptiveExecutionEvidence } from "./qa-native-adaptive-evidence.mjs";
import { createExclusiveQaDirectory, readPrivateJson, writePrivateJsonExclusive } from "./qa-native.mjs";

export async function judgeQaNative({ runDirectory, integrityKey, cwd }, overrides = {}) {
  const judge = overrides.judge ?? judgeWithHermes;
  const outcome = readPrivateJson(relative(cwd, join(runDirectory, "run.json")), { cwd });
  validateContract("RuntimeOutcome", outcome);
  if (outcome.stage !== "execute" || outcome.type !== "COMPLETED") throw new Error("QA execution is incomplete");

  const qaIr = readPrivateJson(relative(cwd, join(runDirectory, "qa-ir.json")), { cwd });
  validateContract("QaIrDocument", qaIr);
  const archive = readEvidenceArchive({ directory: join(runDirectory, "evidence"), integrityKey });
  let bundles = archive.bundles;
  const agentInputPath = relative(cwd, join(runDirectory, "execution-agent-input.json"));
  const agentOutcomePath = relative(cwd, join(runDirectory, "execution-agent-outcome.json"));
  const hasAgentInput = entryExists(agentInputPath, cwd);
  const hasAgentOutcome = entryExists(agentOutcomePath, cwd);
  if (hasAgentInput || hasAgentOutcome) {
    if (!hasAgentInput || !hasAgentOutcome) throw new Error("adaptive execution metadata is incomplete");
    const agentInput = readPrivateJson(agentInputPath, { cwd });
    const agentOutcome = readPrivateJson(agentOutcomePath, { cwd });
    validateContract("ExecutionAgentInput", agentInput);
    validateContract("ExecutionAgentOutcome", agentOutcome, { input: agentInput });
    if (agentOutcome.type !== "COMPLETED") throw new Error("adaptive execution is incomplete");
    if (agentInput.runId !== archive.manifest.runId) throw new Error("adaptive execution metadata does not match evidence");
    validateAdaptiveExecutionEvidence({ input: agentInput, outcome: agentOutcome, ...archive });
    const finalBundle = archive.bundles.filter((bundle) => bundle.scenarioId === agentOutcome.scenarioId).at(-1);
    if (finalBundle === undefined) throw new Error("adaptive final evidence is missing");
    bundles = [finalBundle];
  }
  const results = [];
  for (const bundle of bundles) {
    const result = await judge({ qaIr, bundle, manifest: archive.manifest, readBlob: archive.readBlob });
    if (result?.type === "ERROR") throw new Error("QA judgment failed");
    validateContract("JudgeResult", result, { qaIr, evidenceBundle: bundle });
    results.push(result);
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
    return 0;
  } catch (error) {
    if (created) rmSync(judgmentDirectory, { recursive: true, force: true });
    throw error;
  }
}

function entryExists(path, cwd) {
  try {
    lstatSync(join(cwd, path));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function shortHash(value) {
  return canonicalHash(value).slice("sha256:".length, "sha256:".length + 16);
}
