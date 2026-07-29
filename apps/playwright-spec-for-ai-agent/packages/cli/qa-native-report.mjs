import { readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { RUNTIME_OUTCOME_VERSION, canonicalHash, validateContract } from "../contracts/index.mjs";
import { readEvidenceArchive } from "../evidence/index.mjs";
import { diagnoseFailure, recommendRepair } from "../remediation/index.mjs";
import { createLocalRepositorySnapshot, locateCode } from "../repository-provider/index.mjs";
import { renderRemediationReport } from "../reporter-markdown/index.mjs";
import { validateAdaptiveExecutionEvidence } from "./qa-native-adaptive-evidence.mjs";
import { readAuthenticatedRunEnvelope, verifyRunEnvelopeBindings } from "./qa-native-run-envelope.mjs";
import { createExclusiveQaDirectory, readPrivateJson, writePrivateFileExclusive, writePrivateJsonExclusive } from "./qa-native.mjs";

export async function reportQaNative({ runDirectory, repositoryRoot, revision, judgmentPath, integrityKey, cwd }) {
  const prepared = prepareQaNativeRemediation({ runDirectory, repositoryRoot, revision, judgmentPath, integrityKey, cwd });
  const reportHash = shortHash({ results: prepared.items.map(({ judgeResult }) => judgeResult.resultId), repositoryRevision: prepared.repositoryRevision });
  const reportDirectory = join(runDirectory, "reports", `report-${reportHash}`);
  let created = false;
  try {
    createExclusiveQaDirectory(relative(cwd, reportDirectory), { cwd });
    created = true;
    for (const { judgeResult, evidenceBundle, diagnosis, codeContext, recommendation } of prepared.items) {
      const suffix = shortHash(judgeResult.resultId);
      writePrivateJsonExclusive(relative(cwd, join(reportDirectory, `diagnosis-${suffix}.json`)), diagnosis, { cwd });
      writePrivateJsonExclusive(relative(cwd, join(reportDirectory, `code-context-${suffix}.json`)), codeContext, { cwd });
      writePrivateJsonExclusive(relative(cwd, join(reportDirectory, `repair-recommendation-${suffix}.json`)), recommendation, { cwd });
      writePrivateFileExclusive(relative(cwd, join(reportDirectory, `report-${suffix}.md`)), renderRemediationReport({ diagnosis, codeContext, recommendation, qaIr: prepared.qaIr, judgeResult, evidenceBundle }), { cwd });
    }
    writePrivateJsonExclusive(relative(cwd, join(reportDirectory, "run.json")), { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "report", type: "COMPLETED" }, { cwd });
    return 0;
  } catch (error) {
    if (created) rmSync(reportDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function prepareQaNativeRemediation({ runDirectory, repositoryRoot, revision, judgmentPath, integrityKey, cwd, repositoryId }) {
  const outcome = readPrivateJson(relative(cwd, join(runDirectory, "run.json")), { cwd });
  validateContract("RuntimeOutcome", outcome);
  if (outcome.stage !== "execute" || outcome.type !== "COMPLETED") throw new Error("QA execution is incomplete");

  const qaIr = readPrivateJson(relative(cwd, join(runDirectory, "qa-ir.json")), { cwd });
  validateContract("QaIrDocument", qaIr);
  const archive = readEvidenceArchive({ directory: join(runDirectory, "evidence"), integrityKey });
  const envelope = readAuthenticatedRunEnvelope({ runDirectory, cwd, integrityKey });
  const expectedBundles = expectedJudgedBundles({ runDirectory, archive, envelope, qaIr, runtimeOutcome: outcome, cwd });
  const judgments = readJudgeResults({ runDirectory, judgmentPath, cwd }).map((result) => {
    const bundle = archive.bundles.find((candidate) => candidate.bundleId === result.evidenceBundleId);
    if (!bundle) throw new Error("QA judgment evidence is missing");
    validateContract("JudgeResult", result, { qaIr, evidenceBundle: bundle });
    return { result, bundle };
  });
  if (judgmentPath === undefined) assertCompleteJudgmentSet(judgments, expectedBundles);
  const selected = judgments.filter(({ result }) => ["FAIL", "MANUAL_REVIEW"].includes(result.verdict));
  if (selected.length === 0) throw new Error("QA report has no failing judgments");

  const snapshot = createLocalRepositorySnapshot({ root: repositoryRoot, revision, repositoryId });
  const items = selected.map(({ result, bundle }) => {
    const diagnosis = diagnoseFailure({ qaIr, judgeResult: result, evidenceBundle: bundle });
    const codeContext = locateCode({ snapshot, diagnosis, judgeResult: result, qaIr, evidenceBundle: bundle });
    const recommendation = recommendRepair({ diagnosis, codeContext, qaIr, judgeResult: result, evidenceBundle: bundle });
    return { judgeResult: result, evidenceBundle: bundle, diagnosis, codeContext, recommendation };
  });
  return Object.freeze({ qaIr, repositoryRevision: snapshot.revision, items: Object.freeze(items) });
}

function expectedJudgedBundles({ runDirectory, archive, envelope, qaIr, runtimeOutcome, cwd }) {
  if (envelope.mode === "strict") {
    const executionPlan = readPrivateJson(relative(cwd, join(runDirectory, "execution-plan.json")), { cwd });
    verifyRunEnvelopeBindings({ envelope, runId: envelope.runId, mode: "strict", qaIr, runtimeOutcome, evidenceManifest: archive.manifest, executionPlan });
    return archive.bundles;
  }
  const inputs = readPrivateJson(relative(cwd, join(runDirectory, "execution-agent-inputs.json")), { cwd });
  const outcomes = readPrivateJson(relative(cwd, join(runDirectory, "execution-agent-outcomes.json")), { cwd });
  if (!Array.isArray(inputs) || !Array.isArray(outcomes) || inputs.length === 0 || inputs.length !== outcomes.length) throw new Error("adaptive execution metadata is invalid");
  inputs.forEach((input, index) => {
    validateContract("ExecutionAgentInput", input);
    const outcome = validateContract("ExecutionAgentOutcome", outcomes[index], { input });
    if (outcome.type !== "COMPLETED" || input.runId !== archive.manifest.runId) throw new Error("adaptive execution metadata does not match evidence");
  });
  verifyRunEnvelopeBindings({ envelope, runId: envelope.runId, mode: "adaptive", qaIr, runtimeOutcome, evidenceManifest: archive.manifest, executionAgentInputs: inputs, executionAgentOutcomes: outcomes });
  return inputs.map((input, index) => {
    const scenarioBundles = archive.bundles.filter((bundle) => bundle.scenarioId === input.scenarioId);
    validateAdaptiveExecutionEvidence({ input, outcome: outcomes[index], bundles: scenarioBundles, manifest: archive.manifest, readBlob: archive.readBlob });
    const finalBundle = scenarioBundles.at(-1);
    if (finalBundle === undefined) throw new Error("adaptive final evidence is missing");
    return finalBundle;
  });
}

function readJudgeResults({ runDirectory, judgmentPath, cwd }) {
  const paths = judgmentPath === undefined ? discoverJudgeResults(runDirectory, cwd) : completedJudgmentFile(judgmentPath, cwd);
  return paths.map((path) => readPrivateJson(privateRelative(cwd, path), { cwd }));
}

function discoverJudgeResults(runDirectory, cwd) {
  const root = join(runDirectory, "judgments");
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isDirectory())) throw new Error("judgment storage contains an unexpected entry");
  const directories = entries;
  if (directories.length !== 1) throw new Error("an explicit judgment path is required");
  const directory = join(root, directories[0].name);
  assertCompletedJudgment(directory, cwd);
  const files = readdirSync(directory, { withFileTypes: true });
  if (files.some((file) => !file.isFile() || (file.name !== "run.json" && !(file.name.startsWith("judge-result-") && file.name.endsWith(".json"))))) {
    throw new Error("judgment set contains an unexpected entry");
  }
  return files
      .filter((file) => file.name.startsWith("judge-result-"))
      .map((file) => join(directory, file.name))
    .sort();
}

function assertCompleteJudgmentSet(judgments, bundles) {
  const expected = new Set(bundles.map((bundle) => bundle.bundleId));
  const actual = judgments.map(({ result }) => result.evidenceBundleId);
  const resultIds = judgments.map(({ result }) => result.resultId);
  if (new Set(resultIds).size !== resultIds.length || new Set(actual).size !== actual.length || actual.length !== expected.size || actual.some((id) => !expected.has(id))) {
    throw new Error("judgment set does not cover every evidence bundle exactly once");
  }
}

function completedJudgmentFile(path, cwd) {
  assertCompletedJudgment(dirname(path), cwd);
  return [path];
}

function assertCompletedJudgment(directory, cwd) {
  const outcome = readPrivateJson(privateRelative(cwd, join(directory, "run.json")), { cwd });
  validateContract("RuntimeOutcome", outcome);
  if (outcome.stage !== "judge" || outcome.type !== "COMPLETED") throw new Error("QA judgment is incomplete");
}

function privateRelative(cwd, path) {
  for (const root of [resolve(cwd), realpathSync(cwd)]) {
    const value = relative(root, path);
    if (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value)) return value;
  }
  return relative(resolve(cwd), path);
}

function shortHash(value) {
  return canonicalHash(value).slice("sha256:".length, "sha256:".length + 16);
}
