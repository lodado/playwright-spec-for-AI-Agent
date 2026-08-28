import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));

vi.mock("../ai-agent-adapter.mjs", () => ({
  prepareAdapter: vi.fn(async () => ({ name: "fixture" })),
  runAgent: runAgentMock,
}));

import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { REVIEW_CRITERIA } from "../normalize-judge-review.mjs";
import { readLedger } from "../qa-run-ledger.mjs";
import { readRecordedSpecHash, run } from "../run-hermes-judge-review.mjs";

const SPEC_HASH = `sha256:${"a".repeat(64)}`;
const OTHER_HASH = `sha256:${"d".repeat(64)}`;

let outputDir: string;
let argv: string[];

function judgment(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    artifactKind: "judgment",
    runId: "run-abc12345",
    page: "dashboard",
    status: "fail",
    specHash: SPEC_HASH,
    summary: "Invoice label mismatch.",
    checks: [
      {
        item: "shows invoice template",
        result: "fail",
        detail: 'Title read "Invoice" at /billing.',
        cause: "PRODUCT_DEFECT",
        evidenceRefs: ["evidence/judge-1.png"],
      },
    ],
    coverage: { planned: 1, addressed: 1, missing: [] },
    evidence: ["Plan: Basic"],
    runnerEvidence: {
      tracePath: "evidence/trace.zip",
      harPath: null,
      videoPath: null,
      screenshots: ["evidence/judge-1.png"],
      ariaSnapshots: [],
      violations: [],
    },
    ...overrides,
  };
}

function agentPayload(query: string, verdicts: Record<string, string> = {}) {
  const packetSha256 = query.match(/sha256:[0-9a-f]{64}/)![0];
  return {
    packetSha256,
    overallReview: "approved",
    summary: "Judgment holds up.",
    criteria: REVIEW_CRITERIA.map(criterion => ({
      id: criterion.id,
      verdict: verdicts[criterion.id] ?? "pass",
      detail: `${criterion.id} ok`,
      affectedChecks: [],
      citations: ["evidence/judge-1.png"],
    })),
    recommendations: [],
    source: "fixture",
    agentMeta: { adapter: "fixture", model: null, durationMs: 3 },
  };
}

function writeArtifacts({
  judgePlan = null as string | null,
  specLive = null as string | null,
  decision = judgment(),
} = {}) {
  writeFileSync(
    join(outputDir, "dashboard-hermes-judgment.json"),
    JSON.stringify(decision, null, 2),
  );
  if (judgePlan !== null) {
    writeFileSync(join(outputDir, "dashboard-qa-judge-plan.md"), judgePlan);
  }
  if (specLive !== null) {
    writeFileSync(join(outputDir, "dashboard-qa-spec-live.md"), specLive);
  }
}

beforeEach(() => {
  resetProjectConfigForTests();
  runAgentMock.mockReset();
  outputDir = mkdtempSync(join(tmpdir(), "qa-review-"));
  argv = ["--page=dashboard", `--project-root=${outputDir}`, `--output-dir=${outputDir}`];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  resetProjectConfigForTests();
  vi.restoreAllMocks();
});

function readReview() {
  return JSON.parse(
    readFileSync(join(outputDir, "dashboard-hermes-judge-review.json"), "utf8"),
  );
}

function readPacket() {
  return readFileSync(
    join(outputDir, "dashboard-hermes-judge-review-packet.md"),
    "utf8",
  );
}

describe("readRecordedSpecHash", () => {
  it("reads the spec hash the judge stamped into its plan", () => {
    expect(readRecordedSpecHash(`- **Spec hash:** \`${SPEC_HASH}\``)).toBe(SPEC_HASH);
    expect(readRecordedSpecHash(`<!-- specHash: ${SPEC_HASH} -->`)).toBe(SPEC_HASH);
    expect(readRecordedSpecHash("# plan with no hash")).toBeNull();
  });
});

