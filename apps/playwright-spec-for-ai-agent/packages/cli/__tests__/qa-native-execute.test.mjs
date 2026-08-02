import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { abstractPlaywrightSource } from "../../abstract-playwright/index.mjs";
import { executeQaNative } from "../qa-native-execute.mjs";

const temporaryDirectories = [];
const integrityKey = Buffer.alloc(32, 0x63);
const runnableSource = `// @qa-scenario: GENERIC
// @qa-page: /items
// @qa-live-policy: readonly
test("shows items", async ({ page }) => {
  await expect(page.getByText("Items")).toBeVisible();
});`;
const manyScenarioSource = `// @qa-scenario: GENERIC
// @qa-page: /items
${["one", "two", "three", "four", "five"].map(name => `// @qa-live-policy: readonly
test("${name}", async ({ page }) => { await expect(page.getByText("Items")).toBeVisible(); });`).join("\n")}`;
const blockedSource = `// @qa-scenario: GENERIC
test("shows items", async ({ page }) => {
  await expect(page.getByText("Items")).toBeVisible();
});`;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("qa-native v3 execute", () => {
  it("does not invoke either AI or the browser for a fully blocked spec", async () => {
    const { cwd, specPath, runDirectory } = project(blockedSource, "blocked");
    const abstractInputs = vi.fn();
    const executeAdaptive = vi.fn();

    await expect(executeQaNative({ specPath, baseUrl: "https://example.test", runDirectory, integrityKey, cwd }, { abstractInputs, executeAdaptive })).rejects.toThrow(/policy-eligible/);

    expect(abstractInputs).not.toHaveBeenCalled();
    expect(executeAdaptive).not.toHaveBeenCalled();
    expect(existsSync(runDirectory)).toBe(false);
  });

  it("removes the empty reservation when behavior review requires manual review", async () => {
    const { cwd, specPath, runDirectory } = project(runnableSource, "manual");
    const executeAdaptive = vi.fn();

    await expect(executeQaNative({ specPath, baseUrl: "https://example.test", runDirectory, integrityKey, cwd }, {
      abstractInputs: async ({ sourceInputs }) => sourceInputs.map(input => ({
        sourcePath: input.sourcePath,
        manifest: input.manifest,
        artifact: { schemaVersion: "behavioral-spec/3.0", status: "MANUAL_REVIEW", source: input.manifest.source, tests: [], reason: "Meaning is ambiguous." },
      })),
      executeAdaptive,
    })).rejects.toThrow(/manual review/);

    expect(executeAdaptive).not.toHaveBeenCalled();
    expect(existsSync(runDirectory)).toBe(false);
  });

  it("rejects an archive-incompatible action budget before launching the browser", async () => {
    const { cwd, specPath, runDirectory } = project(manyScenarioSource, "budget");
    const executeAdaptive = vi.fn();

    await expect(executeQaNative({ specPath, baseUrl: "https://example.test", runDirectory, integrityKey, cwd, budgetOverrides: { actions: 256 } }, {
      abstractInputs: approvedInputs,
      executeAdaptive,
    })).rejects.toThrow(/evidence archive limit/);

    expect(executeAdaptive).not.toHaveBeenCalled();
    expect(existsSync(runDirectory)).toBe(false);
  });
});

async function approvedInputs({ sourceInputs }) {
  return Promise.all(sourceInputs.map(async input => ({
    sourcePath: input.sourcePath,
    manifest: input.manifest,
    artifact: await abstractPlaywrightSource({
      ...input,
      extract: async ({ manifest }) => ({
        status: "ABSTRACTED",
        tests: manifest.tests.map(test => ({ testId: test.testId, given: ["The items page is open"], when: ["The page is observed"], then: ["Items are visible"], classification: "LIVE_EXECUTABLE" })),
      }),
      review: async ({ candidate }) => ({ status: "APPROVED", tests: candidate.tests }),
    }),
  })));
}

function project(source, runId) {
  const cwd = mkdtempSync(join(tmpdir(), "qa-native-execute-v3-"));
  temporaryDirectories.push(cwd);
  const specPath = join(cwd, "items.spec.ts");
  writeFileSync(specPath, source);
  return { cwd, specPath, runDirectory: join(cwd, ".qa", "runs", runId) };
}
