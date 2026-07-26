import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubCliIssueTransport } from "../index.mjs";

afterEach(() => vi.unstubAllEnvs());

describe("GitHub CLI Issue transport", () => {
  it("verifies the pinned revision and file hashes before creating an Issue", async () => {
    vi.stubEnv("QA_NATIVE_INTEGRITY_KEY", "integrity-secret");
    vi.stubEnv("QA_NATIVE_PUBLICATION_KEY", "publication-secret");
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
    expect(spawn.mock.calls[2][2].env.QA_NATIVE_PUBLICATION_KEY).toBeUndefined();
    expect(spawn.mock.calls[2][2].env.APP_BROWSER_PASSWORD).toBeUndefined();
  });

  it("fails closed on content drift and CLI errors", async () => {
    const revision = "a".repeat(40);
    const drift = createGitHubCliIssueTransport({ spawn: vi.fn().mockReturnValueOnce({ status: 0, stdout: Buffer.from(revision) }).mockReturnValueOnce({ status: 0, stdout: Buffer.from("changed") }) });
    expect(await drift.verifyCodeContext({ repository: "owner/example", revision, files: [{ path: "src/a.js", contentHash: `sha256:${"b".repeat(64)}` }] })).toBe(false);

    const failed = createGitHubCliIssueTransport({ spawn: () => ({ status: 1, stdout: Buffer.from(""), stderr: Buffer.from("credential-secret") }) });
    await expect(failed.createIssue({ repository: "owner/example", title: "Failure", body: "Body", labels: ["qa-runtime"] })).rejects.toThrow("GitHub CLI request failed");
  });

  it("finds exact open Issue and Draft PR markers through bounded reads", async () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const body = `Failure\n<!-- qa-fingerprint: ${fingerprint} -->\n`;
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from(JSON.stringify({ total_count: 2, items: [
        { number: 4, state: "open", html_url: "https://github.com/owner/example/issues/4" },
        { number: 5, state: "open", html_url: "https://github.com/owner/example/pull/5", pull_request: {} },
      ] })) })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from(JSON.stringify({ number: 4, state: "open", html_url: "https://github.com/owner/example/issues/4", body })) })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from(JSON.stringify({ number: 5, state: "open", draft: true, html_url: "https://github.com/owner/example/pull/5", body })) })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from(JSON.stringify([{ number: 4, state: "open", html_url: "https://github.com/owner/example/issues/4", body }])) })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from(JSON.stringify({ number: 4, state: "open", html_url: "https://github.com/owner/example/issues/4", body })) });
    const transport = createGitHubCliIssueTransport({ spawn });

    expect(await transport.findOpenPublications({ repository: "owner/example", fingerprint })).toEqual([
      { publication: "ISSUE", number: 4, url: "https://github.com/owner/example/issues/4", body },
      { publication: "DRAFT_PR", number: 5, url: "https://github.com/owner/example/pull/5", body },
    ]);
    expect(await transport.findRecentPublications({ repository: "owner/example", fingerprint, since: "2026-07-26T00:00:00.000Z" })).toEqual([
      { publication: "ISSUE", number: 4, url: "https://github.com/owner/example/issues/4", body },
    ]);
    expect(spawn.mock.calls[0][1].join(" ")).toContain("label:qa-runtime");
    expect(spawn.mock.calls[3][1]).toEqual(expect.arrayContaining(["repos/owner/example/issues", "labels=qa-runtime", "per_page=100"]));
  });

  it("lists and appends immutable occurrence comments", async () => {
    const body = "## QA occurrence\n\n<!-- qa-occurrence: c2lnbmVk -->";
    const created = { id: 123, html_url: "https://github.com/owner/example/issues/4#issuecomment-123", body, created_at: "2026-07-26T00:00:00.000Z" };
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from("qa-runtime-bot[bot]\n") })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from(JSON.stringify([created])) })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from(JSON.stringify(created)) });
    const transport = createGitHubCliIssueTransport({ spawn });
    const target = { repository: "owner/example", publication: "ISSUE", number: 4, url: "https://github.com/owner/example/issues/4" };

    expect(await transport.listOccurrenceRecords(target)).toEqual([created]);
    expect(await transport.createOccurrenceRecord({ ...target, body })).toEqual({ id: 123, url: created.html_url, body, createdAt: created.created_at });
    expect(spawn.mock.calls[1][1]).toEqual(expect.arrayContaining(["repos/owner/example/issues/4/comments", "--paginate", "--slurp"]));
    expect(spawn.mock.calls[1][1].join(" ")).toContain("qa-runtime-bot[bot]");
    expect(spawn.mock.calls[2][1]).toEqual(expect.arrayContaining(["--method", "POST", "--input", "-"]));
    expect(JSON.parse(spawn.mock.calls[2][2].input.toString())).toEqual({ body });
  });

  it("fails closed when recent publication reconciliation is not exhaustive", async () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const spawn = vi.fn().mockReturnValueOnce({ status: 0, stdout: Buffer.from(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })))) });
    const transport = createGitHubCliIssueTransport({ spawn });
    await expect(transport.findRecentPublications({ repository: "owner/example", fingerprint, since: "2026-07-26T00:00:00.000Z" })).rejects.toThrow(/ambiguous/);
  });
});
