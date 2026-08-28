import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { collectDoctorReport, formatDoctorReport } from "../run-qa-doctor.mjs";

const SPEC = `// @qa-page: demo
// @qa-scenario: ACTIVE

import { expect, test } from "@playwright/test";

test.describe("Demo", () => {
  // @qa-live-policy: readonly
  test("shows the plan name", async ({ page }) => {
    await expect(page.getByTestId("plan-name")).toBeVisible();
  });
});
`;

const SKIPPED_SPEC = `// @qa-scenario: INACTIVE
// @qa-live-skip: true

import { test } from "@playwright/test";

test("never judged on live", async () => {});
`;

let root = "";

function project({
  baseUrl = "https://staging.acme.test",
  withSpecDir = true,
}: { baseUrl?: string; withSpecDir?: boolean } = {}) {
  const specDir = join(root, "specs");
  if (withSpecDir) {
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "demo.spec.ts"), SPEC);
    writeFileSync(join(specDir, "legacy.spec.ts"), SKIPPED_SPEC);
  }

  const configPath = join(root, "playwright-spec-for-ai-agent.config.mjs");
  writeFileSync(
    configPath,
    `export default ${JSON.stringify(
      {
        root,
        paths: { specDir, outputDir: join(root, "__QA__") },
        staging: { authRequired: false },
        pages: { demo: { baseUrl, targetPath: "/dashboard" } },
      },
      null,
      2
    )};\n`
  );
  return [`--config=${configPath}`, `--project-root=${root}`];
}

function find(report: any, name: string) {
  return report.checks.find((entry: any) => entry.name === name);
}

beforeEach(() => {
  resetProjectConfigForTests();
  root = mkdtempSync(join(tmpdir(), "qa-doctor-"));
  process.env.QA_AI_ADAPTER = "fixture";
});

afterEach(() => {
  resetProjectConfigForTests();
  rmSync(root, { recursive: true, force: true });
  delete process.env.QA_AI_ADAPTER;
  vi.unstubAllGlobals();
});

describe("collectDoctorReport", () => {
  it("passes a complete setup and counts annotated and live-skipped specs", async () => {
    const report = await collectDoctorReport(project());

    expect(report.ok).toBe(true);
    expect(find(report, "demo · spec dir").status).toBe("pass");
    expect(find(report, "demo · spec dir").detail).toContain(
      "2 annotated, 1 @qa-live-skip, 1 runnable"
    );
    expect(find(report, "demo · target").detail).toBe(
      "https://staging.acme.test/dashboard"
    );
    expect(find(report, "adapter").detail).toContain("fixture");
  });

  it("fails when the resolved spec dir does not exist, and names the fix", async () => {
    const report = await collectDoctorReport(project({ withSpecDir: false }));

    expect(report.ok).toBe(false);
    const check = find(report, "demo · spec dir");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("missing:");
    expect(check.hint).toContain("pages.demo.specDir");
  });

  it("fails on a placeholder base URL instead of judging it", async () => {
    const report = await collectDoctorReport(
      project({ baseUrl: "https://your-staging.acmecorp.com" })
    );

    expect(report.ok).toBe(false);
    const check = find(report, "demo · target");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("placeholder base URL");
  });

  it("surfaces unknown config keys as a warning without failing the run", async () => {
    const configPath = join(root, "playwright-spec-for-ai-agent.config.mjs");
    const specDir = join(root, "specs");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "demo.spec.ts"), SPEC);
    writeFileSync(
      configPath,
      `export default {
  root: ${JSON.stringify(root)},
  paths: { specDir: ${JSON.stringify(specDir)} },
  stagingg: {},
  pages: { demo: { baseUrl: "https://staging.acme.test", targetPath: "/x", authRequired: false } },
};\n`
    );

    const report = await collectDoctorReport([
      `--config=${configPath}`,
      `--project-root=${root}`,
    ]);

    const check = find(report, "config");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("stagingg");
    expect(report.ok).toBe(true);
  });

  it("makes no network call unless --check-network is given", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await collectDoctorReport(project());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("probes the target URL under --check-network", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", fetchSpy);

    const report = await collectDoctorReport([...project(), "--check-network"]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://staging.acme.test/dashboard");
    expect(find(report, "demo · reachable").status).toBe("pass");
  });

  it("fails when an unreachable target is probed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );

    const report = await collectDoctorReport([...project(), "--check-network"]);

    expect(report.ok).toBe(false);
    expect(find(report, "demo · reachable").detail).toContain("ECONNREFUSED");
  });

  it("fails when no page is configured at all", async () => {
    const configPath = join(root, "playwright-spec-for-ai-agent.config.mjs");
    writeFileSync(configPath, `export default { root: ${JSON.stringify(root)} };\n`);

    const report = await collectDoctorReport([
      `--config=${configPath}`,
      `--project-root=${root}`,
    ]);

    expect(report.ok).toBe(false);
    expect(find(report, "pages").detail).toContain("no pages configured");
  });
});

describe("formatDoctorReport", () => {
  it("renders one line per check and a hint under every failure", async () => {
    const text = formatDoctorReport(
      await collectDoctorReport(project({ withSpecDir: false }))
    );

    expect(text).toContain("FAIL  demo · spec dir");
    expect(text).toContain("→ Create it, or set pages.demo.specDir");
    expect(text).toMatch(/\d+ failed, \d+ warning, \d+ passed/);
  });
});
