import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { validateContract } from "../contracts/index.mjs";
import { readEvidenceArchive } from "../evidence/index.mjs";
import { validateAdaptiveExecutionEvidence } from "./qa-native-adaptive-evidence.mjs";
import { readAuthenticatedRunEnvelope, verifyRunEnvelopeBindings } from "./qa-native-run-envelope.mjs";
import { readPrivateJson } from "./qa-native.mjs";

export function loadValidatedExecution({ runDirectory, integrityKey, cwd }) {
  const outcome = readPrivateJson(relative(cwd, join(runDirectory, "run.json")), { cwd });
  validateContract("RuntimeOutcome", outcome);
  if (outcome.stage !== "execute" || outcome.type !== "COMPLETED") throw new Error("QA execution is incomplete");

  const qaIr = readPrivateJson(relative(cwd, join(runDirectory, "qa-ir.json")), { cwd });
  validateContract("QaIrDocument", qaIr);
  const archive = readEvidenceArchive({ directory: join(runDirectory, "evidence"), integrityKey });
  const envelope = readAuthenticatedRunEnvelope({ runDirectory, cwd, integrityKey });

  if (envelope.mode === "strict") {
    const executionPlan = readPrivateJson(relative(cwd, join(runDirectory, "execution-plan.json")), { cwd });
    verifyRunEnvelopeBindings({ envelope, runId: envelope.runId, mode: "strict", qaIr, runtimeOutcome: outcome, evidenceManifest: archive.manifest, executionPlan });
    return { outcome, qaIr, archive, bundles: archive.bundles };
  }

  const inputs = readPrivateJson(relative(cwd, join(runDirectory, "execution-agent-inputs.json")), { cwd });
  const outcomes = readPrivateJson(relative(cwd, join(runDirectory, "execution-agent-outcomes.json")), { cwd });
  if (!Array.isArray(inputs) || !Array.isArray(outcomes) || inputs.length === 0 || inputs.length !== outcomes.length) throw new Error("adaptive execution metadata is invalid");
  inputs.forEach((input, index) => {
    validateContract("ExecutionAgentInput", input);
    validateContract("ExecutionAgentOutcome", outcomes[index], { input });
    if (input.runId !== archive.manifest.runId) throw new Error("adaptive execution metadata does not match evidence");
  });
  verifyRunEnvelopeBindings({ envelope, runId: envelope.runId, mode: "adaptive", qaIr, runtimeOutcome: outcome, evidenceManifest: archive.manifest, executionAgentInputs: inputs, executionAgentOutcomes: outcomes });

  const bundles = inputs.map((input, index) => {
    const scenarioBundles = archive.bundles.filter((bundle) => bundle.scenarioId === input.scenarioId);
    if (scenarioBundles.length === 0 && outcomes[index].type !== "COMPLETED") return undefined;
    validateAdaptiveExecutionEvidence({ input, outcome: outcomes[index], bundles: scenarioBundles, manifest: archive.manifest, readBlob: archive.readBlob });
    const finalBundle = scenarioBundles.at(-1);
    if (finalBundle === undefined) throw new Error("adaptive final evidence is missing");
    return finalBundle;
  }).filter(Boolean);

  return { outcome, qaIr, archive, bundles };
}

export function loadCompletedJudgmentSet({ runDirectory, judgmentPath, cwd, qaIr, bundles, requireComplete = false }) {
  const paths = judgmentPath === undefined ? discoverJudgeResults(runDirectory, cwd) : completedJudgmentPaths(judgmentPath, cwd);
  const judgments = paths.map((path) => {
    const result = readPrivateJson(privateRelative(cwd, path), { cwd });
    const bundle = bundles.find((candidate) => candidate.bundleId === result.evidenceBundleId);
    if (!bundle) throw new Error("QA judgment evidence is missing");
    validateContract("JudgeResult", result, { qaIr, evidenceBundle: bundle });
    return { result, bundle };
  });
  if (judgmentPath === undefined || requireComplete) assertCompleteJudgmentSet(judgments, bundles);
  return judgments;
}

