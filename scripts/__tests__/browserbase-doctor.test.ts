import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { saveBrowserbaseContext } from "../browser-provider.mjs";
import { collectDoctorReport } from "../run-qa-doctor.mjs";

const api = vi.hoisted(() => ({ getContext: vi.fn(), createSession: vi.fn(), createClient: vi.fn() }));
vi.mock("../browserbase-client.mjs", () => ({
  createBrowserbaseClient: api.createClient,
}));
let root: string;
let argv: string[];
const origin = "https://doctor.example.test";
const find = (report: any, name: string) => report.checks.find((entry: any) => entry.name === name);

function project(authRequired = true, storageState?: string) {
  const config = join(root, "qa.config.mjs");
  writeFileSync(config, `export default ${JSON.stringify({
    root,
    paths: { specDir: join(root, "specs"), outputDir: join(root, "output") },
    staging: { authRequired, storageState },
    pages: { demo: { baseUrl: origin, targetPath: "/dashboard" } },
  })};`);
  return [`--config=${config}`, `--project-root=${root}`, "--browser-provider=browserbase"];
}
function saved(profile = "default", savedOrigin = origin) {
  saveBrowserbaseContext({ root, projectId: "project-secret", origin: savedOrigin, profile, contextId: "context-1" });
}

beforeEach(() => {
  resetProjectConfigForTests();
  root = mkdtempSync(join(tmpdir(), "browserbase-doctor-"));
  mkdirSync(join(root, "specs"));
  writeFileSync(join(root, "specs", "demo.spec.ts"), '// @qa-page: demo\n// @qa-scenario: DEMO\nimport { test } from "@playwright/test";\n// @qa-live-policy: readonly\ntest("visible", async () => {});\n');
  // Exec declares CDP support explicitly and never needs to be invoked by doctor.
  vi.stubEnv("QA_AI_ADAPTER", "exec");
  vi.stubEnv("QA_AGENT_CMD", "unused-agent");
  vi.stubEnv("QA_AGENT_AUTH", "cdp-attach");
  for (const key of ["QA_BROWSER_CDP_URL", "QA_BROWSER_PROVIDER", "QA_BROWSERBASE_PROFILE", "QA_BROWSERBASE_TIMEOUT_SECONDS", "STAGING_QA_EMAIL", "STAGING_QA_PASSWORD", "STAGING_QA_BASE_URL"]) vi.stubEnv(key, "");
  vi.stubEnv("BROWSERBASE_API_KEY", "key-secret");
  vi.stubEnv("BROWSERBASE_PROJECT_ID", "project-secret");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" })));
  api.getContext.mockReset().mockResolvedValue({ id: "context-1", projectId: "project-secret" });
  api.createSession.mockReset();
  api.createClient.mockReset().mockReturnValue(api);
  argv = project();
});
afterEach(() => {
  expect(api.createSession).not.toHaveBeenCalled();
  resetProjectConfigForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("Browserbase doctor", () => {
  it("checks stored context offline without API calls or local login credentials", async () => {
    saved();
    const report = await collectDoctorReport(argv);
    expect(report.ok, JSON.stringify(report.checks.filter((entry: any) => entry.status === "fail"))).toBe(true);
    expect(find(report, "demo · Browserbase auth").detail).toContain("not verified live");
    expect(find(report, "session profile")).toBeUndefined();
    expect(find(report, "credentials")).toBeUndefined();
    expect(find(report, "@playwright/test").status).toBe("pass");
    expect(api.createClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toMatch(/key-secret|project-secret|STAGING_QA_PASSWORD/);
  });
  it.each(["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"])("fails missing %s without revealing values", async key => {
    vi.stubEnv(key, " ");
    const report = await collectDoctorReport(argv);
    expect(find(report, key).status).toBe("fail");
    expect(JSON.stringify(report)).not.toMatch(/key-secret|project-secret/);
  });
  it("requires a saved session rather than staging passwords", async () => {
    vi.stubEnv("STAGING_QA_EMAIL", "private@example.test");
    vi.stubEnv("STAGING_QA_PASSWORD", "password-secret");
    const report = await collectDoctorReport(argv);
    const auth = find(report, "demo · Browserbase auth");
    expect(auth.status).toBe("fail");
    expect(auth.hint).toContain("login --browser-provider=browserbase");
    expect(auth.hint).toContain("--success-url");
    expect(JSON.stringify(report)).not.toMatch(/private@example.test|password-secret/);
  });
  it("accepts configured storageState without claiming live login", async () => {
    writeFileSync(join(root, "state.json"), '{"cookies":[],"origins":[]}');
    const report = await collectDoctorReport(project(true, "state.json"));
    expect(find(report, "demo · Browserbase auth").status).toBe("pass");
    expect(find(report, "demo · Browserbase auth").detail).toContain("not verified live");
  });
  it("does not require saved auth for public pages", async () => {
    const report = await collectDoctorReport(project(false));
    expect(find(report, "demo · Browserbase auth").status).toBe("skip");
  });
  it("uses project root, target origin and selected profile for contexts", async () => {
    saved("account");
    expect(find(await collectDoctorReport(argv), "demo · Browserbase auth").status).toBe("fail");
    expect(find(await collectDoctorReport([...argv, "--browserbase-profile=account"]), "demo · Browserbase auth").status).toBe("pass");
  });
  it("does not accept another origin's saved context", async () => {
    saved("default", "https://other.example.test");
    expect(find(await collectDoctorReport(argv), "demo · Browserbase auth").status).toBe("fail");
  });
  it("validates only context existence remotely on opt-in", async () => {
    saved();
    const report = await collectDoctorReport([...argv, "--check-network"]);
    expect(api.getContext).toHaveBeenCalledWith("context-1");
    expect(find(report, "demo · Browserbase context remote").status).toBe("pass");
    expect(find(report, "demo · Browserbase auth").detail).toContain("not verified live");
  });
  it.each([null, { id: "context-1", projectId: "wrong-project" }, { id: "wrong-context" }])("rejects missing or mismatched remote context %j", async context => {
    saved();
    api.getContext.mockResolvedValue(context);
    const report = await collectDoctorReport([...argv, "--check-network"]);
    expect(find(report, "demo · Browserbase context remote").status).toBe("fail");
  });
  it("accepts remote context without optional projectId", async () => {
    saved();
    api.getContext.mockResolvedValue({ id: "context-1" });
    expect(find(await collectDoctorReport([...argv, "--check-network"]), "demo · Browserbase context remote").status).toBe("pass");
  });
  it("sanitizes remote errors", async () => {
    saved();
    api.getContext.mockRejectedValue(new Error("key-secret project-secret"));
    const report = await collectDoctorReport([...argv, "--check-network"]);
    expect(find(report, "demo · Browserbase context remote").status).toBe("fail");
    expect(JSON.stringify(report)).not.toMatch(/key-secret|project-secret/);
  });
  it("skips remote validation without context and does not claim valid API credentials", async () => {
    const report = await collectDoctorReport([...project(false), "--check-network"]);
    const remote = find(report, "demo · Browserbase context remote");
    expect(remote.status).toBe("skip");
    expect(remote.detail).toContain("not verified");
    expect(api.createClient).not.toHaveBeenCalled();
  });
  it.each(["--cdp-url=wss://secret.test", "--cdp-url", "--credentials-in-prompt"])("rejects conflicting option %s", async flag => {
    expect(find(await collectDoctorReport([...argv, flag]), "Browserbase options").status).toBe("fail");
  });
  it("rejects a CDP environment URL without exposing it", async () => {
    vi.stubEnv("QA_BROWSER_CDP_URL", "wss://private-token.test");
    const report = await collectDoctorReport(argv);
    expect(find(report, "Browserbase options").status).toBe("fail");
    expect(JSON.stringify(report)).not.toContain("private-token");
  });
  it("requires adapter cdp-attach capability", async () => {
    vi.stubEnv("QA_AGENT_AUTH", "credentials-in-prompt");
    expect(find(await collectDoctorReport(argv), "Browserbase adapter auth").status).toBe("fail");
  });
  it("honors environment provider selection", async () => {
    vi.stubEnv("QA_BROWSER_PROVIDER", "browserbase");
    expect(find(await collectDoctorReport(argv.slice(0, -1)), "BROWSERBASE_API_KEY").status).toBe("pass");
  });
  it("does not accept a missing storageState file", async () => {
    expect(find(await collectDoctorReport(project(true, "missing.json")), "demo · Browserbase auth").status).toBe("fail");
  });
  it("reports malformed context registry without disclosing its contents", async () => {
    saved();
    writeFileSync(join(root, ".private", "qa-browserbase-contexts.json"), "key-secret invalid-json");
    const report = await collectDoctorReport(argv);
    expect(find(report, "demo · Browserbase context").status).toBe("fail");
    expect(JSON.stringify(report)).not.toContain("key-secret");
  });
  it("does not call API with missing credentials even on network opt-in", async () => {
    saved();
    vi.stubEnv("BROWSERBASE_API_KEY", "");
    const report = await collectDoctorReport([...argv, "--check-network"]);
    expect(find(report, "demo · Browserbase context remote").status).toBe("skip");
    expect(api.createClient).not.toHaveBeenCalled();
  });
  it("requires local Playwright peer for Browserbase but preserves local optional-peer warning", async () => {
    vi.resetModules();
    vi.doMock("@playwright/test", () => { throw new Error("peer missing"); });
    try {
      const { collectDoctorReport: doctor } = await import("../run-qa-doctor.mjs");
      expect(find(await doctor(argv), "@playwright/test").status).toBe("fail");
      expect(find(await doctor([...argv.slice(0, -1), "--browser-provider=local"]), "@playwright/test").status).toBe("warn");
    } finally {
      vi.doUnmock("@playwright/test");
      const { resetProjectConfigForTests: reset } = await import("../hermes-qa-project-config.mjs");
      reset();
      vi.resetModules();
    }
  });
});
