import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PATCH_PROPOSAL_VERSION, VERIFICATION_RESULT_VERSION, validateContract } from "../../contracts/index.mjs";
import { applyPatchProposal, verifyAppliedPatch } from "../index.mjs";

const temporaryDirectories = [];
const stages = ["format", "lint", "typecheck", "unit", "playwright"];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("deterministic isolated patch verification", () => {
  it("runs only trusted configured checks with bounded redacted output", () => {
    const fixture = appliedFixture();
    const calls = [];
    const { result, outputs } = verifyAppliedPatch({
      ...fixture,
      config: verificationConfig(),
      secrets: ["super-secret"],
      platform: "darwin",
      isolate: testIsolation,
      spawn(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0, signal: null, stdout: Buffer.from("ok super-secret"), stderr: Buffer.alloc(0) };
      },
    });

    expect(validateContract("VerificationResult", result, fixture)).toBe(result);
    expect(result).toMatchObject({ schemaVersion: VERIFICATION_RESULT_VERSION, status: "PASS" });
    expect(calls).toHaveLength(5);
    expect(calls[0].command).toBe("/usr/bin/sandbox-exec");
    expect(calls[0].args).toContain("(version 1)(allow default)(deny network*)");
    expect(calls[0].options.shell).toBe(false);
    expect(calls[0].options.env).not.toHaveProperty("QA_NATIVE_INTEGRITY_KEY");
    expect(calls[0].options.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(calls[0].options.env.npm_config_offline).toBe("true");
    expect(outputs.map((item) => item.content).join("\n")).not.toContain("super-secret");
    expect(outputs.map((item) => item.content).join("\n")).toContain("[REDACTED]");
  });

  it("fails closed for missing, failed, timed-out, and oversized required checks", () => {
    const missing = appliedFixture();
    expect(verifyAppliedPatch({ ...missing, config: {}, platform: "darwin", isolate: testIsolation, spawn: () => { throw new Error("must not run"); } }).result.status).toBe("MANUAL_REVIEW");

    for (const [name, response, expected] of [
      ["failed", { status: 2, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from("failed") }, "FAILED"],
      ["timeout", { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" }, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, "FAILED"],
      ["oversized", { status: 0, signal: null, stdout: Buffer.alloc(128, 97), stderr: Buffer.alloc(0) }, "ERROR"],
    ]) {
      const fixture = appliedFixture();
      const result = verifyAppliedPatch({ ...fixture, config: verificationConfig({ maxOutputBytes: 32 }), platform: "darwin", isolate: testIsolation, spawn: () => response }).result;
      expect(result.status, name).toBe(expected);
      expect(result.checks.slice(1).every((check) => check.status === "SKIPPED"), name).toBe(true);
    }
  });

  it("rejects a check that mutates the applied diff", () => {
    const fixture = appliedFixture();
    let calls = 0;
    const { result } = verifyAppliedPatch({
      ...fixture,
      config: verificationConfig(),
      platform: "darwin",
      isolate: testIsolation,
      spawn(_command, _args, options) {
        calls += 1;
        if (calls === stages.length) writeFileSync(join(options.cwd, "unexpected.txt"), "mutation");
        return { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
    expect(result.status).toBe("ERROR");
    expect(result.reason).toMatch(/changed the isolated patch/);
  });
});

function verificationConfig(overrides = {}) {
  return {
    checks: Object.fromEntries(stages.map((name) => [name, { command: "node", args: ["--version"] }])),
    ...overrides,
  };
}

function testIsolation(definition) {
  return { command: "/usr/bin/sandbox-exec", args: ["-p", "(version 1)(allow default)(deny network*)", definition.command, ...definition.args] };
}

function appliedFixture() {
  const workspace = mkdtempSync(join(tmpdir(), "qa-native-verify-fixture-"));
  temporaryDirectories.push(workspace);
  const repository = join(workspace, "repository");
  const path = "src/value.mjs";
  mkdirSync(join(repository, "src"), { recursive: true });
  writeFileSync(join(repository, path), "export const value = 1;\n");
  git(repository, ["init", "-q"]);
  git(repository, ["add", "."]);
  execFileSync("git", ["-C", repository, "-c", "user.name=QA", "-c", "user.email=qa@example.test", "commit", "-qm", "fixture"]);
  const revision = git(repository, ["rev-parse", "HEAD"]);
  const proposal = {
    schemaVersion: PATCH_PROPOSAL_VERSION,
    proposalId: `patch-proposal-${createHash("sha256").update(workspace).digest("hex").slice(0, 16)}`,
    diagnosisId: "diagnosis-fixture",
    codeContextBundleId: "code-context-fixture",
    repairRecommendationId: "recommendation-fixture",
    baseRevision: revision,
    intent: "Fix value",
    expectedEffect: "Value matches",
    risks: ["Review required"],
    files: [{ path, action: "MODIFY", originalContentHash: hash(readFileSync(join(repository, path))) }],
    operations: [{ type: "REPLACE_RANGE", path, startLine: 1, endLine: 1, replacement: "export const value = 2;" }],
    verificationPlan: [{ command: "npm test", purpose: "Run tests" }],
  };
  const application = applyPatchProposal({ proposal, repositoryRoot: repository, cwd: workspace });
  expect(application.status).toBe("APPLIED");
  return { proposal, application, cwd: workspace };
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
