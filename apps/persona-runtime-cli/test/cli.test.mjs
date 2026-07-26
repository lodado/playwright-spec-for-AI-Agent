import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import test from "node:test";
import { loadStudy, runCli, runPersonaStudy } from "../src/index.mjs";

const study = {
  schemaVersion: "study-spec/0.1",
  study: { id: "fixture", name: "Fixture" },
  product: { description: "Fixture" },
  environment: { baseUrl: "https://example.test", allowedOrigins: ["https://example.test"], viewport: { width: 390, height: 844 } },
  tasks: [{ id: "task", name: "Task", goal: "finish", successOracles: [{ id: "done", type: "visible_text", operation: "contains", value: "Done" }], safetyPolicy: { allowRead: true, allowNavigation: true, allowClick: true, allowTyping: false, allowFileUpload: false, allowStateMutation: false, allowExternalOrigin: false, forbiddenActions: ["payment"], stopBeforeConfirmation: true }, maxActions: 3, maxDurationMs: 10_000, maxConsecutiveNoProgressActions: 2, abandonmentAllowed: true }],
  personas: [{ preset: "impatient_new_user" }, { preset: "careful_business_buyer" }, { preset: "low_domain_knowledge_user" }],
  runtime: { seeds: [101], concurrency: 2, modelRoles: { action: "fake", evaluator: "fake" } },
  evidence: { screenshot: "every_action", trace: true, video: "on_failure", semanticSnapshot: "every_action" },
  evaluation: { minimumRecurrenceForFinding: 2, validityReport: true },
};

test("validate CLI accepts a versioned YAML study", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-cli-"));
  const path = join(root, "study.yaml");
  await writeFile(path, JSON.stringify(study), "utf8");
  const messages = [];
  assert.equal(await runCli(["validate", path], { log: message => messages.push(message) }), 0);
  assert.match(messages[0], /study-spec\/0.1/);
  await rm(root, { recursive: true, force: true });
});

test("import-playwright writes a valid StudySpec", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-import-"));
  const specDir = join(root, "specs");
  const output = join(root, "study.yaml");
  await mkdir(specDir);
  await writeFile(join(specDir, "dashboard.spec.ts"), `
// @qa-page: dashboard
// @qa-scenario: ACTIVE
import { expect, test } from "@playwright/test";
// @qa-live-policy: readonly
test("shows completion", async ({ page }) => {
  await expect(page.getByText("Done")).toBeVisible();
});
`, "utf8");
  assert.equal(await runCli([
    "import-playwright",
    `--spec-dir=${specDir}`,
    "--base-url=https://example.test",
    `--output=${output}`,
  ], { log() {} }), 0);
  assert.equal((await loadStudy(output)).provenance.source, "playwright-spec");
  await rm(root, { recursive: true, force: true });
});

test("fake sessions generate sealed JSON and HTML without a model", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-run-"));
  const completed = await runPersonaStudy({
    study,
    outputDir: root,
    driverFactory: () => fakeDriver(),
    policyFactory: () => ({ sampledPolicy: { seed: 1 }, decide: () => ({ type: "finish", reasonCode: "done" }) }),
  });
  assert.equal(completed.sessions.length, 3);
  assert.equal(completed.validity.calibration.level, "uncalibrated");
  assert.match(await readFile(join(root, "reports/report.html"), "utf8"), /Limitations \/ Validity/);
  await rm(root, { recursive: true, force: true });
});

test("real browser sessions cannot click the below-fold CTA before scrolling", async (context) => {
  try {
    const browser = await chromium.launch();
    await browser.close();
  } catch {
    context.skip("Chromium is not installed");
    return;
  }
  const app = await serveHiddenCta();
  const root = await mkdtemp(join(tmpdir(), "persona-browser-"));
  try {
    const liveStudy = structuredClone(study);
    liveStudy.environment.baseUrl = app.url;
    liveStudy.environment.allowedOrigins = [app.url];
    liveStudy.tasks[0].goal = "Open behavioral report";
    liveStudy.tasks[0].successOracles = [{ id: "done", type: "url", operation: "contains", value: "/complete" }];
    const completed = await runPersonaStudy({ study: liveStudy, outputDir: root });
    assert.equal(completed.sessions.length, 3);
    for (const session of completed.sessions) {
      assert.equal(session.manifest.sealed, true);
      assert.ok(session.manifest.entries.some(entry => entry.type === "trace"));
      const clickIndex = session.events.findIndex(event => event.action.type === "click");
      if (clickIndex >= 0) assert.ok(session.events.slice(0, clickIndex).some(event => event.action.type === "scroll"));
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

function fakeDriver() {
  return {
    async start() { return {}; },
    async observe() {
      return {
        page: { url: "https://example.test/done", title: "Done", viewport: { width: 390, height: 844 } },
        semantic: { visibleText: ["Done"], headings: [], landmarks: [], interactiveElements: [] },
        visual: { screenshotEvidenceId: "shot-1" },
        runtime: { consoleIssues: [], networkFailures: [], pendingRequestCount: 0, loadingIndicators: [] },
        evidence: [{ id: "shot-1", type: "screenshot", contentHash: "sha256:fake", metadata: {} }],
      };
    },
    async execute() { return { status: "success", evidenceIds: ["shot-1"], evidence: [] }; },
    async close() { return { evidence: [] }; },
  };
}

async function serveHiddenCta() {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(request.url === "/complete"
      ? "<!doctype html><title>Complete</title><h1>Behavioral report ready</h1>"
      : "<!doctype html><title>Fixture</title><main><h1>Upload complete</h1><div style='height:1050px'></div><a href='/complete'>Open behavioral report</a></main>");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
