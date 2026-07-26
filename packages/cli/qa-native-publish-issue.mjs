import { rmSync } from "node:fs";
import { join, relative } from "node:path";

import { canonicalHash } from "../contracts/index.mjs";
import { createGitHubCliIssueTransport, publishGitHubFailureIssue } from "../reporter-github/index.mjs";
import { prepareQaNativeRemediation } from "./qa-native-report.mjs";
import { createExclusiveQaDirectory, writePrivateJsonExclusive } from "./qa-native.mjs";

export async function publishIssueQaNative({ runDirectory, repositoryRoot, repository, revision, judgmentPath, integrityKey, cwd, githubTransport } = {}) {
  const prepared = prepareQaNativeRemediation({ runDirectory, repositoryRoot, repositoryId: repository, revision, judgmentPath, integrityKey, cwd });
  if (prepared.items.length !== 1) throw new Error("GitHub Issue publication requires exactly one failing judgment");

  const item = prepared.items[0];
  const publicationHash = canonicalHash({ repository, revision: prepared.repositoryRevision, judgeResultId: item.judgeResult.resultId }).slice("sha256:".length, "sha256:".length + 16);
  const publicationDirectory = join(runDirectory, "publications", `github-issue-${publicationHash}`);
  createExclusiveQaDirectory(relative(cwd, publicationDirectory), { cwd });

  let attempted = false;
  try {
    const transport = githubTransport ?? createGitHubCliIssueTransport();
    const result = await publishGitHubFailureIssue({
      repository,
      qaIr: prepared.qaIr,
      ...item,
      verifyCodeContext: transport.verifyCodeContext,
      transport: async (request) => {
        attempted = true;
        const result = await transport.createIssue(request);
        return result;
      },
    });
    writePrivateJsonExclusive(relative(cwd, join(publicationDirectory, "github-publication-result.json")), result, { cwd });
    return 0;
  } catch (error) {
    if (!attempted) rmSync(publicationDirectory, { recursive: true, force: true });
    throw error;
  }
}
