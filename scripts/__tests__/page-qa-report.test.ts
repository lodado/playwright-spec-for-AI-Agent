import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_USAGE, formatQaError } from "../errors.mjs";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { readLedger } from "../qa-run-ledger.mjs";
import {
  collectPageReport,
  isFailing,
  renderMarkdown,
  run as runReport,
  staleness,
} from "../page-qa-report.mjs";
import {
  DEFAULT_ACK_DAYS,
  readAckFile,
  run as runAck,
  upsertAck,
} from "../page-qa-ack.mjs";

let root: string;
let stdout: string;

const ARGS = () => [`--project-root=${root}`, "--output-dir={root}/qa/{page}"];

function outputDir(page: string) {
  const dir = join(root, "qa", page);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJudgment(page: string, judgment: Record<string, unknown>) {
  writeFileSync(
    join(outputDir(page), `${page}-hermes-judgment.json`),
    JSON.stringify({ artifactKind: "judgment", page, ...judgment })
  );
}

function judgment(overrides: Record<string, unknown> = {}) {
  return {
    status: "fail",
    cause: "PRODUCT_DEFECT",
    runId: "run-abc12345",
    judgedAt: "2026-08-28T00:00:00.000Z",
    agentMeta: { adapter: "hermes", model: "opus", durationMs: 1000 },
    coverage: { planned: 4, addressed: 3, missing: ["renders footer"] },
    checks: [
      { item: "renders plan card", result: "pass", detail: "ok" },
      { item: "renders invoices", result: "fail", detail: "empty table" },
      { item: "shows renewal date", result: "manual_review", detail: "ambiguous" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  resetProjectConfigForTests();
  root = mkdtempSync(join(tmpdir(), "qa-report-"));
  writeFileSync(
    join(root, "playwright-spec-for-ai-agent.config.mjs"),
    `export default {
      pages: {
        dashboard: { targetPath: "/dashboard" },
        pricing: { targetPath: "/pricing" },
      },
    };`
  );
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GITHUB_STEP_SUMMARY;
  resetProjectConfigForTests();
});

describe("collectPageReport", () => {
  it("summarises a judged page", async () => {
    await runReport([...ARGS(), "--pages=dashboard", "--fail-on=never"]);
    writeJudgment("dashboard", judgment());

    const row = collectPageReport("dashboard", new Date("2026-08-29T00:00:00.000Z"));

    expect(row.status).toBe("fail");
    expect(row.cause).toBe("PRODUCT_DEFECT");
    expect(row.checks).toMatchObject({ pass: 1, fail: 1, manual_review: 1, total: 3 });
    expect(row.coverage).toEqual({ planned: 4, addressed: 3, missing: 1 });
    expect(row.adapter).toBe("hermes");
    expect(row.runId).toBe("run-abc12345");
    expect(row.ageLabel).toBe("24h");
  });

  it("reports a page with no artifacts as not run instead of crashing", async () => {
    await runReport([...ARGS(), "--pages=pricing", "--fail-on=never"]);

    const row = collectPageReport("pricing");

    expect(row.status).toBe("not run");
    expect(row.checks.total).toBe(0);
    expect(row.runId).toBe(null);
    expect(row.ageLabel).toBe("—");
  });

  it("reports a quarantined run as quarantined, never as a pass", async () => {
    await runReport([...ARGS(), "--pages=dashboard", "--fail-on=never"]);
    writeJudgment("dashboard", judgment({ status: "pass" }));
    writeFileSync(
      join(outputDir("dashboard"), "dashboard-qa-run.invalid"),
      JSON.stringify({ reason: "hermes crashed", at: "2026-08-28T02:00:00.000Z" })
    );

    expect(collectPageReport("dashboard").status).toBe("quarantined");
  });

  it("labels ages under two days in hours and beyond that in days", () => {
    const now = new Date("2026-08-29T00:00:00.000Z");
    expect(staleness("2026-08-28T20:00:00.000Z", now).label).toBe("4h");
    expect(staleness("2026-08-24T00:00:00.000Z", now).label).toBe("5d");
    expect(staleness(undefined, now).label).toBe("—");
  });
});

describe("report rendering", () => {
  it("renders a markdown table over every configured page", async () => {
    writeJudgment("dashboard", judgment());
    writeJudgment("pricing", judgment({ status: "pass", cause: "NONE", checks: [] }));

    const code = await runReport([...ARGS(), "--fail-on=never"]);

    expect(code).toBe(0);
    expect(stdout).toContain("| dashboard | fail | PRODUCT_DEFECT | 1/1/1 |");
    expect(stdout).toContain("| pricing | pass |");
    expect(stdout).toContain("hermes (opus)");
    expect(stdout).toContain("3/4 (1 missing)");
  });

  it("renders json and writes it to --out", async () => {
    writeJudgment("dashboard", judgment());
    const out = join(root, "report.json");

    await runReport([
      ...ARGS(),
      "--pages=dashboard",
      "--format=json",
      `--out=${out}`,
      "--fail-on=never",
    ]);

    const parsed = JSON.parse(readFileSync(out, "utf8"));
    expect(parsed.pages[0]).toMatchObject({ page: "dashboard", status: "fail" });
    expect(JSON.parse(stdout).pages).toHaveLength(1);
  });

  it("appends to GITHUB_STEP_SUMMARY when set", async () => {
    writeJudgment("dashboard", judgment());
    const summary = join(root, "summary.md");
    process.env.GITHUB_STEP_SUMMARY = summary;

    await runReport([...ARGS(), "--pages=dashboard", "--format=json", "--fail-on=never"]);

    expect(readFileSync(summary, "utf8")).toContain("| dashboard | fail |");
  });

  it("rejects an unknown format", async () => {
    await expect(runReport([...ARGS(), "--format=yaml"])).rejects.toThrow(
      /Unknown --format=yaml/
    );
  });

  it("renders a table even when nothing has ever run", () => {
    const table = renderMarkdown([
      collectPageReportStub("dashboard"),
      collectPageReportStub("pricing"),
    ]);
    expect(table).toContain("| dashboard | not run |");
  });
});

function collectPageReportStub(page: string) {
  return {
    page,
    status: "not run",
    cause: "—",
    checks: { pass: 0, fail: 0, manual_review: 0, skip: 0, total: 0 },
    coverage: { planned: 0, addressed: 0, missing: 0 },
    adapter: "—",
    model: "",
    judgedAt: null,
    runId: null,
    ageLabel: "—",
    quarantined: false,
    review: null,
    lastEvent: null,
  };
}

describe("report exit codes", () => {
  it("exits non-zero when a page failed", async () => {
    writeJudgment("dashboard", judgment());
    writeJudgment("pricing", judgment({ status: "pass" }));

    expect(await runReport([...ARGS()])).toBe(1);
  });

  it("stays green on manual_review under the default --fail-on=fail", async () => {
    writeJudgment("dashboard", judgment({ status: "manual_review" }));
    writeJudgment("pricing", judgment({ status: "pass" }));

    expect(await runReport([...ARGS()])).toBe(0);
    resetProjectConfigForTests();
    expect(await runReport([...ARGS(), "--fail-on=manual_review"])).toBe(1);
  });

  it("reports a quarantined page as an environment failure", async () => {
    writeJudgment("dashboard", judgment({ status: "pass" }));
    writeFileSync(
      join(outputDir("dashboard"), "dashboard-qa-run.invalid"),
      JSON.stringify({ reason: "crash" })
    );
    writeJudgment("pricing", judgment({ status: "pass" }));

    expect(await runReport([...ARGS()])).toBe(3);
  });

  it("is green when every page passed", async () => {
    writeJudgment("dashboard", judgment({ status: "pass" }));
    writeJudgment("pricing", judgment({ status: "pass" }));

    expect(await runReport([...ARGS()])).toBe(0);
  });

  it("honours --fail-on=never", () => {
    expect(isFailing({ status: "fail" } as any, "never")).toBe(false);
    expect(isFailing({ status: "not run" } as any, "fail")).toBe(false);
    expect(isFailing({ status: "not run" } as any, "manual_review")).toBe(true);
  });
});

describe("ack", () => {
  const ITEM = "shows renewal date";

  beforeEach(() => {
    writeJudgment("dashboard", judgment({ status: "manual_review" }));
  });

  function ackPath() {
    return join(root, "qa", "dashboard", "dashboard-qa-ack.json");
  }

  it("writes an ack the Slack stage can read, with a default expiry", async () => {
    const now = new Date("2026-08-28T00:00:00.000Z");

    const code = await runAck(
      [...ARGS(), "--page=dashboard", `--item=${ITEM}`, "--reason=tracked in ACME-12", "--by=lee"],
      { now }
    );

    expect(code).toBe(0);
    const file = readAckFile(ackPath());
    expect(file.acks).toEqual([
      {
        item: ITEM,
        reason: "tracked in ACME-12",
        by: "lee",
        until: new Date(now.getTime() + DEFAULT_ACK_DAYS * 86_400_000).toISOString(),
        at: now.toISOString(),
      },
    ]);
    expect(readLedger(join(root, "qa", "dashboard", "dashboard-qa-runs.jsonl"))).toMatchObject([
      { kind: "ack", action: "add", item: ITEM },
    ]);
  });

  it("honours an explicit --until and re-acking replaces rather than duplicates", async () => {
    await runAck([...ARGS(), "--page=dashboard", `--item=${ITEM}`, "--reason=first", "--until=2026-09-01"]);
    resetProjectConfigForTests();
    await runAck([...ARGS(), "--page=dashboard", `--item=${ITEM}`, "--reason=second", "--until=2026-10-01"]);

    const { acks } = readAckFile(ackPath());
    expect(acks).toHaveLength(1);
    expect(acks[0].reason).toBe("second");
    expect(acks[0].until).toBe("2026-10-01T00:00:00.000Z");
  });

  it("refuses an item that is not in the latest judgment, listing the real ones", async () => {
    await expect(
      runAck([...ARGS(), "--page=dashboard", "--item=shows renewal dat", "--reason=typo"])
    ).rejects.toThrow(/is not a check in the latest judgment/);
    expect(existsSync(ackPath())).toBe(false);

    resetProjectConfigForTests();
    const error = await runAck([
      ...ARGS(),
      "--page=dashboard",
      "--item=nope",
      "--reason=x",
    ]).catch((thrown: any) => thrown);
    expect(formatQaError(error)).toContain("- shows renewal date");
    expect(error.exitCode).toBe(EXIT_USAGE);
  });

  it("refuses an ack with no reason and an unparseable --until", async () => {
    await expect(
      runAck([...ARGS(), "--page=dashboard", `--item=${ITEM}`])
    ).rejects.toThrow(/Missing --reason=/);
    resetProjectConfigForTests();
    await expect(
      runAck([...ARGS(), "--page=dashboard", `--item=${ITEM}`, "--reason=x", "--until=soon"])
    ).rejects.toThrow(/Unparseable --until/);
  });

  it("lists acks and marks expired ones", async () => {
    await runAck(
      [...ARGS(), "--page=dashboard", `--item=${ITEM}`, "--reason=known", "--until=2026-01-01"],
      { now: new Date("2025-12-01T00:00:00.000Z") }
    );
    resetProjectConfigForTests();
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message: any) => {
      logged.push(String(message));
    });

    expect(await runAck([...ARGS(), "--page=dashboard", "--list"], {
      now: new Date("2026-08-28T00:00:00.000Z"),
    })).toBe(0);
    expect(logged.join("\n")).toContain(`${ITEM} (EXPIRED)`);
  });

  it("removes an ack and refuses to remove one that is not there", async () => {
    await runAck([...ARGS(), "--page=dashboard", `--item=${ITEM}`, "--reason=known"]);
    resetProjectConfigForTests();

    expect(await runAck([...ARGS(), "--page=dashboard", `--remove=${ITEM}`])).toBe(0);
    expect(readAckFile(ackPath()).acks).toEqual([]);

    resetProjectConfigForTests();
    await expect(
      runAck([...ARGS(), "--page=dashboard", "--remove=ghost"])
    ).rejects.toThrow(/No ack for "ghost"/);
  });

  it("refuses to ack a page that has never been judged", async () => {
    await expect(
      runAck([...ARGS(), "--page=pricing", "--item=whatever", "--reason=x"])
    ).rejects.toThrow(/No judgment for this page yet/);
  });

  it("prints its own --help and requires --page otherwise", async () => {
    expect(await runAck(["--help"])).toBe(0);
    await expect(runAck(ARGS())).rejects.toThrow(/Missing --page=/);
  });

  it("upsertAck replaces by item", () => {
    expect(upsertAck([{ item: "a", reason: "old" }], { item: "a", reason: "new" })).toEqual([
      { item: "a", reason: "new" },
    ]);
  });
});
