import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildBrowseChecklist, SPEC_READER_VERSION } from "../spec-annotation-reader.mjs";
import * as specHashes from "../spec-hash.mjs";
import { hashSpecSources } from "../qa-spec-artifacts.mjs";
import { buildBrowseHermesQuery } from "../run-hermes-page-judge.mjs";
import { buildJudgeReviewHermesQuery } from "../run-hermes-judge-review.mjs";
import { buildJudgeBrowseDocument } from "../qa-spec-judge-document.mjs";
import { runFixture } from "../fixture-runner.mjs";
import { AgentOutputError } from "../errors.mjs";
import { buildCoverage, buildEvidenceManifest, normalizeBrowseDecision } from "../judge-verdict.mjs";
import { findUncitedChecks, normalizeJudgeReview, REVIEW_CRITERIA } from "../normalize-judge-review.mjs";

const dir = mkdtempSync(join(tmpdir(), "qa-check-identity-"));
const snapshot = join(dir, "capture.yaml");
writeFileSync(snapshot, '- text: 98 pts\n');
const runnerEvidence = { ariaSnapshots: [snapshot] };
const plan = [
  { checkId: "active/score", item: "shows score" },
  { checkId: "inactive/score", item: "shows score" },
];
const checks = plan.map(check => ({ ...check, result: "pass", detail: 'Observed "98 pts"' }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("stable check identity", () => {
  it("uses source file, scenario and source check ID without changing source IDs", () => {
    const spec = { scenarios: ["one.spec.ts", "two.spec.ts"].flatMap(sourceFile =>
      ["ACTIVE", "INACTIVE"].map(scenarioId => ({ sourceFile, scenarioId,
        tests: [{ title: "same title", checkId: "same-title" }],
      })),
    ) };
    const ids = buildBrowseChecklist(spec).map(check => check.checkId);
    expect(new Set(ids).size).toBe(4);
    expect(buildBrowseChecklist({ scenarios: [...spec.scenarios].reverse() }).map(check => check.checkId))
      .toEqual([...ids].reverse());
    expect(spec.scenarios[0].tests[0].checkId).toBe("same-title");
  });

  it("emits a pinned short ASCII ID without mutating the source identity", () => {
    const spec = { scenarios: [{
      sourceFile: "one.spec.ts", scenarioId: "ACTIVE",
      tests: [{ title: "same title", checkId: "same-title" }],
    }] };
    const before = JSON.stringify(spec);
    expect(buildBrowseChecklist(spec)[0].checkId).toBe("chk_601fcd3083069661");
    expect(buildBrowseChecklist(JSON.parse(before))[0].checkId).toBe("chk_601fcd3083069661");
    expect(JSON.stringify(spec)).toBe(before);
  });

  it("keeps IDs stable across insertion, reordering, and display-title changes", () => {
    const scenario = { sourceFile: "one.spec.ts", scenarioId: "ACTIVE" };
    const tests = [
      { title: "first title", checkId: "first" },
      { title: "second title", checkId: "second" },
    ];
    const original = buildBrowseChecklist({ scenarios: [{ ...scenario, tests }] });
    const changed = buildBrowseChecklist({ scenarios: [{ ...scenario, tests: [
      { title: "new", checkId: "new" },
      { ...tests[1], title: "edited display title" }, tests[0],
    ] }] });
    expect(changed.slice(1).map(check => check.checkId))
      .toEqual(original.map(check => check.checkId).reverse());
  });

  it("does not expose long Korean source IDs to the model as check IDs", () => {
    const titles = [
      "to be: 제목·입력창·추천 질문을 접근 가능한 이름으로 확인한다",
      "to be: 키보드 사용만으로 업로드 dialog에 진입한다",
      "to be: 같은 작업 ID 로 재추출을 요청하고 인박스에 중복 작업을 새로 만들지 않는다",
    ];
    const checklist = buildBrowseChecklist({ scenarios: [{
      sourceFile: "검사.spec.ts", scenarioId: "인증됨",
      tests: titles.map(title => ({ title, checkId: title })),
    }] });
    expect(new Set(checklist.map(check => check.checkId)).size).toBe(titles.length);
    for (const check of checklist) expect(check.checkId).toMatch(/^chk_[0-9a-f]{16}$/);
    expect(checklist.map(check => check.title)).toEqual(titles);
    const plannedChecks = checklist.map(({ checkId, title }) => ({ checkId, item: title }));
    const { document } = buildJudgeBrowseDocument({
      page: "ocr", spec: { scenarios: [] }, plannedChecks,
      specLiveMarkdown: "# Saved plan",
    });
    expect(runFixture(document, 1).checks.map(check => check.checkId))
      .toEqual(plannedChecks.map(check => check.checkId));
  });

  it("keeps component boundaries distinct and uses a title only when the source ID is absent", () => {
    const checklist = buildBrowseChecklist({ scenarios: [
      { sourceFile: "a/b", scenarioId: "c", tests: [{ title: "same", checkId: "d" }] },
      { sourceFile: "a", scenarioId: "b/c", tests: [{ title: "same", checkId: "d" }] },
      { sourceFile: "a", scenarioId: "b", tests: [{ title: "first" }, { title: "second" }] },
    ] });
    expect(new Set(checklist.map(check => check.checkId)).size).toBe(4);
  });

  it("rejects a truncated hash collision instead of binding two checks to one ID", () => {
    const hash = vi.spyOn(specHashes, "hashJson").mockReturnValue("sha256:" + "a".repeat(64));
    try {
      expect(() => buildBrowseChecklist({ scenarios: [{
        sourceFile: "one.spec.ts", scenarioId: "ACTIVE",
        tests: [{ title: "first", checkId: "first" }, { title: "second", checkId: "second" }],
      }] })).toThrow(/duplicate|ambiguous/i);
    } finally {
      hash.mockRestore();
    }
  });

  it("invalidates spec caches from the long-ID reader version", () => {
    const specDir = mkdtempSync(join(dir, "source-"));
    writeFileSync(join(specDir, "one.spec.ts"), "// unchanged source");
    expect(hashSpecSources(specDir, SPEC_READER_VERSION))
      .not.toBe(hashSpecSources(specDir, "2.0.0"));
  });

  it("tells both judge and reviewer to treat check IDs as opaque tokens", () => {
    const query = buildBrowseHermesQuery({
      judgeDocument: "# Plan", stagingLogin: { authRequired: false, targetUrl: "http://localhost" },
    });
    const review = buildJudgeReviewHermesQuery({ packetText: "# Packet", packetSha256: "sha256:abc" });
    expect(query).toContain("opaque");
    expect(review).toContain("opaque");
  });

  it("rejects ambiguous source IDs instead of making order-dependent suffixes", () => {
    expect(() => buildBrowseChecklist({ scenarios: [{
      sourceFile: "one.spec.ts", scenarioId: "ACTIVE",
      tests: [{ title: "one", checkId: "same" }, { title: "two", checkId: "same" }],
    }] })).toThrow(/duplicate|ambiguous/i);
  });

  it("includes authoritative IDs beside a saved plan and echoes them in offline runs", () => {
    const { document } = buildJudgeBrowseDocument({
      page: "dashboard", spec: { scenarios: [] },
      specLiveMarkdown: "# Saved plan\n## Check identities\n\n```json\nnull\n```\n### shows score\n",
      plannedChecks: plan,
    });
    expect(document).toContain("# Saved plan");
    expect(document).toContain("## Check identities");
    expect(document).toContain(JSON.stringify(plan));
    const result = runFixture(document, 1);
    expect(result.checks.map(check => check.checkId)).toEqual(plan.map(check => check.checkId));
    expect(result.status).toBe("manual_review");
  });

  it.each([
    "null", "{}", "{broken", "[null]", '["title"]',
    '[{"item":"title"}]', '[{"checkId":"id","item":3}]',
    '[{"checkId":" ","item":"title"}]', '[{"checkId":"id","item":""}]',
  ])("rejects unusable fixture identity data: %s", json => {
    const query = "## Check identities\n\n```json\n" + json + "\n```";
    expect(() => runFixture(query, 1)).toThrow(AgentOutputError);
  });

  it("keeps same-title results and evidence separate by ID", () => {
    const decision = normalizeBrowseDecision({ checks: [...checks].reverse() }, { plannedChecks: plan, runnerEvidence });
    expect(decision.status).toBe("pass");
    expect(decision.checks.map(check => check.checkId)).toEqual(["inactive/score", "active/score"]);
    const manifest = buildEvidenceManifest({ runId: "run-one", plannedChecks: plan, checks: decision.checks, runnerEvidence });
    expect(manifest.runId).toBe("run-one");
    expect(manifest.items.map(check => check.checkId)).toEqual(plan.map(check => check.checkId));
    expect(manifest.items.every(check => check.evidenceRefs[0] === snapshot)).toBe(true);
  });

  it.each([
    [{ ...checks[0], checkId: "unknown" }, checks[1]],
    [{ ...checks[0], checkId: undefined }, checks[1]],
    [checks[0], checks[0], checks[1]],
    [...checks, { ...checks[0], checkId: "unplanned" }],
  ])("does not accept missing, unknown, or duplicate reported IDs", reported => {
    expect(normalizeBrowseDecision({ checks: reported }, { plannedChecks: plan, runnerEvidence }).status)
      .toBe("manual_review");
  });

  it("matches short IDs independently of titles and rejects a one-character ID change", () => {
    const plannedChecks = buildBrowseChecklist({ scenarios: [{
      sourceFile: "ocr.spec.ts", scenarioId: "ACTIVE",
      tests: [{ title: "같은 제목", checkId: "first" }, { title: "같은 제목", checkId: "second" }],
    }] }).map(({ checkId, title }) => ({ checkId, item: title }));
    const reported = plannedChecks.map(check => ({
      ...check, item: "AI가 바꿔 쓴 제목", result: "pass", detail: 'Observed "98 pts"',
    }));
    const valid = normalizeBrowseDecision({ checks: [...reported].reverse() }, { plannedChecks, runnerEvidence });
    expect(valid.status).toBe("pass");
    expect(valid.checks.map(check => check.item)).toEqual(["같은 제목", "같은 제목"]);
    const id = reported[0].checkId;
    const corruptedId = id.slice(0, -1) + (id.endsWith("0") ? "1" : "0");
    const invalid = normalizeBrowseDecision({ checks: [
      { ...reported[0], item: plannedChecks[0].item, checkId: corruptedId }, reported[1],
    ] }, { plannedChecks, runnerEvidence });
    expect(invalid.status).toBe("manual_review");
    expect(invalid.coverage.missingCheckIds).toEqual([id]);
    expect(invalid.coverage.unplannedCheckIds).toEqual([corruptedId]);
  });

  it("does not map the same report to duplicate planned IDs", () => {
    expect(buildCoverage([plan[0], plan[0]], [checks[0]]).addressed).toBe(0);
  });

  it("preserves separate duplicate-title entries in legacy manifests", () => {
    const manifest = buildEvidenceManifest({ plannedChecks: ["same", "same"], checks: [
      { item: "same", result: "pass", detail: "first", evidenceRefs: ["first.yaml"] },
      { item: "same", result: "fail", detail: "second", evidenceRefs: ["second.yaml"] },
    ] });
    expect(manifest.items.map(check => check.result)).toEqual(["pass", "fail"]);
  });

  it("matches reviewer recommendations by ID, never a duplicate title", () => {
    const review = normalizeJudgeReview({
      criteria: REVIEW_CRITERIA.map(({ id }) => ({ id, verdict: "pass" })),
      recommendations: [
        { checkId: "active/score", item: "wrong label", suggestedResult: "manual_review" },
        { checkId: "unknown", item: "shows score", suggestedResult: "pass" },
        { item: "shows score", suggestedResult: "pass" },
      ],
    }, { checks: [checks[0], { ...checks[1], result: "fail" }], runnerEvidence });
    expect(review.recommendations).toEqual([expect.objectContaining({
      checkId: "active/score", item: "shows score", currentResult: "pass",
    })]);
    expect(review.warnings).toHaveLength(2);
  });
});

describe("invocation-scoped ARIA cache", () => {
  it("reads one snapshot once for many checks and refreshes on the next invocation", () => {
    const file = join(dir, "changing.yaml");
    writeFileSync(file, '- text: 98 pts\n');
    const readText = vi.fn(path => readFileSync(path, "utf8"));
    const options = { runnerEvidence: { ariaSnapshots: [file] }, readText };
    expect(normalizeBrowseDecision({ checks: Array(100).fill(checks[0]) }, options).status).toBe("pass");
    expect(readText).toHaveBeenCalledTimes(1);
    writeFileSync(file, '- text: 42 pts\n');
    expect(normalizeBrowseDecision({ checks: [checks[0]] }, options).status).toBe("manual_review");
    expect(readText).toHaveBeenCalledTimes(2);
    rmSync(file);
    expect(normalizeBrowseDecision({ checks: [checks[0]] }, options).status).toBe("manual_review");
    expect(readText).toHaveBeenCalledTimes(2);
  });

  it("caches read failures only within an invocation", () => {
    const readText = vi.fn(() => { throw new Error("unreadable"); });
    const options = { runnerEvidence, readText };
    normalizeBrowseDecision({ checks }, options);
    expect(readText).toHaveBeenCalledTimes(1);
    normalizeBrowseDecision({ checks }, options);
    expect(readText).toHaveBeenCalledTimes(2);
  });

  it("also scopes the reviewer cache to one review invocation", () => {
    const readText = vi.fn(path => readFileSync(path, "utf8"));
    expect(findUncitedChecks({ checks, runnerEvidence }, { readText })).toEqual([]);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(findUncitedChecks({ checks, runnerEvidence }, { readText })).toEqual([]);
    expect(readText).toHaveBeenCalledTimes(2);
  });
});
