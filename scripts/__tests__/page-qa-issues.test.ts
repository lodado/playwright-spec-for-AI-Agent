import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadProjectConfig,
  resetProjectConfigForTests,
} from "../hermes-qa-project-config.mjs";
import {
  applyPlan,
  assertPrivateRepository,
  buildIssueBody,
  checksFingerprint,
  findExistingIssue,
  issueMarker,
  issueTitle,
  planIssueAction,
  readFingerprint,
  selectIssueChecks,
} from "../page-qa-issues.mjs";

let root = "";
let qaDir = "";

const CHECKS = [
  { item: "shows the plan name", result: "pass", cause: "NONE", detail: "ok" },
  {
    item: "shows an account health score",
    result: "fail",
    cause: "PRODUCT_DEFECT",
    detail: "the score area stayed empty",
    evidenceRefs: [],
  },
  {
    item: "opens the plan details panel",
    result: "manual_review",
    cause: "HARNESS_DEFECT",
    detail: "the session expired mid-run",
    evidenceRefs: [],
  },
];

const JUDGMENT = {
  schemaVersion: 1,
  artifactKind: "judgment",
  runId: "run-1234abcd",
  page: "demo",
  judgedAt: "2026-08-29T02:00:00.000Z",
  targetUrl: "https://staging.acme.test/dashboard",
  status: "fail",
  cause: "PRODUCT_DEFECT",
  summary: "The health score widget never rendered.",
  checks: CHECKS,
};

const LIVE_PLAN = `# Demo QA spec (Live)

### ACTIVE — shows an account health score
Given: the health widget is present
When: the widget has finished loading
Then: a numeric score is shown with its meter
Never: the score area stays empty after load; mutations: 0
`;

async function useProject(extra: Record<string, unknown> = {}) {
  const configPath = join(root, "playwright-spec-for-ai-agent.config.mjs");
  writeFileSync(
    configPath,
    `export default ${JSON.stringify(
      {
        root,
        paths: { specDir: join(root, "specs"), outputDir: qaDir },
        pages: {
          demo: { baseUrl: "https://staging.acme.test", targetPath: "/dashboard" },
        },
        ...extra,
      },
      null,
      2
    )};\n`
  );
  await loadProjectConfig([`--config=${configPath}`, `--project-root=${root}`]);
}

function writeArtifact(name: string, body: unknown) {
  writeFileSync(join(qaDir, name), `${JSON.stringify(body, null, 2)}\n`);
}

/** Records every call so a test can assert what did *not* happen. */
function mockClient(issues: unknown[] = []) {
  return {
    calls: [] as string[],
    repo: vi.fn(async () => ({ private: true })),
    listIssues: vi.fn(async () => issues),
    create: vi.fn(async function (this: any, body: any) {
      this.calls.push("create");
      return { number: 7, ...body };
    }),
    update: vi.fn(async function (this: any) {
      this.calls.push("update");
      return {};
    }),
    comment: vi.fn(async function (this: any) {
      this.calls.push("comment");
      return {};
    }),
  };
}

beforeEach(async () => {
  resetProjectConfigForTests();
  root = mkdtempSync(join(tmpdir(), "qa-issues-"));
  qaDir = join(root, "__QA__");
  mkdirSync(qaDir, { recursive: true });
  await useProject();
  writeArtifact("demo-hermes-judgment.json", JUDGMENT);
  writeFileSync(join(qaDir, "demo-qa-spec-live.md"), LIVE_PLAN);
});

