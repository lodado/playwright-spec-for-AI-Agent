import { lstatSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { canonicalHash, validateContract } from "../contracts/index.mjs";
import { createGitHubCliIssueTransport, publishGitHubFailureIssue } from "../reporter-github/index.mjs";
import { prepareQaNativeRemediation } from "./qa-native-report.mjs";
import { createExclusiveQaDirectory, readPrivateJson, writePrivateJsonExclusive } from "./qa-native.mjs";

export async function publishIssueQaNative({ runDirectory, repositoryRoot, repository, revision, judgmentPath, integrityKey, publicationKey, cwd, githubTransport } = {}) {
  const prepared = prepareQaNativeRemediation({ runDirectory, repositoryRoot, repositoryId: repository, revision, judgmentPath, integrityKey, cwd });
  if (prepared.items.length !== 1) throw new Error("GitHub Issue publication requires exactly one failing judgment");

  const item = prepared.items[0];
  const publicationHash = canonicalHash({ repository, revision: prepared.repositoryRevision, judgeResultId: item.judgeResult.resultId }).slice("sha256:".length, "sha256:".length + 16);
  const publicationDirectory = join(runDirectory, "publications", `github-issue-${publicationHash}`);
  const intent = { schemaVersion: "github-publication-intent/0.1", repository, repositoryRevision: prepared.repositoryRevision, runId: item.evidenceBundle.runId, evidenceBundleId: item.evidenceBundle.bundleId, judgeResultId: item.judgeResult.resultId };
  const existed = pathExists(publicationDirectory);
  if (existed) {
    const persistedIntent = readPrivateJson(relative(cwd, join(publicationDirectory, "github-publication-intent.json")), { cwd });
    if (canonicalHash(persistedIntent) !== canonicalHash(intent)) throw new Error("GitHub publication intent is immutable");
    const resultPath = join(publicationDirectory, "github-publication-result.json");
    if (pathExists(resultPath)) {
      const result = readPrivateJson(relative(cwd, resultPath), { cwd });
      validateContract("GitHubPublicationResult", result);
      return result.action === "AMBIGUOUS" ? 1 : 0;
    }
  } else {
    createExclusiveQaDirectory(relative(cwd, publicationDirectory), { cwd });
    writePrivateJsonExclusive(relative(cwd, join(publicationDirectory, "github-publication-intent.json")), intent, { cwd });
  }

  let attempted = false;
  try {
    const transport = githubTransport ?? createGitHubCliIssueTransport();
    const result = await publishGitHubFailureIssue({
      repository,
      qaIr: prepared.qaIr,
      ...item,
      stateAuthenticationKey: publicationKey,
      verifyCodeContext: transport.verifyCodeContext,
      findOpenPublications: transport.findOpenPublications,
      findRecentPublications: transport.findRecentPublications,
      readPublication: transport.readPublication,
      listOccurrenceRecords: transport.listOccurrenceRecords,
      transport: async (request) => {
        attempted = true;
        const result = await transport.createIssue(request);
        return result;
      },
      createOccurrenceRecord: async (request) => {
        attempted = true;
        return transport.createOccurrenceRecord(request);
      },
    });
    writePrivateJsonExclusive(relative(cwd, join(publicationDirectory, "github-publication-result.json")), result, { cwd });
    return result.action === "AMBIGUOUS" ? 1 : 0;
  } catch (error) {
    if (!existed && !attempted) rmSync(publicationDirectory, { recursive: true, force: true });
    throw error;
  }
}

function pathExists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
