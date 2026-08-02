import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { compileAbstractPlaywrightArtifact } from "../abstract-playwright/index.mjs";
import { canonicalHash, validateContract } from "../contracts/index.mjs";
import { readEvidenceArchive } from "../evidence/index.mjs";
import { applyPageTarget, mergeCompileResults, withoutPolicyBlockedScenarios } from "./qa-native-execute.mjs";
import { readBoundedSpec, readPrivateJson } from "./qa-native.mjs";

export function loadValidatedExecution({ runDirectory, integrityKey, cwd }) {
  const authority = readPrivateJson(relative(cwd, join(runDirectory, "authority.json")), { cwd });
  const behavior = readPrivateJson(relative(cwd, join(runDirectory, "behavior.json")), { cwd });
  const authorities = list(authority);
  const behaviors = list(behavior);
  if (authorities.length === 0 || authorities.length !== behaviors.length) throw new Error("QA authority and behavior coverage do not match");

  const compiled = authorities.map((manifest, index) => {
    const sourcePath = containedSourcePath(cwd, manifest?.source?.path);
    const source = readBoundedSpec(sourcePath);
    return compileAbstractPlaywrightArtifact({ artifact: behaviors[index], manifest, source, sourcePath: manifest.source.path });
  });
  let qaIr = withoutPolicyBlockedScenarios(compiled.length === 1 ? compiled[0].qaIr : mergeCompileResults(compiled).qaIr);
  const targets = authorities.map(item => item.target).filter(Boolean);
  if (targets.length > 0) {
    if (targets.length !== authorities.length || new Set(targets.map(canonicalHash)).size !== 1) throw new Error("QA authority targets do not match");
    qaIr = applyPageTarget(qaIr, targets[0]);
  }

  const archive = readEvidenceArchive({ directory: join(runDirectory, "evidence"), integrityKey });
  if (archive.manifest.runId !== basename(runDirectory)) throw new Error("QA evidence does not match its run directory");
  if (archive.manifest.bindings?.authorityHash !== canonicalHash(authority) || archive.manifest.bindings?.behaviorHash !== canonicalHash(behavior)) throw new Error("QA evidence bindings do not match authority and behavior");

  const scenarioIds = new Set(qaIr.suites.flatMap(suite => suite.scenarios.map(scenario => scenario.id)));
  if (archive.bundles.some(bundle => !scenarioIds.has(bundle.scenarioId))) throw new Error("QA evidence references unknown behavior");
  const finalByScenario = new Map();
  for (const bundle of archive.bundles) finalByScenario.set(bundle.scenarioId, bundle);
  const bundles = [...finalByScenario.values()];
  if (bundles.length === 0) throw new Error("QA evidence is empty");
  return { authority, behavior, qaIr, archive, bundles };
}

export function loadCompletedJudgmentSet({ runDirectory, cwd, qaIr, bundles }) {
  const results = readPrivateJson(relative(cwd, join(runDirectory, "judgment.json")), { cwd });
  if (!Array.isArray(results) || results.length !== bundles.length) throw new Error("QA judgment set is incomplete");
  const judgments = results.map(result => {
    const bundle = bundles.find(candidate => candidate.bundleId === result.evidenceBundleId);
    if (!bundle) throw new Error("QA judgment evidence is missing");
    validateContract("JudgeResult", result, { qaIr, evidenceBundle: bundle });
    return { result, bundle };
  });
  const expected = new Set(bundles.map(bundle => bundle.bundleId));
  const actual = judgments.map(({ result }) => result.evidenceBundleId);
  if (new Set(actual).size !== expected.size || actual.some(id => !expected.has(id))) throw new Error("QA judgment set must cover every evidence bundle exactly once");
  return judgments;
}

export function loadCompletedReviewSet({ runDirectory, cwd, qaIr, judgments }) {
  const reviews = readPrivateJson(relative(cwd, join(runDirectory, "review.json")), { cwd });
  if (!Array.isArray(reviews) || reviews.length !== judgments.length) throw new Error("QA review set is incomplete");
  const expected = new Set(judgments.map(({ result }) => result.resultId));
  for (const review of reviews) {
    const judgment = judgments.find(({ result }) => result.resultId === review.judgeResultId);
    validateContract("JudgmentReview", review, judgment ? { qaIr, judgeResult: judgment.result, evidenceBundle: judgment.bundle } : {});
    if (!expected.delete(review.judgeResultId)) throw new Error("QA review set contains duplicate or unknown judgment");
  }
  if (expected.size > 0) throw new Error("QA review set is incomplete");
  return reviews;
}

function list(value) {
  return Array.isArray(value) ? value : [value];
}

function containedSourcePath(cwd, sourcePath) {
  if (typeof sourcePath !== "string" || sourcePath.length === 0 || isAbsolute(sourcePath)) throw new Error("QA authority source path is invalid");
  const root = resolve(cwd);
  const target = resolve(root, sourcePath);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("QA authority source path escapes the project");
  return target;
}
