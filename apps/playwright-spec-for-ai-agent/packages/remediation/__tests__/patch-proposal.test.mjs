import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CODE_CONTEXT_VERSION, FAILURE_DIAGNOSIS_VERSION, PATCH_PROPOSAL_VERSION, REPAIR_RECOMMENDATION_VERSION, canonicalHash, validateContract } from "../../contracts/index.mjs";
import { createPatchProposal } from "../index.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PatchProposal remediation gate", () => {
  it("binds a bounded proposal to the pinned repository without changing it", () => {
    const fixture = repositoryFixture();
    const artifacts = remediationArtifacts(fixture);
    const before = readFileSync(join(fixture.root, fixture.path));
    const proposal = createPatchProposal({ ...artifacts, modelOutput: modelProposal(artifacts), repositoryRoot: fixture.root });

    expect(validateContract("PatchProposal", proposal, artifacts)).toBe(proposal);
    expect(proposal).toMatchObject({ schemaVersion: PATCH_PROPOSAL_VERSION, baseRevision: fixture.revision, files: [{ path: fixture.path, action: "MODIFY", originalContentHash: fixture.hash }] });
    expect(proposal.proposalId).toMatch(/^patch-proposal-[0-9a-f]{16}$/);
    expect(Object.isFrozen(proposal.operations[0])).toBe(true);
    expect(() => validateContract("PatchProposal", { ...proposal, files: [{ ...proposal.files[0], originalContentHash: `sha256:${"0".repeat(64)}` }] }, artifacts)).toThrow(/originalContentHash/);
    expect(() => validateContract("PatchProposal", { ...proposal, operations: [{ ...proposal.operations[0], startLine: 3, endLine: 3 }] }, artifacts)).toThrow(/outside CodeContext/);
    const create = { type: "CREATE_FILE", path: "src/new.mjs", content: "export {};" };
    expect(() => validateContract("PatchProposal", { ...proposal, files: [...proposal.files, { path: create.path, action: "CREATE" }], operations: [...proposal.operations, create, create] }, artifacts)).toThrow(/exactly one operation/);
    expect(readFileSync(join(fixture.root, fixture.path))).toEqual(before);
    expect(git(fixture.root, ["status", "--short"])).toBe("");
  });

  it("rejects ineligible origins, invented references, stale hashes, overlaps, and configured limits", () => {
    const fixture = repositoryFixture();
    const artifacts = remediationArtifacts(fixture);
    const valid = modelProposal(artifacts);
    const cases = [
      ["ineligible origin", { ...artifacts, diagnosis: { ...artifacts.diagnosis, origin: "ENVIRONMENT", remediationEligible: false, manualReviewReasons: ["manual"] }, modelOutput: valid }, /ineligible diagnoses require manual review/],
      ["invented reference", { ...artifacts, modelOutput: { ...valid, diagnosisId: "invented" } }, /diagnosisId/],
      ["stale hash", { ...artifacts, modelOutput: { ...valid, files: [{ ...valid.files[0], originalContentHash: `sha256:${"0".repeat(64)}` }] } }, /originalContentHash/],
      ["overlap", { ...artifacts, modelOutput: { ...valid, operations: [valid.operations[0], { ...valid.operations[0] }] } }, /overlap/],
      ["traversal", { ...artifacts, modelOutput: { ...valid, files: [{ path: "../outside.mjs", action: "MODIFY", originalContentHash: fixture.hash }], operations: [{ ...valid.operations[0], path: "../outside.mjs" }] } }, /safe repository-relative path/],
      ["line limit", { ...artifacts, modelOutput: { ...valid, operations: [{ ...valid.operations[0], replacement: "line one\nline two" }] }, policy: { maxChangedLines: 1 } }, /changed-line limit/],
      ["non-widenable line limit", { ...artifacts, modelOutput: { ...valid, operations: [{ ...valid.operations[0], replacement: Array.from({ length: 201 }, (_, index) => `line ${index}`).join("\n") }] }, policy: { maxChangedLines: 10_000 } }, /changed-line limit/],
      ["unpaired surrogate", { ...artifacts, modelOutput: { ...valid, operations: [{ ...valid.operations[0], replacement: "\ud800" }] } }, /UTF-8 text/],
    ];
    for (const [name, input, expected] of cases) {
      let error;
      try { createPatchProposal({ ...input, repositoryRoot: fixture.root }); } catch (caught) { error = caught; }
      expect(error, name).toBeInstanceOf(Error);
      expect(error.message, name).toMatch(expected);
    }
  });

  it("rejects denied, symlink, binary, unknown, and sensitive model output", () => {
    const denied = repositoryFixture({ path: "auth/session.mjs" });
    const deniedArtifacts = remediationArtifacts(denied);
    expect(() => createPatchProposal({ ...deniedArtifacts, modelOutput: modelProposal(deniedArtifacts), repositoryRoot: denied.root })).toThrow(/path is denied/);
    for (const path of ["src/auth.mjs", "config/production.env", ".envrc", "keys/id_rsa", "certs/client.p12", "infrastructure/main.mjs"]) {
      const sensitive = repositoryFixture({ path });
      const sensitiveArtifacts = remediationArtifacts(sensitive);
      expect(() => createPatchProposal({ ...sensitiveArtifacts, modelOutput: modelProposal(sensitiveArtifacts), repositoryRoot: sensitive.root }), path).toThrow(/path is denied/);
    }

    const linked = repositoryFixture({ path: "src/linked.mjs", symlink: true });
    const linkedArtifacts = remediationArtifacts(linked);
    expect(() => createPatchProposal({ ...linkedArtifacts, modelOutput: modelProposal(linkedArtifacts), repositoryRoot: linked.root })).toThrow(/symbolic link/);

    const binary = repositoryFixture({ path: "src/data.mjs", content: Buffer.from([0x61, 0, 0x62]) });
    const binaryArtifacts = remediationArtifacts(binary);
    expect(() => createPatchProposal({ ...binaryArtifacts, modelOutput: modelProposal(binaryArtifacts), repositoryRoot: binary.root })).toThrow(/binary/);

    const fixture = repositoryFixture();
    const artifacts = remediationArtifacts(fixture);
    const unknown = modelProposal(artifacts);
    unknown.files[0].path = "src/missing.mjs";
    unknown.operations[0].path = "src/missing.mjs";
    expect(() => createPatchProposal({ ...artifacts, modelOutput: unknown, repositoryRoot: fixture.root })).toThrow(/not bound to CodeContext/);
    expect(() => createPatchProposal({ ...artifacts, modelOutput: { ...modelProposal(artifacts), intent: "use ghp_abcdefghijklmnopqrstuvwxyz" }, repositoryRoot: fixture.root })).toThrow(/sensitive content/);
  });
});

