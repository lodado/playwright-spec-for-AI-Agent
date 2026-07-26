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

test("variant comparison computes recurrence within each variant", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-variant-"));
  const variantStudy = structuredClone(study);
  variantStudy.personas = [{ preset: "careful_business_buyer" }];
  variantStudy.runtime.seeds = [101];
  variantStudy.tasks[0].successOracles = [{ id: "done", type: "visible_text", operation: "contains", value: "Complete" }];
  variantStudy.comparison = {
    baseline: { id: "baseline", baseUrl: "https://baseline.test" },
    candidate: { id: "candidate", baseUrl: "https://candidate.test" },
    assignment: "paired",
    counterbalanceOrder: true,
    metrics: ["task_completion", "finding_recurrence"],
  };
  const completed = await runPersonaStudy({
    study: variantStudy,
    outputDir: root,
    driverFactory: () => variantDriver(),
    policyFactory: () => {
      let attempted = false;
      return {
        sampledPolicy: { seed: 1 },
        decide() {
          if (!attempted) { attempted = true; return { type: "click", elementId: "submit", reasonCode: "try_submit" }; }
          return { type: "finish", reasonCode: "done" };
        },
      };
    },
  });
  const sharedFinding = completed.findings.find(finding => finding.affectedSessionIds.length === 2);
  assert.ok(sharedFinding);
  assert.equal(sharedFinding.maturity, "reproduced_synthetic_finding");
  assert.equal(completed.variant.baseline.recurringFindingCount, 0);
  assert.equal(completed.variant.candidate.recurringFindingCount, 0);
  assert.ok(completed.variant.findingIds.length > 0);
  assert.equal(completed.variant.delta.confidence.orderConsistency, "not_available");
  assert.match(await readFile(join(root, "reports/report.html"), "utf8"), /&quot;orderConsistency&quot;:\s*&quot;not_available&quot;/);
  await rm(root, { recursive: true, force: true });
});

test("checked oracle requires captured checked state", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-checked-"));
  const checkedStudy = structuredClone(study);
  checkedStudy.personas = [{ preset: "careful_business_buyer" }];
  checkedStudy.tasks[0].successOracles = [{ id: "accepted", type: "element", role: "checkbox", state: "checked" }];
  const completed = await runPersonaStudy({
    study: checkedStudy,
    outputDir: root,
    driverFactory: () => ({
      ...fakeDriver(),
      async observe() {
        const observation = await fakeDriver().observe();
        observation.semantic.interactiveElements = [{ id: "terms", role: "checkbox", checked: false, visible: true }];
        return observation;
      },
    }),
    policyFactory: () => ({ sampledPolicy: { seed: 1 }, decide: () => ({ type: "finish", reasonCode: "done" }) }),
  });
  assert.notEqual(completed.sessions[0].session.status, "success");
  await rm(root, { recursive: true, force: true });
});

test("study artifacts redact fixture secrets while drivers receive in-memory values", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-secret-"));
  const secretStudy = structuredClone(study);
  secretStudy.environment.fixtures = { "secret:email": "private@example.test" };
  secretStudy.environment.auth = { token: "auth-secret" };
  secretStudy.environment.storageStatePath = "/private/auth-state.json";
  const receivedValueRefs = [];
  await runPersonaStudy({
    study: secretStudy,
    outputDir: root,
    driverFactory: () => ({
      ...fakeDriver(),
      async start(input) { receivedValueRefs.push(input.valueRefs); return {}; },
    }),
    policyFactory: () => ({ sampledPolicy: { seed: 1 }, decide: () => ({ type: "finish", reasonCode: "done" }) }),
  });
  const persisted = JSON.parse(await readFile(join(root, "study.json"), "utf8"));
  assert.deepEqual(persisted.environment.fixtures, { "secret:email": "[REDACTED]" });
  assert.equal(JSON.stringify(persisted).includes("private@example.test"), false);
  assert.equal(JSON.stringify(persisted).includes("auth-secret"), false);
  assert.equal(persisted.environment.storageStatePath, "[REDACTED]");
  assert.equal(receivedValueRefs[0]["secret:email"], "private@example.test");
  await rm(root, { recursive: true, force: true });
});