export function loadCompletedReviewSet({ runDirectory, cwd, qaIr, judgments }) {
  const root = join(runDirectory, "reviews");
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isDirectory()) || entries.length === 0) throw new Error("a completed review set is required");
  const expected = new Set(judgments.map(({ result }) => result.resultId));
  const candidates = entries.map(entry => readCompletedReviewSet(join(root, entry.name), cwd, qaIr, judgments, expected)).filter(Boolean);
  if (candidates.length !== 1) throw new Error("a single matching completed review set is required");
  return candidates[0];
}

function readCompletedReviewSet(directory, cwd, qaIr, judgments, expected) {
  const outcome = readPrivateJson(privateRelative(cwd, join(directory, "run.json")), { cwd });
  validateContract("RuntimeOutcome", outcome);
  if (outcome.stage !== "review" || outcome.type !== "COMPLETED") throw new Error("QA judgment review is incomplete");
  const files = readdirSync(directory, { withFileTypes: true });
  if (files.some((file) => !file.isFile() || (file.name !== "run.json" && !(file.name.startsWith("review-result-") && file.name.endsWith(".json"))))) throw new Error("review set contains an unexpected entry");
  const reviews = files.filter((file) => file.name.startsWith("review-result-")).map((file) => {
    const review = readPrivateJson(privateRelative(cwd, join(directory, file.name)), { cwd });
    const judgment = judgments.find(({ result }) => result.resultId === review.judgeResultId);
    validateContract("JudgmentReview", review, judgment ? { qaIr, judgeResult: judgment.result, evidenceBundle: judgment.bundle } : {});
    if (review.qaIrId !== qaIr.id) throw new Error("QA judgment review does not match the run");
    return review;
  });
  const selected = reviews.filter((review) => expected.has(review.judgeResultId));
  const actual = selected.map((review) => review.judgeResultId);
  return new Set(actual).size === actual.length && actual.length === expected.size && actual.every((id) => expected.has(id)) ? selected : null;
}

function discoverJudgeResults(runDirectory, cwd) {
  const root = join(runDirectory, "judgments");
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isDirectory()) || entries.length !== 1) throw new Error("an explicit judgment path is required");
  return completedJudgmentDirectory(join(root, entries[0].name), cwd);
}

function completedJudgmentPaths(path, cwd) {
  return lstatSync(path).isDirectory() ? completedJudgmentDirectory(path, cwd) : completedJudgmentFile(path, cwd);
}

function completedJudgmentDirectory(directory, cwd) {
  assertCompletedJudgment(directory, cwd);
  const files = readdirSync(directory, { withFileTypes: true });
  if (files.some((file) => !file.isFile() || (file.name !== "run.json" && !(file.name.startsWith("judge-result-") && file.name.endsWith(".json"))))) throw new Error("judgment set contains an unexpected entry");
  return files.filter((file) => file.name.startsWith("judge-result-")).map((file) => join(directory, file.name)).sort();
}

function completedJudgmentFile(path, cwd) {
  const paths = completedJudgmentDirectory(dirname(path), cwd);
  if (!paths.some((candidate) => resolve(candidate) === resolve(path))) throw new Error("selected judgment result is not part of the completed set");
  return paths;
}

function assertCompletedJudgment(directory, cwd) {
  const outcome = readPrivateJson(privateRelative(cwd, join(directory, "run.json")), { cwd });
  validateContract("RuntimeOutcome", outcome);
  if (outcome.stage !== "judge" || outcome.type !== "COMPLETED") throw new Error("QA judgment is incomplete");
}

function assertCompleteJudgmentSet(judgments, bundles) {
  const expected = new Set(bundles.map((bundle) => bundle.bundleId));
  const actual = judgments.map(({ result }) => result.evidenceBundleId);
  const resultIds = judgments.map(({ result }) => result.resultId);
  if (new Set(resultIds).size !== resultIds.length || new Set(actual).size !== actual.length || actual.length !== expected.size || actual.some((id) => !expected.has(id))) throw new Error("judgment set does not cover every evidence bundle exactly once");
}

function privateRelative(cwd, path) {
  for (const root of [resolve(cwd), realpathSync(cwd)]) {
    const value = relative(root, path);
    if (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value)) return value;
  }
  return relative(resolve(cwd), path);
}
