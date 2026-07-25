import { readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { RUNTIME_OUTCOME_VERSION, canonicalHash, validateContract } from "../contracts/index.mjs";
import { readEvidenceArchive } from "../evidence/index.mjs";
import { diagnoseFailure, recommendRepair } from "../remediation/index.mjs";
import { createLocalRepositorySnapshot, locateCode } from "../repository-provider/index.mjs";
import { renderRemediationReport } from "../reporter-markdown/index.mjs";
import { createExclusiveQaDirectory, readPrivateJson, writePrivateFileExclusive, writePrivateJsonExclusive } from "./qa-native.mjs";

export async function reportQaNative({ runDirectory, repositoryRoot, revision, judgmentPath, integrityKey, cwd }) {
  const outcome = readPrivateJson(relative(cwd, join(runDirectory, "run.json")), { cwd });
  validateContract("RuntimeOutcome", outcome);
  if (outcome.stage !== "execute" || outcome.type !== "COMPLETED") throw new Error("QA execution is incomplete");

  const qaIr = readPrivateJson(relative(cwd, join(runDirectory, "qa-ir.json")), { cwd });
  validateContract("QaIrDocument", qaIr);
  const archive = readEvidenceArchive({ directory: join(runDirectory, "evidence"), integrityKey });
  const snapshot = createLocalRepositorySnapshot({ root: repositoryRoot, revision });
  const results = readJudgeResults({ runDirectory, judgmentPath, cwd }).filter((result) => ["FAIL", "MANUAL_REVIEW"].includes(result.verdict));
  if (results.length === 0) throw new Error("QA report has no failing judgments");

  const reportHash = shortHash({ results: results.map((result) => result.resultId), repositoryRevision: snapshot.revision });
  const reportDirectory = join(runDirectory, "reports", `report-${reportHash}`);
  let created = false;
  try {
    createExclusiveQaDirectory(relative(cwd, reportDirectory), { cwd });
    created = true;
    for (const result of results) {
      const bundle = archive.bundles.find((candidate) => candidate.bundleId === result.evidenceBundleId);
      if (!bundle) throw new Error("QA judgment evidence is missing");
      validateContract("JudgeResult", result, { qaIr, evidenceBundle: bundle });
      const diagnosis = diagnoseFailure({ qaIr, judgeResult: result, evidenceBundle: bundle });
      const codeContext = locateCode({ snapshot, diagnosis, judgeResult: result, qaIr, evidenceBundle: bundle });
      const recommendation = recommendRepair({ diagnosis, codeContext, qaIr, judgeResult: result, evidenceBundle: bundle });
      const suffix = shortHash(result.resultId);
      writePrivateJsonExclusive(relative(cwd, join(reportDirectory, `diagnosis-${suffix}.json`)), diagnosis, { cwd });
      writePrivateJsonExclusive(relative(cwd, join(reportDirectory, `code-context-${suffix}.json`)), codeContext, { cwd });
      writePrivateJsonExclusive(relative(cwd, join(reportDirectory, `repair-recommendation-${suffix}.json`)), recommendation, { cwd });
      writePrivateFileExclusive(relative(cwd, join(reportDirectory, `report-${suffix}.md`)), renderRemediationReport({ diagnosis, codeContext, recommendation, qaIr, judgeResult: result, evidenceBundle: bundle }), { cwd });
    }
    writePrivateJsonExclusive(relative(cwd, join(reportDirectory, "run.json")), { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "report", type: "COMPLETED" }, { cwd });
    return 0;
  } catch (error) {
    if (created) rmSync(reportDirectory, { recursive: true, force: true });
    throw error;
  }
}

function readJudgeResults({ runDirectory, judgmentPath, cwd }) {
  const paths = judgmentPath === undefined ? discoverJudgeResults(runDirectory) : [judgmentPath];
  return paths.map((path) => readPrivateJson(relative(cwd, path), { cwd }));
}

function discoverJudgeResults(runDirectory) {
  const root = join(runDirectory, "judgments");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => readdirSync(join(root, entry.name), { withFileTypes: true })
      .filter((file) => file.isFile() && file.name.startsWith("judge-result-") && file.name.endsWith(".json"))
      .map((file) => join(root, entry.name, file.name)))
    .sort();
}

function shortHash(value) {
  return canonicalHash(value).slice("sha256:".length, "sha256:".length + 16);
}