function repositoryFixture({ path = "src/Dashboard.mjs", content = "export const title = 'Dashboard';\n", symlink = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qa-native-patch-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, path.split("/").slice(0, -1).join("/")), { recursive: true });
  if (symlink) symlinkSync("Dashboard.mjs", join(root, path));
  else writeFileSync(join(root, path), content);
  git(root, ["init", "-q"]);
  git(root, ["add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=QA", "-c", "user.email=qa@example.test", "commit", "-qm", "fixture"]);
  const revision = git(root, ["rev-parse", "HEAD"]);
  const blob = symlink ? Buffer.from("Dashboard.mjs") : Buffer.from(content);
  return { root, path, revision, hash: `sha256:${createHash("sha256").update(blob).digest("hex")}` };
}

function remediationArtifacts(fixture) {
  const diagnosis = {
    schemaVersion: FAILURE_DIAGNOSIS_VERSION,
    diagnosisId: "diagnosis-fixture",
    judgeResultId: "judge-fixture",
    origin: "PRODUCT_CODE",
    confidence: 0.7,
    symptom: "Dashboard title is missing",
    likelyCause: "The title differs",
    supportingEvidenceRefs: ["evidence-fixture"],
    contradictingEvidenceRefs: [],
    remediationEligible: true,
    manualReviewReasons: [],
  };
  const codeContext = {
    schemaVersion: CODE_CONTEXT_VERSION,
    bundleId: "code-context-fixture",
    repositoryId: "fixture",
    revision: fixture.revision,
    failureDiagnosisId: diagnosis.diagnosisId,
    candidates: [{ path: fixture.path, range: { start: { line: 1, column: 1 }, end: { line: 2, column: 1 } }, relevanceScore: 0.9, matchReasons: ["VISIBLE_TEXT_MATCH"] }],
    snippets: [{ path: fixture.path, range: { start: { line: 1, column: 1 }, end: { line: 2, column: 1 } }, text: "bounded source", contentHash: fixture.hash }],
    searchAudit: { queries: [{ term: "Dashboard", reason: "VISIBLE_TEXT_MATCH" }], strategies: ["PINNED_GIT_BLOB"] },
  };
  const recommendationBody = {
    schemaVersion: REPAIR_RECOMMENDATION_VERSION,
    diagnosisId: diagnosis.diagnosisId,
    repositoryRevision: fixture.revision,
    title: `Review ${fixture.path}`,
    severity: "MEDIUM",
    summary: diagnosis.symptom,
    rootCause: diagnosis.likelyCause,
    confidence: 0.7,
    locations: [{ path: fixture.path, range: codeContext.candidates[0].range, reason: "VISIBLE_TEXT_MATCH" }],
    changes: [{ path: fixture.path, recommendation: "Align the title", expectedEffect: "Title matches", risks: ["Review required"] }],
    verificationPlan: [{ command: "npm test", purpose: "Run regressions" }],
    evidenceRefs: diagnosis.supportingEvidenceRefs,
    codeContextRefs: [codeContext.bundleId],
    patchEligibility: "SUGGESTION_ONLY",
  };
  const recommendation = { ...recommendationBody, recommendationId: `recommendation-${canonicalHash(recommendationBody).slice(7, 23)}` };
  return { diagnosis, codeContext, recommendation };
}

function modelProposal({ diagnosis, codeContext, recommendation }) {
  const snippet = codeContext.snippets[0];
  return {
    schemaVersion: PATCH_PROPOSAL_VERSION,
    proposalId: "model-proposal",
    diagnosisId: diagnosis.diagnosisId,
    codeContextBundleId: codeContext.bundleId,
    repairRecommendationId: recommendation.recommendationId,
    baseRevision: codeContext.revision,
    intent: recommendation.changes[0].recommendation,
    expectedEffect: recommendation.changes[0].expectedEffect,
    risks: recommendation.changes[0].risks,
    files: [{ path: snippet.path, action: "MODIFY", originalContentHash: snippet.contentHash }],
    operations: [{ type: "REPLACE_RANGE", path: snippet.path, startLine: 1, endLine: 1, replacement: "export const title = 'Welcome Dashboard';" }],
    verificationPlan: recommendation.verificationPlan,
  };
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
