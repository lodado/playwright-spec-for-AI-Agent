import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubCliDraftTransport, createGitHubCliIssueTransport } from "../index.mjs";

const temporaryDirectories = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("GitHub CLI Issue transport", () => {
  it("verifies the pinned revision and file hashes before creating an Issue", async () => {
    vi.stubEnv("QA_NATIVE_INTEGRITY_KEY", "integrity-secret");
    vi.stubEnv("QA_NATIVE_PUBLICATION_KEY", "publication-secret");
    vi.stubEnv("APP_BROWSER_PASSWORD", "browser-secret");
    const revision = "a".repeat(40);
    const content = Buffer.from("export const dashboard = true;\n");
    const spawn = vi.fn((command, args) => {
      if (args[0] === "label") return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("already exists") };
      if (args[0] === "issue") return { status: 0, stdout: Buffer.from("https://github.com/owner/example/issues/42\n") };
      if (args.some((value) => String(value).includes("/contents/"))) return { status: 0, stdout: content };
      return { status: 0, stdout: Buffer.from(`${revision}\n`) };
    });
    const transport = createGitHubCliIssueTransport({ spawn });
    const files = [{ path: "src/Dashboard.jsx", contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}` }];

    expect(await transport.verifyCodeContext({ repository: "owner/example", revision, files })).toBe(true);
    expect(await transport.createIssue({ repository: "owner/example", title: "[QA] Dashboard", body: "## Failure", labels: ["qa-runtime", "scenario:dashboard"] })).toEqual({ number: 42, url: "https://github.com/owner/example/issues/42" });
    // Labels are ensured idempotently before the issue call — a pre-existing label (non-zero
    // exit) must not fail the publication.
    const labelCalls = spawn.mock.calls.filter(([, args]) => args[0] === "label");
    expect(labelCalls.map(([, args]) => args[2])).toEqual(["qa-runtime", "scenario:dashboard"]);
    const issueCall = spawn.mock.calls.find(([, args]) => args[0] === "issue");
    expect(issueCall[1]).toEqual(expect.arrayContaining(["issue", "create", "--label", "qa-runtime", "--label", "scenario:dashboard"]));
    // Node 24 rejects string input combined with encoding:"buffer" (ERR_UNKNOWN_ENCODING) —
    // payloads must reach spawnSync as buffers.
    expect(issueCall[2].input).toEqual(Buffer.from("## Failure", "utf8"));
    expect(issueCall[2].env).toMatchObject({ GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" });
    expect(issueCall[2].env.QA_NATIVE_INTEGRITY_KEY).toBeUndefined();
    expect(issueCall[2].env.QA_NATIVE_PUBLICATION_KEY).toBeUndefined();
    expect(issueCall[2].env.APP_BROWSER_PASSWORD).toBeUndefined();
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

  it("commits bounded files and creates only a human-reviewable Draft PR", async () => {
    vi.stubEnv("QA_NATIVE_INTEGRITY_KEY", "integrity-secret");
    vi.stubEnv("GITHUB_TOKEN", "github-token");
    const worktreePath = mkdtempSync(join(tmpdir(), "qa-native-draft-"));
    temporaryDirectories.push(worktreePath);
    const revision = "a".repeat(40);
    const diff = Buffer.from("diff --git a/src/fix.mjs b/src/fix.mjs\n");
    const expectedDiffHash = `sha256:${createHash("sha256").update(diff).digest("hex")}`;
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from(revision) })
      .mockReturnValueOnce({ status: 0, stdout: diff })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from("src/fix.mjs\n") })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from("src/fix.mjs\n") })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from("committed\n") })
      .mockReturnValueOnce({ status: 0, stdout: diff })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from("src/fix.mjs\n") })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from("pushed\n") })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from("main\n") })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from("https://github.com/owner/example/pull/42\n") });
    const transport = createGitHubCliDraftTransport({ spawn });
    const decision = { eligibleDraft: true, branch: "qa/fix-abcdef", baseRevision: revision, source: { proposalId: "patch-proposal-abcdef" } };

    expect(await transport.publishDraft({ action: "CREATE_DRAFT_PR", repository: "owner/example", decision, worktreePath, files: ["src/fix.mjs"], expectedDiffHash, title: "Verified fix", body: "## Verified", labels: ["qa-generated", "needs-human-review"] })).toEqual({ number: 42, url: "https://github.com/owner/example/pull/42" });
    expect(spawn.mock.calls[11][1]).toEqual(expect.arrayContaining(["pr", "create", "--draft", "--head", "qa/fix-abcdef"]));
    expect(spawn.mock.calls.flatMap((call) => call[1])).not.toContain("merge");
    expect(spawn.mock.calls[5][2].env.QA_NATIVE_INTEGRITY_KEY).toBeUndefined();
    expect(spawn.mock.calls[11][2].env.GITHUB_TOKEN).toBe("github-token");
  });

  it("rejects a changed committed diff before retrying a Draft PR push", async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "qa-native-draft-retry-"));
    temporaryDirectories.push(worktreePath);
    const revision = "a".repeat(40);
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from("b".repeat(40)) })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from("changed diff") })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from("src/fix.mjs\n") });
    const transport = createGitHubCliDraftTransport({ spawn });
    const decision = { eligibleDraft: true, branch: "qa/fix-abcdef", baseRevision: revision, source: { proposalId: "patch-proposal-abcdef" } };

    await expect(transport.publishDraft({ action: "CREATE_DRAFT_PR", repository: "owner/example", decision, worktreePath, files: ["src/fix.mjs"], expectedDiffHash: `sha256:${"f".repeat(64)}`, title: "Verified fix", body: "## Verified", labels: [] })).rejects.toThrow("diff does not match");
    expect(spawn.mock.calls.flatMap((call) => call[1])).not.toContain("push");
  });
});
