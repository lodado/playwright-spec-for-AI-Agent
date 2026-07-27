import { rmSync } from "node:fs";
import { join, relative } from "node:path";

import { RUNTIME_OUTCOME_VERSION } from "../contracts/index.mjs";
import { createPatchProposal } from "../remediation/index.mjs";
import { createHermesPatchProposer } from "../provider-hermes/index.mjs";
import { prepareQaNativeRemediation } from "./qa-native-report.mjs";
import { createExclusiveQaDirectory, writePrivateJsonExclusive } from "./qa-native.mjs";
import { loadProjectConfig } from "../../scripts/hermes-qa-project-config.mjs";

export async function proposePatchQaNative(options, overrides = {}) {
  const prepare = overrides.prepare ?? prepareQaNativeRemediation;
  const propose = overrides.propose ?? createHermesPatchProposer();
  const build = overrides.build ?? createPatchProposal;
  const loadPolicy = overrides.loadPolicy ?? loadPatchPolicy;
  const prepared = prepare(options);
  if (prepared.items.length !== 1) throw new Error("patch proposal requires exactly one failing judgment");
  const { diagnosis, codeContext, recommendation } = prepared.items[0];
  const modelOutput = await propose({ diagnosis, codeContext, recommendation });
  const policy = await loadPolicy(options.repositoryRoot);
  const proposal = build({
    diagnosis,
    codeContext,
    recommendation,
    modelOutput,
    repositoryRoot: options.repositoryRoot,
    policy,
  });
  const proposalDirectory = join(options.runDirectory, "proposals", proposal.proposalId);
  let created = false;
  try {
    createExclusiveQaDirectory(relative(options.cwd, proposalDirectory), { cwd: options.cwd });
    created = true;
    writePrivateJsonExclusive(relative(options.cwd, join(proposalDirectory, "model-output.json")), JSON.parse(JSON.stringify(modelOutput)), { cwd: options.cwd });
    writePrivateJsonExclusive(relative(options.cwd, join(proposalDirectory, "patch-proposal.json")), proposal, { cwd: options.cwd });
    writePrivateJsonExclusive(relative(options.cwd, join(proposalDirectory, "run.json")), { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "propose-patch", type: "COMPLETED" }, { cwd: options.cwd });
    return 0;
  } catch (error) {
    if (created) rmSync(proposalDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function loadPatchPolicy(repositoryRoot) {
  const config = await loadProjectConfig([`--root=${repositoryRoot}`]);
  const value = config.remediation?.patch;
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["minimumConfidence", "maxFiles", "maxChangedLines", "allowedPaths", "deniedPaths"].includes(key))) {
    throw new Error("remediation patch config is invalid");
  }
  return JSON.parse(JSON.stringify(value));
}