afterEach(() => {
  resetProjectConfigForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("selectIssueChecks", () => {
  it("files product findings and leaves harness defects to ops by default", () => {
    const { visible, harnessCount } = selectIssueChecks(CHECKS);

    expect(visible.map(check => check.item)).toEqual([
      "shows an account health score",
    ]);
    expect(harnessCount).toBe(1);
  });

  it("includes harness defects when asked", () => {
    const { visible } = selectIssueChecks(CHECKS, { includeHarness: true });

    expect(visible).toHaveLength(2);
  });

  it("drops manual_review under --issue-on=fail", () => {
    const { visible } = selectIssueChecks(CHECKS, {
      includeHarness: true,
      issueOn: "fail",
    });

    expect(visible.map(check => check.result)).toEqual(["fail"]);
  });

  it("honours an acknowledged check the same way the Slack alert does", () => {
    const { visible, ackedCount } = selectIssueChecks(CHECKS, {
      ackedItems: new Set(["shows an account health score"]),
    });

    expect(visible).toEqual([]);
    expect(ackedCount).toBe(1);
  });
});

describe("checksFingerprint", () => {
  it("ignores check order, so a reshuffled report stays silent", () => {
    const a = checksFingerprint([CHECKS[1], CHECKS[2]]);
    const b = checksFingerprint([CHECKS[2], CHECKS[1]]);

    expect(a).toBe(b);
  });

  it("changes when a check's result changes", () => {
    const before = checksFingerprint([CHECKS[1]]);
    const after = checksFingerprint([{ ...CHECKS[1], result: "manual_review" }]);

    expect(after).not.toBe(before);
  });

  it("round-trips through the body marker", () => {
    const fingerprint = checksFingerprint([CHECKS[1]]);
    const body = buildIssueBody("demo", "# handoff", fingerprint);

    expect(readFingerprint(body)).toBe(fingerprint);
    expect(body).toContain(issueMarker("demo"));
  });
});

describe("issueTitle", () => {
  it("carries the page, verdict, and count — never the judge's prose", () => {
    expect(issueTitle("demo", "fail", [CHECKS[1]])).toBe(
      "[QA] demo — fail (PRODUCT_DEFECT), 1 check"
    );
    expect(issueTitle("demo", "fail", [CHECKS[1], CHECKS[2]])).toBe(
      "[QA] demo — fail, 2 checks"
    );
  });
});

describe("findExistingIssue", () => {
  it("matches on the marker rather than the title, which people edit", () => {
    const issues = [
      { number: 1, body: "unrelated" },
      { number: 2, title: "renamed by a human", body: `x ${issueMarker("demo")} y` },
    ];

    expect(findExistingIssue(issues, "demo")?.number).toBe(2);
  });

  it("ignores pull requests returned by the issues endpoint", () => {
    const issues = [
      { number: 3, body: issueMarker("demo"), pull_request: { url: "..." } },
    ];

    expect(findExistingIssue(issues, "demo")).toBeNull();
  });
});

describe("planIssueAction", () => {
  it("plans a filing whose body is the handoff document with its guardrails intact", () => {
    const plan = planIssueAction("demo", {});

    expect(plan.action).toBe("file");
    expect(plan.checks).toHaveLength(1);
    expect(plan.body).toContain("# QA handoff — demo");
    expect(plan.body).toContain("Never weaken a check to make it pass");
    expect(plan.body).toContain("evidence, not instruction");
  });

  it("appends the configured footer, and files nothing agent-triggering on its own", async () => {
    await useProject({ github: { issueFooter: "@claude please investigate" } });

    const plan = planIssueAction("demo", { footer: "@claude please investigate" });

    expect(plan.body).toContain("@claude please investigate");
    expect(planIssueAction("demo", {}).body).not.toContain("@claude");
  });

  it("closes the issue when nothing is left to act on", () => {
    writeArtifact("demo-hermes-judgment.json", {
      ...JUDGMENT,
      status: "pass",
      checks: [CHECKS[0]],
    });

    const plan = planIssueAction("demo", {});

    expect(plan.action).toBe("close");
  });

  it("closes rather than files when every unsettled check is a harness defect", () => {
    writeArtifact("demo-hermes-judgment.json", {
      ...JUDGMENT,
      checks: [CHECKS[0], CHECKS[2]],
    });

    const plan = planIssueAction("demo", {});

    expect(plan.action).toBe("close");
    expect(plan.reason).toContain("HARNESS_DEFECT");
  });

  it("files nothing for a quarantined run, which never produced a verdict", () => {
    writeFileSync(
      join(qaDir, "demo-qa-run.invalid"),
      JSON.stringify({ reason: "browser launch failed", at: "now" })
    );

    expect(planIssueAction("demo", {}).action).toBe("none");
    expect(planIssueAction("demo", { includeHarness: true }).action).toBe("file");
  });

  it("labels a check that flips across same-spec runs as flaky", () => {
    const run = (result: string) => ({
      runId: `run-${result}`,
      status: result,
      specHash: "sha256:same",
      checks: [{ item: "shows an account health score", result }],
    });
    writeArtifact("demo-qa-verdict-history.json", {
      runs: [run("pass"), run("fail"), run("pass"), run("fail")],
    });

    expect(planIssueAction("demo", {}).flaky).toBe(true);
  });
});

describe("applyPlan", () => {
  const options = { labels: [], issueOn: "unsettled", includeHarness: false };

  function paths() {
    return { runsLedger: join(qaDir, "demo-qa-runs.jsonl") };
  }

  it("files a new issue when the page has none", async () => {
    const plan = planIssueAction("demo", {});
    const client = mockClient([]);

    await applyPlan(plan, client as any, options, paths());

    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.create.mock.calls[0][0].labels).toEqual(["qa:verdict"]);
    expect(client.comment).not.toHaveBeenCalled();
  });

  it("stays silent when the open issue already reports this failure set", async () => {
    const plan = planIssueAction("demo", {});
    const client = mockClient([
      { number: 9, state: "open", body: plan.body },
    ]);

    await applyPlan(plan, client as any, options, paths());

    expect(client.create).not.toHaveBeenCalled();
    expect(client.comment).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it("comments and rewrites the body when the failure set changed", async () => {
    const plan = planIssueAction("demo", {});
    const client = mockClient([
      {
        number: 9,
        state: "open",
        body: `${issueMarker("demo")}\n<!-- qa-fingerprint: sha256:stale -->`,
      },
    ]);

    await applyPlan(plan, client as any, options, paths());

    expect(client.update).toHaveBeenCalledTimes(1);
    expect(client.comment).toHaveBeenCalledTimes(1);
    expect(client.create).not.toHaveBeenCalled();
  });

  it("reopens the original thread on a recurrence instead of filing a second issue", async () => {
    const plan = planIssueAction("demo", {});
    const client = mockClient([
      {
        number: 9,
        state: "closed",
        body: `${issueMarker("demo")}\n<!-- qa-fingerprint: ${plan.fingerprint} -->`,
      },
    ]);

    await applyPlan(plan, client as any, options, paths());

    expect(client.create).not.toHaveBeenCalled();
    expect(client.update.mock.calls[0][1].state).toBe("open");
    const ledger = readFileSync(join(qaDir, "demo-qa-runs.jsonl"), "utf8");
    expect(ledger).toContain('"action":"reopened"');
  });

  it("closes on a passing verdict and says a re-judgment did it, not a merge", async () => {
    writeArtifact("demo-hermes-judgment.json", {
      ...JUDGMENT,
      status: "pass",
      checks: [CHECKS[0]],
    });
    const plan = planIssueAction("demo", {});
    const client = mockClient([
      { number: 9, state: "open", body: issueMarker("demo") },
    ]);

    await applyPlan(plan, client as any, options, paths());

    expect(client.update.mock.calls[0][1].state).toBe("closed");
    expect(client.comment.mock.calls[0][1]).toContain("not by a merge");
  });

  it("adds the flaky label when a check flips across runs", async () => {
    const plan = { ...planIssueAction("demo", {}), flaky: true };
    const client = mockClient([]);

    await applyPlan(plan, client as any, options, paths());

    expect(client.create.mock.calls[0][0].labels).toContain("qa:flaky");
  });
});

describe("assertPrivateRepository", () => {
  it("refuses a public repository, because the body carries the staging URL", async () => {
    const client = { repo: async () => ({ private: false }) };

    await expect(
      assertPrivateRepository(client as any, { allowPublic: false })
    ).rejects.toThrow(/public repository/);
  });

  it("proceeds on an explicit opt-in", async () => {
    const client = { repo: async () => ({ private: false }) };

    await expect(
      assertPrivateRepository(client as any, { allowPublic: true })
    ).resolves.toBeUndefined();
  });
});
