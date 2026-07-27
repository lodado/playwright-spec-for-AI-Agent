import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PATCH_APPLICATION_RESULT_VERSION, PATCH_PROPOSAL_VERSION, validateContract } from "../../contracts/index.mjs";
import { applyPatchProposal } from "../index.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("isolated PatchProposal application", () => {
  it("applies only inside a pinned private worktree and emits an audited result", () => {
    const fixture = repositoryFixture();
    const beforeContent = readFileSync(join(fixture.repository, fixture.path), "utf8");
    const beforeStatus = git(fixture.repository, ["status", "--porcelain=v1"]);
    const result = applyPatchProposal({ proposal: proposalFixture(fixture), repositoryRoot: fixture.repository, cwd: fixture.workspace });

    expect(validateContract("PatchApplicationResult", result)).toBe(result);
    expect(result).toMatchObject({ schemaVersion: PATCH_APPLICATION_RESULT_VERSION, status: "APPLIED", baseRevision: fixture.revision });
    expect(result.worktree.branch).toMatch(/^qa\/fix-[0-9a-f]{16}$/);
    expect(readFileSync(join(fixture.workspace, result.worktree.path, fixture.path), "utf8")).toBe("export const title = 'Welcome Dashboard';\n");
    expect(readFileSync(join(fixture.repository, fixture.path), "utf8")).toBe(beforeContent);
    expect(git(fixture.repository, ["status", "--porcelain=v1"])).toBe(beforeStatus);
    expect(git(fixture.workspace, ["-C", join(fixture.workspace, result.worktree.path), "diff", "--name-only"])).toBe(fixture.path);
  });

  it("returns PATCH_STALE and removes every partial worktree and branch", () => {
    const fixture = repositoryFixture();
    const proposal = proposalFixture(fixture);
    proposal.files[0].originalContentHash = `sha256:${"0".repeat(64)}`;
    const result = applyPatchProposal({ proposal, repositoryRoot: fixture.repository, cwd: fixture.workspace });

    expect(result.status).toBe("PATCH_STALE");
    expect(result.appliedFiles).toEqual([]);
    expect(existsSync(join(fixture.workspace, ".qa/worktrees/worktree-0000000000000000"))).toBe(false);
    expect(() => git(fixture.repository, ["show-ref", "--verify", "refs/heads/qa/fix-0000000000000000"])).toThrow();
  });

  it("rechecks forbidden paths and supports bounded CREATE_FILE without touching the primary index", () => {
    const fixture = repositoryFixture();
    const denied = proposalFixture(fixture);
    denied.files = [{ path: "auth/session.mjs", action: "CREATE" }];
    denied.operations = [{ type: "CREATE_FILE", path: "auth/session.mjs", content: "export {};\n" }];
    expect(applyPatchProposal({ proposal: denied, repositoryRoot: fixture.repository, cwd: fixture.workspace }).status).toBe("REJECTED");

    const created = proposalFixture(fixture);
    created.files.push({ path: "src/new.mjs", action: "CREATE" });
    created.operations.push({ type: "CREATE_FILE", path: "src/new.mjs", content: "export const added = true;\n" });
    const beforeIndex = git(fixture.repository, ["diff", "--cached"]);
    const result = applyPatchProposal({ proposal: created, repositoryRoot: fixture.repository, cwd: fixture.workspace });
    expect(result.status).toBe("APPLIED");
    expect(result.appliedFiles).toHaveLength(2);
    expect(readFileSync(join(fixture.workspace, result.worktree.path, "src/new.mjs"), "utf8")).toBe("export const added = true;\n");
    expect(git(fixture.repository, ["diff", "--cached"])).toBe(beforeIndex);
  });
});

function repositoryFixture() {
  const workspace = mkdtempSync(join(tmpdir(), "qa-native-apply-"));
  temporaryDirectories.push(workspace);
  const repository = join(workspace, "repository");
  const path = "src/Dashboard.mjs";
  mkdirSync(join(repository, "src"), { recursive: true });
  writeFileSync(join(repository, path), "export const title = 'Dashboard';\n");
  git(repository, ["init", "-q"]);
  git(repository, ["add", "."]);
  execFileSync("git", ["-C", repository, "-c", "user.name=QA", "-c", "user.email=qa@example.test", "commit", "-qm", "fixture"]);
  const revision = git(repository, ["rev-parse", "HEAD"]);
  const originalContentHash = hash(readFileSync(join(repository, path)));
  return { workspace, repository, path, revision, originalContentHash };
}

function proposalFixture(fixture) {
  return {
    schemaVersion: PATCH_PROPOSAL_VERSION,
    proposalId: "patch-proposal-0000000000000000",
    diagnosisId: "diagnosis-fixture",
    codeContextBundleId: "code-context-fixture",
    repairRecommendationId: "recommendation-fixture",
    baseRevision: fixture.revision,
    intent: "Fix the dashboard title",
    expectedEffect: "The dashboard expectation matches",
    risks: ["Human review required"],
    files: [{ path: fixture.path, action: "MODIFY", originalContentHash: fixture.originalContentHash }],
    operations: [{ type: "REPLACE_RANGE", path: fixture.path, startLine: 1, endLine: 1, replacement: "export const title = 'Welcome Dashboard';" }],
    verificationPlan: [{ command: "npm test", purpose: "Run regressions" }],
  };
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
