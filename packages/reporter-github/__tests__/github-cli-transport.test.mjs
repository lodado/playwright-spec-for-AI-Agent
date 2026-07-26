import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubCliIssueTransport } from "../index.mjs";

afterEach(() => vi.unstubAllEnvs());

describe("GitHub CLI Issue transport", () => {
  it("verifies the pinned revision and file hashes before creating an Issue", async () => {
    vi.stubEnv("QA_NATIVE_INTEGRITY_KEY", "integrity-secret");
    vi.stubEnv("APP_BROWSER_PASSWORD", "browser-secret");
    const revision = "a".repeat(40);
    const content = Buffer.from("export const dashboard = true;\n");
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from(`${revision}\n`) })
      .mockReturnValueOnce({ status: 0, stdout: content })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from("https://github.com/owner/example/issues/42\n") });
    const transport = createGitHubCliIssueTransport({ spawn });
    const files = [{ path: "src/Dashboard.jsx", contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}` }];

    expect(await transport.verifyCodeContext({ repository: "owner/example", revision, files })).toBe(true);
    expect(await transport.createIssue({ repository: "owner/example", title: "[QA] Dashboard", body: "## Failure", labels: ["qa-runtime"] })).toEqual({ number: 42, url: "https://github.com/owner/example/issues/42" });
    expect(spawn.mock.calls[1][1]).toContain("repos/owner/example/contents/src/Dashboard.jsx");
    expect(spawn.mock.calls[2][1]).toEqual(expect.arrayContaining(["issue", "create", "--label", "qa-runtime"]));
    expect(spawn.mock.calls[2][2].input).toBe("## Failure");
    expect(spawn.mock.calls[2][2].env).toMatchObject({ GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" });
    expect(spawn.mock.calls[2][2].env.QA_NATIVE_INTEGRITY_KEY).toBeUndefined();
    expect(spawn.mock.calls[2][2].env.APP_BROWSER_PASSWORD).toBeUndefined();
  });

  it("fails closed on content drift and CLI errors", async () => {
    const revision = "a".repeat(40);
    const drift = createGitHubCliIssueTransport({ spawn: vi.fn().mockReturnValueOnce({ status: 0, stdout: Buffer.from(revision) }).mockReturnValueOnce({ status: 0, stdout: Buffer.from("changed") }) });
    expect(await drift.verifyCodeContext({ repository: "owner/example", revision, files: [{ path: "src/a.js", contentHash: `sha256:${"b".repeat(64)}` }] })).toBe(false);

    const failed = createGitHubCliIssueTransport({ spawn: () => ({ status: 1, stdout: Buffer.from(""), stderr: Buffer.from("credential-secret") }) });
    await expect(failed.createIssue({ repository: "owner/example", title: "Failure", body: "Body", labels: ["qa-runtime"] })).rejects.toThrow("GitHub CLI request failed");
  });
});
