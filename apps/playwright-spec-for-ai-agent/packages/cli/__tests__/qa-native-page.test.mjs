import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runQaNative } from "../qa-native.mjs";

const temporaryDirectories = [];
const integrityKey = Buffer.alloc(32, 0x51).toString("base64");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// A project whose config points page "dashboard" at a spec directory holding two spec files, one
// runnable on live and one @qa-live-policy: skip.
function pageProject() {
  const cwd = mkdtempSync(join(tmpdir(), "qa-native-page-"));
  temporaryDirectories.push(cwd);
  const specDir = join(cwd, "src", "page", "dashboard", "__tests__");
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, "dashboard-inactive.spec.ts"), `// @qa-scenario: INACTIVE\ntest.describe("inactive", () => {\n  // @qa-live-policy: readonly\n  test("shows inactive", async ({ page }) => { await expect(page.getByText("X")).toBeVisible(); });\n});\n`);
  writeFileSync(join(specDir, "dashboard-active.spec.ts"), `// @qa-scenario: ACTIVE\ntest.describe("active", () => {\n  // @qa-live-policy: readonly\n  test("shows active", async ({ page }) => { await expect(page.getByText("Y")).toBeVisible(); });\n});\n`);
  writeFileSync(join(specDir, "dashboard.helpers.ts"), "export const helper = 1;\n");
  writeFileSync(join(cwd, "hermes-qa.config.mjs"), `export default { batch: { defaultBaseUrl: "https://agent-dev.test", pages: ["dashboard"] }, pages: { dashboard: { targetPath: "/dashboard" } } };\n`);
  return cwd;
}

describe("qa-native execute --page", () => {
  it("resolves the page's spec directory and base URL from the project config", async () => {
    const cwd = pageProject();
    const execute = vi.fn(async () => 0);
    const exitCode = await runQaNative(["execute", "--page=dashboard", "--run-dir=.qa/runs/page"], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey },
      handlers: { execute },
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(exitCode).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
    const request = execute.mock.calls[0][0];
    expect(request.specPaths).toHaveLength(2); // both specs, helper excluded
    expect(request.specPaths.every((path) => path.endsWith(".spec.ts"))).toBe(true);
    expect(request.baseUrl).toBe("https://agent-dev.test/");
    expect(request.allowPartial).toBe(true); // page mode skips non-live scenarios
    expect(request.specPath).toBeUndefined();
  });

  it("lets an explicit --base-url override the config default", async () => {
    const cwd = pageProject();
    const execute = vi.fn(async () => 0);
    await runQaNative(["execute", "--page=dashboard", "--base-url=https://override.test", "--run-dir=.qa/runs/page"], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey },
      handlers: { execute },
      stdout: vi.fn(),
      stderr: vi.fn(),
    });
    expect(execute.mock.calls[0][0].baseUrl).toBe("https://override.test/");
  });

  it("rejects giving both --spec and --page", async () => {
    const cwd = pageProject();
    const stderr = vi.fn();
    const exitCode = await runQaNative(["execute", "--spec=x.spec.ts", "--page=dashboard", "--base-url=https://a.test", "--run-dir=.qa/runs/p"], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey },
      handlers: { execute: vi.fn() },
      stdout: vi.fn(),
      stderr,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith("qa-native: execute requires exactly one of --spec or --page\n");
  });

  it("rejects giving neither --spec nor --page", async () => {
    const cwd = pageProject();
    const stderr = vi.fn();
    const exitCode = await runQaNative(["execute", "--base-url=https://a.test", "--run-dir=.qa/runs/p"], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey },
      handlers: { execute: vi.fn() },
      stdout: vi.fn(),
      stderr,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith("qa-native: execute requires exactly one of --spec or --page\n");
  });

  it("fails clearly when the page has no spec directory", async () => {
    const cwd = pageProject();
    const stderr = vi.fn();
    const exitCode = await runQaNative(["execute", "--page=missing", "--run-dir=.qa/runs/p"], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey },
      handlers: { execute: vi.fn() },
      stdout: vi.fn(),
      stderr,
    });
    expect(exitCode).toBe(1);
    expect(stderr.mock.calls[0][0]).toContain("spec directory for page \"missing\" does not exist");
  });
});
