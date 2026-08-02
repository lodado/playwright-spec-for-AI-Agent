import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abstractQaNative, abstractSpecInputs } from "../qa-native-abstract.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "qa-native-abstract-"));
  roots.push(cwd);
  const specPath = join(cwd, "dashboard.spec.ts");
  writeFileSync(specPath, '// @qa-scenario: DASHBOARD\n// @qa-live-policy: readonly\ntest("shows dashboard", async () => {});\n');
  return { cwd, specPath };
}

function provider(implementation, promptVersion) {
  const fn = vi.fn(implementation);
  fn.identity = { provider: "fixture", model: "test", modelVersion: "v1" };
  fn.promptVersion = promptVersion;
  return fn;
}

describe("qa-native abstract-ai", () => {
  it("returns nonzero without invoking AI when no spec has static authority", async () => {
    const { cwd, specPath } = fixture();
    writeFileSync(specPath, 'test("unannotated", async () => {});\n');
    const extract = provider(vi.fn(), "extract/1");
    const reportSkipped = vi.fn();

    expect(await abstractQaNative({ cwd, specPath }, { extract, review: provider(vi.fn(), "review/1"), report: vi.fn(), reportSkipped })).toBe(1);
    expect(extract).not.toHaveBeenCalled();
    expect(reportSkipped).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: "dashboard.spec.ts" }));
  });

  it("reports per-spec progress for execute callers too", async () => {
    const { cwd, specPath } = fixture();
    const progress = vi.fn();
    const extract = provider(async ({ manifest }) => ({ status: "ABSTRACTED", tests: [{ testId: manifest.tests[0].testId, given: [], when: ["the dashboard opens"], then: ["the dashboard is visible"], classification: "LIVE_EXECUTABLE" }] }), "extract/1");
    const review = provider(async ({ candidate }) => ({ status: "APPROVED", tests: candidate.tests }), "review/1");

    await abstractSpecInputs({ specPath, cwd }, { extract, review, progress });

    expect(progress).toHaveBeenCalledWith({ index: 0, total: 1, sourcePath: "dashboard.spec.ts" });
  });

  it("writes private JSON and Markdown then reuses the source-and-provider cache", async () => {
    const { cwd, specPath } = fixture();
    const extract = provider(async ({ manifest }) => ({ status: "ABSTRACTED", tests: [{ testId: manifest.tests[0].testId, given: [], when: ["the dashboard opens"], then: ["the dashboard is visible"], classification: "LIVE_EXECUTABLE" }] }), "extract/1");
    const review = provider(async ({ candidate }) => ({ status: "APPROVED", tests: candidate.tests }), "review/1");
    const report = vi.fn();

    expect(await abstractQaNative({ cwd, specPath, page: "dashboard" }, { extract, review, report })).toBe(0);
    expect(await abstractQaNative({ cwd, specPath, page: "dashboard" }, { extract, review, report })).toBe(0);
    expect(extract).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();
    const second = report.mock.calls[1][0].results[0];
    expect(second.cached).toBe(true);
    expect(JSON.parse(readFileSync(join(cwd, second.jsonPath), "utf8")).artifact.status).toBe("APPROVED");
    expect(JSON.parse(readFileSync(join(cwd, second.jsonPath), "utf8")).manifest.tests[0].livePolicyAnnotation).toBe("readonly");
    expect(readFileSync(join(cwd, second.markdownPath), "utf8")).toContain("## shows dashboard");

    expect(await abstractQaNative({ cwd, specPath, page: "deep-ocr" }, { extract, review, report })).toBe(0);
    const third = report.mock.calls[2][0].results[0];
    expect(third.cached).toBe(true);
    expect(third.jsonPath).toBe(second.jsonPath);
    expect(third.markdownPath).not.toBe(second.markdownPath);
    expect(extract).toHaveBeenCalledOnce();
  });

  it("returns nonzero and caches fail-closed manual review", async () => {
    const { cwd, specPath } = fixture();
    const extract = provider(async () => ({ status: "MANUAL_REVIEW", reason: "meaning is ambiguous" }), "extract/1");
    const review = provider(async ({ candidate }) => ({ status: "APPROVED", tests: candidate.tests }), "review/1");
    const report = vi.fn();

    expect(await abstractQaNative({ cwd, specPath }, { extract, review, report })).toBe(1);
    expect(review).not.toHaveBeenCalled();
    expect(report.mock.calls[0][0].results[0].artifact.status).toBe("MANUAL_REVIEW");
  });

  it("renders the independent reviewer's final manual-review reason", async () => {
    const { cwd, specPath } = fixture();
    const extract = provider(async ({ manifest }) => ({ status: "ABSTRACTED", tests: [{ testId: manifest.tests[0].testId, given: [], when: ["the dashboard opens"], then: ["the dashboard is visible"], classification: "LIVE_EXECUTABLE" }] }), "extract/1");
    const review = provider(async () => ({ status: "MANUAL_REVIEW", reason: "meaning cannot be corrected reliably" }), "review/1");
    const report = vi.fn();

    expect(await abstractQaNative({ cwd, specPath }, { extract, review, report })).toBe(1);
    const markdown = readFileSync(join(cwd, report.mock.calls[0][0].results[0].markdownPath), "utf8");
    expect(markdown).toContain("meaning cannot be corrected reliably");
  });

  it("names the spec whose provider call fails", async () => {
    const { cwd, specPath } = fixture();
    const extract = provider(async () => { const error = new Error("private transport detail"); error.code = "ETIMEDOUT"; throw error; }, "extract/1");
    const review = provider(async ({ candidate }) => ({ status: "APPROVED", tests: candidate.tests }), "review/1");

    await expect(abstractQaNative({ cwd, specPath }, { extract, review, report: vi.fn() })).rejects.toThrow('AI abstraction failed for "dashboard.spec.ts": ETIMEDOUT');
  });
});
