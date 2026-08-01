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

// A project whose config points page "dashboard" at a directory of specs across account states.
// `expectedStatus` sets staging.expectedSubscriptionStatus; `omitStatus: true` leaves it out.
function pageProject({ expectedStatus = "INACTIVE", omitStatus = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "qa-native-page-"));
  temporaryDirectories.push(cwd);
  const specDir = join(cwd, "src", "page", "dashboard", "__tests__");
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, "dashboard-inactive.spec.ts"), spec("INACTIVE"));
  writeFileSync(join(specDir, "dashboard-active.spec.ts"), spec("ACTIVE"));
  writeFileSync(join(specDir, "dashboard-always.spec.ts"), spec("ACTIVE", { alwaysRun: true }));
  writeFileSync(join(specDir, "dashboard-skip.spec.ts"), spec("INACTIVE", { liveSkip: true }));
  writeFileSync(join(specDir, "dashboard.helpers.ts"), "export const helper = 1;\n");
  const staging = omitStatus ? "" : `, staging: { expectedSubscriptionStatus: "${expectedStatus}" }`;
  writeFileSync(join(cwd, "hermes-qa.config.mjs"), `export default { batch: { defaultBaseUrl: "https://agent-dev.test", pages: ["dashboard"] }, pages: { dashboard: { targetPath: "/ko/dashboard" } }${staging} };\n`);
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
  it("keeps status-matching specs plus @qa-always-run, and drops mismatches and @qa-live-skip", async () => {
    const { exitCode, request } = await pageSpecPaths(pageProject({ expectedStatus: "INACTIVE" }));
    expect(exitCode).toBe(0);
    const names = request.specPaths.map((path) => path.split("/").at(-1)).sort();
    expect(names).toEqual(["dashboard-always.spec.ts", "dashboard-inactive.spec.ts"]); // INACTIVE match + always-run; not ACTIVE, not skip
    expect(request.allowPartial).toBe(true);
    expect(request.compiler).toBe("abstract");
    expect(request.pageTargetPath).toBe("/ko/dashboard"); // config target overrides @qa-page
  });

  it("matches expectedSubscriptionStatus case-insensitively", async () => {
    const { request } = await pageSpecPaths(pageProject({ expectedStatus: "inactive" }));
    expect(request.specPaths.map((path) => path.split("/").at(-1)).sort())
      .toEqual(["dashboard-always.spec.ts", "dashboard-inactive.spec.ts"]);
  });

  it("runs the whole directory when no expectedSubscriptionStatus is configured", async () => {
    const { request } = await pageSpecPaths(pageProject({ omitStatus: true }));
    expect(request.specPaths).toHaveLength(3); // all non-skipped specs, helper excluded, no status filter
    expect(request.specPaths.every((path) => !path.endsWith("dashboard-skip.spec.ts"))).toBe(true);
  });

  it("fails with the available @qa-scenario list when nothing matches", async () => {
    const cwd = pageProject({ expectedStatus: "NONEXISTENT" });
    const stderr = vi.fn();
    // Remove the always-run spec so nothing is kept.
    rmSync(join(cwd, "src", "page", "dashboard", "__tests__", "dashboard-always.spec.ts"));
    const exitCode = await runQaNative(["execute", "--page=dashboard", "--run-dir=.qa/runs/page"], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey },
      handlers: { execute: vi.fn() },
      stdout: vi.fn(),
      stderr,
    });
    expect(exitCode).toBe(1);
    expect(stderr.mock.calls[0][0]).toContain('no spec matches expectedScenario "NONEXISTENT"');
    expect(stderr.mock.calls[0][0]).toContain("ACTIVE");
  });

  it("reports when every designated spec is explicitly live-skipped", async () => {
    const cwd = pageProject({ expectedStatus: "INACTIVE" });
    const specDir = join(cwd, "src", "page", "dashboard", "__tests__");
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
    expect(stderr.mock.calls[0][0]).toContain("all 1 config-designated spec(s) are excluded by // @qa-live-skip: true");
  });

  it("reports an all-skipped page when no subscription status is configured", async () => {
    const cwd = pageProject({ omitStatus: true });
    const specDir = join(cwd, "src", "page", "dashboard", "__tests__");
    for (const file of ["dashboard-active.spec.ts", "dashboard-always.spec.ts", "dashboard-inactive.spec.ts"]) rmSync(join(specDir, file));
    const stderr = vi.fn();
    const exitCode = await runQaNative(["execute", "--page=dashboard", "--run-dir=.qa/runs/page"], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey },
      handlers: { execute: vi.fn() },
      stdout: vi.fn(),
      stderr,
    });
    expect(exitCode).toBe(1);
    expect(stderr.mock.calls[0][0]).toContain("all 1 config-designated spec(s) are excluded by // @qa-live-skip: true");
  });

  it("resolves the base URL from batch.defaultBaseUrl and lets --base-url override it", async () => {
    const fromConfig = await pageSpecPaths(pageProject({ expectedStatus: "INACTIVE" }));
    expect(fromConfig.request.baseUrl).toBe("https://agent-dev.test/");
    const override = await pageSpecPaths(pageProject({ expectedStatus: "INACTIVE" }), ["--base-url=https://override.test"]);
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
