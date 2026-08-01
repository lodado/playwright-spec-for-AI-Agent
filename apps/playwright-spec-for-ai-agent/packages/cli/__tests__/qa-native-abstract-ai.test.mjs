import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abstractQaNative } from "../qa-native-abstract-ai.mjs";

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
  it("writes private JSON and Markdown then reuses the source-and-provider cache", async () => {
    const { cwd, specPath } = fixture();
    const extract = provider(async ({ manifest }) => ({ status: "ABSTRACTED", tests: [{ testId: manifest.tests[0].testId, applicability: [], when: ["the dashboard opens"], claims: ["the dashboard is visible"], classification: "LIVE_EXECUTABLE" }] }), "extract/1");
    const review = provider(async () => ({ status: "APPROVED" }), "review/1");
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
    const review = provider(async () => ({ status: "APPROVED" }), "review/1");
    const report = vi.fn();

    expect(await abstractQaNative({ cwd, specPath }, { extract, review, report })).toBe(1);
    expect(review).not.toHaveBeenCalled();
    expect(report.mock.calls[0][0].results[0].artifact.status).toBe("MANUAL_REVIEW");
  });

  it("renders independent reviewer feedback for self-improvement", async () => {
    const { cwd, specPath } = fixture();
    const extract = provider(async ({ manifest }) => ({ status: "ABSTRACTED", tests: [{ testId: manifest.tests[0].testId, applicability: [], when: ["the dashboard opens"], claims: ["the dashboard is visible"], classification: "LIVE_EXECUTABLE" }] }), "extract/1");
    const review = provider(async () => ({ status: "REVISE", issues: ["preserve the disabled-state claim"] }), "review/1");
    const report = vi.fn();

    expect(await abstractQaNative({ cwd, specPath }, { extract, review, report })).toBe(1);
    const markdown = readFileSync(join(cwd, report.mock.calls[0][0].results[0].markdownPath), "utf8");
    expect(markdown).toContain("## Independent review feedback");
    expect(markdown).toContain("preserve the disabled-state claim");
  });

  it("names the spec whose provider call fails", async () => {
    const { cwd, specPath } = fixture();
    const extract = provider(async () => { const error = new Error("private transport detail"); error.code = "ETIMEDOUT"; throw error; }, "extract/1");
    const review = provider(async () => ({ status: "APPROVED" }), "review/1");

    await expect(abstractQaNative({ cwd, specPath }, { extract, review, report: vi.fn() })).rejects.toThrow('AI abstraction failed for "dashboard.spec.ts": ETIMEDOUT');
  });
});
