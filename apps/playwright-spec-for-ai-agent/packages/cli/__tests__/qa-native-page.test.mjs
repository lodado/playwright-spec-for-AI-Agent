import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPageTarget } from "../qa-native-execute.mjs";
import { runQaNative } from "../qa-native.mjs";

const temporaryDirectories = [];
const integrityKey = Buffer.alloc(32, 0x51).toString("base64");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const spec = (scenario, { alwaysRun = false, liveSkip = false } = {}) =>
  `${liveSkip ? "// @qa-live-skip: true\n" : ""}${alwaysRun ? "// @qa-always-run: true\n" : ""}// @qa-scenario: ${scenario}\n// @qa-page: dashboard\ntest.describe("${scenario}", () => {\n  // @qa-live-policy: readonly\n  test("t", async ({ page }) => { await expect(page.getByText("X")).toBeVisible(); });\n});\n`;

function pageProject() {
  const cwd = mkdtempSync(join(tmpdir(), "qa-native-page-"));
  temporaryDirectories.push(cwd);
  const specDir = join(cwd, "src", "page", "dashboard", "__tests__");
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, "dashboard-inactive.spec.ts"), spec("INACTIVE"));
  writeFileSync(join(specDir, "dashboard-active.spec.ts"), spec("ACTIVE"));
  writeFileSync(join(specDir, "dashboard-always.spec.ts"), spec("ACTIVE", { alwaysRun: true }));
  writeFileSync(join(specDir, "dashboard-skip.spec.ts"), spec("INACTIVE", { liveSkip: true }));
  writeFileSync(join(specDir, "dashboard.helpers.ts"), "export const helper = 1;\n");
  writeFileSync(join(cwd, "playwright-spec-for-ai-agent.config.mjs"), `export default { baseUrl: "https://agent-dev.test", pages: { dashboard: { targetPath: "/ko/dashboard" } } };\n`);
  return cwd;
}

async function pageSpecPaths(cwd, extraArgs = []) {
  const execute = vi.fn(async () => 0);
  const exitCode = await runQaNative(["execute", "--page=dashboard", "--run-dir=.qa/runs/page", ...extraArgs], {
    cwd,
    env: { QA_NATIVE_INTEGRITY_KEY: integrityKey },
    handlers: { execute },
    stdout: vi.fn(),
    stderr: vi.fn(),
  });
  return { exitCode, request: execute.mock.calls[0]?.[0] };
}

describe("qa-native execute --page selection", () => {
  it("runs every non-skipped page spec", async () => {
    const { exitCode, request } = await pageSpecPaths(pageProject());
    expect(exitCode).toBe(0);
    const names = request.specPaths.map((path) => path.split("/").at(-1)).sort();
    expect(names).toEqual(["dashboard-active.spec.ts", "dashboard-always.spec.ts", "dashboard-inactive.spec.ts"]);
    expect(request.pageTargetPath).toBe("/ko/dashboard");
  });

  it("reports when every spec is explicitly live-skipped", async () => {
    const cwd = pageProject();
    const specDir = join(cwd, "src", "page", "dashboard", "__tests__");
    rmSync(join(specDir, "dashboard-active.spec.ts"));
    rmSync(join(specDir, "dashboard-always.spec.ts"));
    rmSync(join(specDir, "dashboard-inactive.spec.ts"));
    const stderr = vi.fn();
    const exitCode = await runQaNative(["execute", "--page=dashboard", "--run-dir=.qa/runs/page"], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey },
      handlers: { execute: vi.fn() },
      stdout: vi.fn(),
      stderr,
    });
    expect(exitCode).toBe(1);
    expect(stderr.mock.calls[0][0]).toContain("all 1 spec(s) are excluded by // @qa-live-skip: true");
  });

  it("resolves the configured base URL and lets --base-url override it", async () => {
    const fromConfig = await pageSpecPaths(pageProject());
    expect(fromConfig.request.baseUrl).toBe("https://agent-dev.test/");
    const override = await pageSpecPaths(pageProject(), ["--base-url=https://override.test"]);
    expect(override.request.baseUrl).toBe("https://override.test/");
  });

  it("rejects giving both --spec and --page, or neither", async () => {
    const cwd = pageProject();
    const both = vi.fn();
    expect(await runQaNative(["execute", "--spec=x.spec.ts", "--page=dashboard", "--base-url=https://a.test", "--run-dir=.qa/runs/p"], { cwd, env: { QA_NATIVE_INTEGRITY_KEY: integrityKey }, handlers: { execute: both }, stdout: vi.fn(), stderr: vi.fn() })).toBe(1);
    expect(await runQaNative(["execute", "--base-url=https://a.test", "--run-dir=.qa/runs/p"], { cwd, env: { QA_NATIVE_INTEGRITY_KEY: integrityKey }, handlers: { execute: both }, stdout: vi.fn(), stderr: vi.fn() })).toBe(1);
    expect(both).not.toHaveBeenCalled();
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

describe("applyPageTarget", () => {
  const qaIr = (navTarget = { type: "PATH", value: "dashboard" }) => ({
    suites: [{ scenarios: [{ steps: [
      { id: "n", kind: "NAVIGATE", target: navTarget },
      { id: "o", kind: "OBSERVE", requests: [] },
    ] }] }],
  });

  it("rewrites a PATH navigation to the config target path", () => {
    const out = applyPageTarget(qaIr(), { pageTargetPath: "/ko/dashboard" });
    expect(out.suites[0].scenarios[0].steps[0].target).toEqual({ type: "PATH", value: "/ko/dashboard" });
    expect(out.suites[0].scenarios[0].steps[1].kind).toBe("OBSERVE"); // non-NAVIGATE untouched
  });

  it("rewrites to a URL target when a page URL is configured", () => {
    const out = applyPageTarget(qaIr(), { pageUrl: "https://x.test/ko/dashboard" });
    expect(out.suites[0].scenarios[0].steps[0].target).toEqual({ type: "URL", value: "https://x.test/ko/dashboard" });
  });

  it("is a no-op when neither target is set", () => {
    const input = qaIr();
    expect(applyPageTarget(input, {})).toBe(input);
  });
});