describe("review stage wiring", () => {
  it("reviews the judge plan, not the current spec-live plan", async () => {
    writeArtifacts({
      judgePlan: `- **Spec hash:** \`${SPEC_HASH}\`\n\n### 1. plan the judge used`,
      specLive: "### 1. plan rewritten after the run",
    });
    runAgentMock.mockImplementation((query: string) => agentPayload(query));

    await run(argv);

    const packet = readPacket();
    expect(packet).toContain("plan the judge used");
    expect(packet).not.toContain("plan rewritten after the run");
    expect(readReview().planSource).toBe("judge-plan");
  });

  it("falls back to spec-live and says so when the judge plan is missing", async () => {
    writeArtifacts({ specLive: "### 1. only plan on disk" });
    runAgentMock.mockImplementation((query: string) => agentPayload(query));

    await run(argv);

    expect(readReview().planSource).toBe("spec-live-fallback");
    expect(readPacket()).toContain("only plan on disk");
  });

  it("refuses to review across a spec revision", async () => {
    writeArtifacts({
      judgePlan: `- **Spec hash:** \`${OTHER_HASH}\`\n\n### 1. older plan`,
    });

    await expect(run(argv)).rejects.toThrow(/stale/);
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("writes the packet, the review artifact, and a ledger event", async () => {
    writeArtifacts({ judgePlan: `- **Spec hash:** \`${SPEC_HASH}\`\n\n### 1. plan` });
    runAgentMock.mockImplementation((query: string) => agentPayload(query));

    const exitCode = await run(argv);
    const review = readReview();

    expect(exitCode).toBeUndefined();
    expect(review.artifactKind).toBe("review");
    expect(review.reviewedRunId).toBe("run-abc12345");
    expect(review.packetSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(review.reviewedAt).toMatch(/^\d{4}-/);
    expect(review.agentMeta).toEqual({ adapter: "fixture", model: null, durationMs: 3 });
    expect(review.samples).toBe(1);
    expect(readPacket()).toContain(review.packetSha256);

    const events = readLedger(join(outputDir, "dashboard-qa-runs.jsonl"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "review",
      page: "dashboard",
      runId: "run-abc12345",
      overallReview: "approved",
    });
  });

  it("exits 1 on a flagged review", async () => {
    writeArtifacts({ judgePlan: "### 1. plan" });
    runAgentMock.mockImplementation((query: string) =>
      agentPayload(query, { "cause-correct": "fail" }),
    );

    await expect(run(argv)).resolves.toBe(1);
    expect(readReview().overallReview).toBe("flagged");
  });

  it("rejects a review that answers about a different packet", async () => {
    writeArtifacts({ judgePlan: "### 1. plan" });
    runAgentMock.mockImplementation((query: string) => ({
      ...agentPayload(query),
      packetSha256: OTHER_HASH,
    }));

    await expect(run(argv)).rejects.toThrow(/packetSha256/);
  });

  it("runs a panel of samples and reports disagreement", async () => {
    writeArtifacts({ judgePlan: "### 1. plan" });
    let call = 0;
    runAgentMock.mockImplementation((query: string) => {
      call += 1;
      return agentPayload(query, call === 2 ? { "cause-correct": "fail" } : {});
    });

    await expect(run([...argv, "--samples=3"])).resolves.toBe(1);
    const review = readReview();

    expect(runAgentMock).toHaveBeenCalledTimes(3);
    expect(review.samples).toBe(3);
    expect(review.unstable).toBe(true);
    expect(review.criteria.find((c: any) => c.id === "cause-correct")).toMatchObject({
      verdict: "pass",
      unstable: true,
    });
    expect(readLedger(join(outputDir, "dashboard-qa-runs.jsonl"))[0].unstable).toBe(true);
  });

  it("rejects an out-of-range --samples", async () => {
    writeArtifacts({ judgePlan: "### 1. plan" });
    await expect(run([...argv, "--samples=0"])).rejects.toThrow(/--samples/);
  });

  it("refuses to review a quarantined run", async () => {
    writeArtifacts({ judgePlan: "### 1. plan" });
    writeFileSync(
      join(outputDir, "dashboard-qa-run.invalid"),
      JSON.stringify({ reason: "judge crashed", at: "now" }),
    );

    await expect(run(argv)).rejects.toThrow(/quarantined/);
  });

  it("fails with a usable message when no plan exists at all", async () => {
    writeArtifacts({});
    await expect(run(argv)).rejects.toThrow(/qa-judge-plan\.md/);
  });
});
