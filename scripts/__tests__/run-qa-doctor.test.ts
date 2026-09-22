import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { collectDoctorReport, formatDoctorReport } from "../run-qa-doctor.mjs";

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => root,
}));

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
  vi.unstubAllEnvs();
});

describe("collectDoctorReport", () => {
  it.each(['openai-codex', 'openai-api', 'custom-provider'])('does not invent an API key requirement for %s', async provider => {
    const args = project();
    vi.stubEnv('QA_AI_ADAPTER', 'hermes');
    mkdirSync(join(root, '.hermes'));
    writeFileSync(join(root, '.hermes/config.yaml'), `model:\n  provider: ${provider}\n  default: test-model\n`);
    const report = await collectDoctorReport(args);
    const auth = find(report, 'adapter provider');
    expect(auth.status).toBe('warn');
    expect(auth.detail).toContain('not verified');
    expect(auth.detail + auth.hint).not.toContain(`${provider.toUpperCase()}_API_KEY`);
    if (provider === 'openai-codex') expect(auth.detail).toContain('OAuth');
  });

  it('reports unverified upload as a warning without an opt-in model call', async () => {
    const args = project();
    vi.stubEnv('QA_AI_ADAPTER', 'exec');
    vi.stubEnv('QA_AGENT_AUTH', 'cdp-attach');
    writeFileSync(join(root, 'fixture.txt'), 'fixture');
    writeFileSync(join(root, 'specs/demo.spec.ts'), '// @qa-fixture: document=fixture.txt\n' + SPEC);
    const report = await collectDoctorReport(args);
    expect(find(report, 'demo · upload fixtures')).toMatchObject({ status: 'warn' });
    expect(find(report, 'demo · upload fixtures').detail).toContain('NOT verified');
  });

  it('fails on a missing declared upload fixture', async () => {
    const args = project();
    writeFileSync(join(root, 'specs/demo.spec.ts'), '// @qa-fixture: document=missing.pdf\n' + SPEC);
    const report = await collectDoctorReport(args);
    expect(report.ok).toBe(false);
    expect(find(report, 'demo · upload fixtures')).toMatchObject({ status: 'fail' });
    expect(find(report, 'demo · upload fixtures').detail).toContain('missing.pdf');
  });

  it('does not treat readable files as working upload tools', async () => {
    const args = project();
    writeFileSync(join(root, 'fixture.txt'), 'fixture');
    writeFileSync(join(root, 'specs/demo.spec.ts'), '// @qa-fixture: document=fixture.txt\n' + SPEC);
    const report = await collectDoctorReport(args);
    expect(find(report, 'demo · upload fixtures')).toMatchObject({ status: 'fail' });
    expect(find(report, 'demo · upload fixtures').detail).toContain('cdp-attach');
  });

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

describe("Stagehand doctor", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires explicit model configuration without making network calls", async () => {
    vi.stubEnv("QA_AI_ADAPTER", "stagehand");
    vi.stubEnv("QA_STAGEHAND_MODEL", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const report = await collectDoctorReport(project());
    expect(find(report, "stagehand configuration").status).toBe("fail");
    expect(find(report, "stagehand configuration").detail).toContain("QA_STAGEHAND_MODEL");
    expect(fetch).toHaveBeenCalledTimes(0);
  });

  it("reports credential presence without exposing its value", async () => {
    vi.stubEnv("QA_AI_ADAPTER", "stagehand");
    vi.stubEnv("QA_STAGEHAND_MODEL", "openai/gpt-4.1-mini");
    vi.stubEnv("QA_STAGEHAND_API_KEY", "private-doctor-test-key");
    const report = await collectDoctorReport(project());
    expect(find(report, "stagehand model credentials").status).toBe("pass");
    expect(JSON.stringify(report)).not.toContain("private-doctor-test-key");
    expect(find(report, "stagehand limits").status).toBe("pass");
  });
});