test("tampered file evidence becomes runtime_error instead of pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-tampered-file-"));
  const oneSessionStudy = structuredClone(study);
  oneSessionStudy.personas = [{ preset: "careful_business_buyer" }];
  let evidenceDir;
  const completed = await runPersonaStudy({
    study: oneSessionStudy,
    outputDir: root,
    driverFactory: () => ({
      ...fakeDriver(),
      async start(input) {
        evidenceDir = input.evidenceDir;
        await writeFile(join(evidenceDir, "artifact.txt"), "tampered", "utf8");
        return {};
      },
      async observe() {
        const observation = await fakeDriver().observe();
        observation.evidence[0] = { ...observation.evidence[0], relativePath: "artifact.txt", byteSize: 8 };
        return observation;
      },
    }),
    policyFactory: () => ({ sampledPolicy: { seed: 1 }, decide: () => ({ type: "finish", reasonCode: "done" }) }),
  });
  assert.equal(completed.sessions[0].functionalEvaluation.status, "runtime_error");
  assert.equal(completed.report.summary.status, "runtime_error");
  await rm(root, { recursive: true, force: true });
});

test("semanticSnapshot off cannot produce a reported success without sealed observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-no-semantic-"));
  const noSemanticStudy = structuredClone(study);
  noSemanticStudy.personas = [{ preset: "careful_business_buyer" }];
  noSemanticStudy.evidence.semanticSnapshot = "off";
  const completed = await runPersonaStudy({ study: noSemanticStudy, outputDir: root, driverFactory: () => fakeDriver() });
  assert.equal(completed.sessions[0].session.status, "success");
  assert.notEqual(completed.sessions[0].functionalEvaluation.status, "success");
  assert.equal(completed.report.outcomes.some(outcome => outcome.status === "success"), false);
  await rm(root, { recursive: true, force: true });
});

test("regex oracles reject nested quantifiers and oversized patterns or inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-regex-"));
  const cases = [
    { pattern: "(a+)+$", text: "a".repeat(1_000), error: /nested or repeated quantifiers/ },
    { pattern: "(a|aa)+$", text: "a".repeat(1_000), error: /nested or repeated quantifiers/ },
    { pattern: "a++", text: "a", error: /nested or repeated quantifiers/ },
    { pattern: "a".repeat(257), text: "a", error: /pattern exceeds 256/ },
    { pattern: "a", text: "a".repeat(10_001), error: /input exceeds 10000/ },
  ];
  for (const [index, fixture] of cases.entries()) {
    const regexStudy = structuredClone(study);
    regexStudy.tasks[0].successOracles = [{ id: "unsafe", type: "visible_text", operation: "matches", value: fixture.pattern }];
    const completed = await runPersonaStudy({
      study: regexStudy,
      outputDir: join(root, String(index)),
      driverFactory: () => ({
        ...fakeDriver(),
        async observe() { return { ...(await fakeDriver().observe()), semantic: { visibleText: [fixture.text], headings: [], landmarks: [], interactiveElements: [] } }; },
      }),
    });
    assert.ok(completed.sessions.every(item => item.session.status === "runtime_error"));
    assert.match(completed.sessions[0].session.terminalReason.message, fixture.error);
  }
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

function variantDriver() {
  return {
    async start() { return {}; },
    async observe() {
      return {
        page: { url: "https://example.test/task", title: "Task", viewport: { width: 390, height: 844 } },
        semantic: {
          visibleText: ["Ready"],
          headings: [],
          landmarks: [],
          interactiveElements: [{ id: "submit", role: "button", name: "Submit", visible: true, enabled: true, viewportPosition: { inViewport: true } }],
        },
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
