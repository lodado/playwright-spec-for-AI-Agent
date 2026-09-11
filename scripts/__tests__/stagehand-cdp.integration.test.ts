import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { resolveStagehandDependency } from "../stagehand-runner.mjs";
import { resolveStagehandCdpUrl } from "../stagehand-process.mjs";

let sdkEntry: string | null = null;
try { sdkEntry = resolveStagehandDependency(); } catch { /* Optional peer is not required for other adapters. */ }
const available = sdkEntry !== null && existsSync(chromium.executablePath());

it.skipIf(!available)("Stagehand attaches via HTTP discovery, leaves live guards responsive, and disconnects without closing the browser", async () => {
  const { Stagehand } = await import(pathToFileURL(sdkEntry!).href);
  const server = createServer((_, response) => { response.setHeader("Content-Type", "text/html"); response.end("<title>QA fixture</title><h1>Local QA</h1>"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const root = mkdtempSync(join(tmpdir(), "stagehand-cdp-"));
  let context: any, stagehand: any;
  try {
    context = await chromium.launchPersistentContext(root, { headless: true, args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"] });
    const { readFileSync } = await import("node:fs");
    const debugPort = Number(readFileSync(join(root, "DevToolsActivePort"), "utf8").split("\n")[0]);
    const cdpUrl = await resolveStagehandCdpUrl(`http://127.0.0.1:${debugPort}`, 10000);
    let guarded = 0;
    await context.route("**/*", async (route: any) => { guarded += 1; await route.continue(); });
    stagehand = new Stagehand({ env: "LOCAL", disableAPI: true, disablePino: true, verbose: 0, logger: () => {}, model: { modelName: "openai/gpt-4.1-mini", apiKey: "unused-no-model-request" }, localBrowserLaunchOptions: { cdpUrl } });
    await stagehand.init();
    await stagehand.context.pages()[0].goto(`http://127.0.0.1:${port}`);
    expect(guarded).toBe(1);
    expect(await context.pages()[0].title()).toBe("QA fixture");
    await stagehand.close(); stagehand = null;
    expect(await context.pages()[0].title()).toBe("QA fixture");
  } finally {
    await stagehand?.close(); await context?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
