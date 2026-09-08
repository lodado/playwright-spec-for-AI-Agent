import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { runBrowserbaseAgent } from "../browserbase-agent-runner.mjs";
import { launchBrowserbaseSession } from "../browser-provider.mjs";

// Real Chromium, real CDP and the real synchronous exec adapter. Only cloud REST
// allocation/release are stubbed. Running exec on the provider thread hangs the
// newly created tab: the provider cannot service Chromium auto-attach events.
describe("Browserbase isolated process with synchronous exec and real local CDP", () => {
  it("navigates an agent-created tab without disconnecting the provider", async test => {
    if (!existsSync(chromium.executablePath())) {
      test.skip("Local Chromium is not installed. No cloud browser is used by this test.");
      return;
    }
    const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR || tmpdir(), "bb-worker-cdp-"));
    const profile = join(root, "chromium");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><h1>Worker CDP navigation succeeded</h1>");
    });
    let owner: BrowserContext | undefined;
    let session: Awaited<ReturnType<typeof launchBrowserbaseSession>> | undefined;
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Missing loopback address");
      const origin = `http://127.0.0.1:${address.port}`;
      owner = await chromium.launchPersistentContext(profile, {
        headless: true, timeout: 5000,
        args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
      });
      const [port, suffix] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
      const cdpUrl = `ws://127.0.0.1:${port}${suffix}`;
      vi.stubEnv("BROWSERBASE_API_KEY", "SYNTHETIC_CDP_WORKER_SECRET");
      const client = {
        createSession: async () => ({ id: "local-session", connectUrl: cdpUrl }),
        releaseSession: vi.fn(async () => ({ id: "local-session", status: "COMPLETED" })),
      };
      session = await launchBrowserbaseSession({ root, projectId: "local-project", origin, client });
      const agentFile = join(root, "agent.mjs");
      const playwright = createRequire(import.meta.url).resolve("@playwright/test");
      writeFileSync(agentFile, `
        import { createRequire } from 'node:module';
        const { chromium } = createRequire(import.meta.url)(${JSON.stringify(playwright)});
        setTimeout(() => process.exit(9), 10000).unref();
        const browser = await chromium.connectOverCDP(process.env.BROWSER_CDP_URL, {timeout:5000});
        const page = await browser.contexts()[0].newPage();
        await page.goto(${JSON.stringify(origin)}, {timeout:5000});
        const heading = await page.locator('h1').textContent();
        console.log(JSON.stringify({status:'pass', heading,
          keyMissing:process.env.BROWSERBASE_API_KEY === undefined,
          endpoint:process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT}));
        await browser.close();
      `);
      vi.stubEnv("QA_AI_ADAPTER", "exec");
      vi.stubEnv("QA_AGENT_AUTH", "cdp-attach");
      vi.stubEnv("QA_AGENT_CMD", `${JSON.stringify(process.execPath)} ${JSON.stringify(agentFile)}`);
      vi.stubEnv("QA_AGENT_TIMEOUT_MS", "10000");
      const result = await runBrowserbaseAgent(session, "Inspect the local heading", null, { requiredKeys: ["status"] });
      expect(result).toMatchObject({ status: "pass", heading: "Worker CDP navigation succeeded", keyMissing: true, endpoint: "[redacted]" });
      expect(result.agentMeta.adapter).toBe("exec");
      expect(client.releaseSession).not.toHaveBeenCalled();
      expect(await session.context.pages().at(-1)!.locator("h1").textContent()).toBe("Worker CDP navigation succeeded");
      await session.close();
      expect(client.releaseSession).toHaveBeenCalledTimes(1);
    } finally {
      try { await session?.close(); }
      finally {
        try { await owner?.close(); }
        finally {
          server.closeAllConnections();
          if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
          vi.unstubAllEnvs();
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  }, 30_000);
});
