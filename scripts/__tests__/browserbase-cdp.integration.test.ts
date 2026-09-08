import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect as browserExpect, type Browser, type BrowserContext } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { launchBrowserbaseSession } from "../browser-provider.mjs";

// Representative production-wrapper integration, NOT Browserbase cloud acceptance.
// Only the cloud API is stubbed. Both CDP clients and all evidence use real Chromium.
// A second Playwright client models the agent without depending on agent-browser CLI.
describe("Browserbase provider with real local CDP (cloud API stub)", () => {
  it("shares the existing context and captures real evidence before release", async (test) => {
    const executablePath = chromium.executablePath();
    if (!existsSync(executablePath)) {
      test.skip(`Chromium binary missing at ${executablePath}. Run npx playwright install chromium.`);
      return;
    }

    const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR || tmpdir(), "bb-cdp-integration-"));
    const profile = join(root, "isolated-chromium-profile");
    const html = readFileSync(new URL("../../examples/demo-app/index.html", import.meta.url));
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    });
    let owner: BrowserContext | undefined;
    let agent: Browser | undefined;
    let session: Awaited<ReturnType<typeof launchBrowserbaseSession>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected local HTTP listener");
      const origin = `http://127.0.0.1:${address.port}`;
      owner = await chromium.launchPersistentContext(profile, {
        executablePath,
        headless: true,
        timeout: 10_000,
        args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
      });
      owner.setDefaultTimeout(5_000);
      const endpointFile = join(profile, "DevToolsActivePort");
      await browserExpect.poll(() => existsSync(endpointFile), { timeout: 5_000 }).toBe(true);
      const [port, websocketPath] = readFileSync(endpointFile, "utf8").trim().split(/\r?\n/);
      expect(Number(port)).toBeGreaterThan(0);
      expect(websocketPath).toMatch(/^\/devtools\/browser\//);
      const cdpUrl = `ws://127.0.0.1:${port}${websocketPath}`;
      const cookie = {
        name: "seeded_http_only_session", value: "local-integration-only", url: origin,
        httpOnly: true, secure: false, sameSite: "Lax" as const,
      };
      await owner.addCookies([cookie]);
      const originalPage = owner.pages()[0] || await owner.newPage();
      await originalPage.goto(origin, { waitUntil: "domcontentloaded", timeout: 5_000 });
      await originalPage.evaluate(() => { document.body.dataset.contextWitness = "preexisting-page"; });

      const client = {
        createSession: vi.fn(async () => ({ id: "local-session", connectUrl: cdpUrl })),
        releaseSession: vi.fn(async () => ({ id: "local-session", status: "COMPLETED" })),
        getSession: vi.fn(async () => ({ id: "local-session", status: "COMPLETED" })),
      };
      // Do not inject connect or chromiumFactory: exercise both production defaults.
      session = await launchBrowserbaseSession({
        root, projectId: "local-project", origin, client,
        evidenceDir: join(root, "evidence"), label: "real-cdp", timeoutSeconds: 60,
      });
      session.context.setDefaultTimeout(5_000);
      expect(session.attached).toBe(true);
      expect(client.createSession).toHaveBeenCalledExactlyOnceWith({ contextId: undefined, persist: false, timeout: 60 });
      expect(session.context.pages()).toHaveLength(1);
      const attachedPage = session.context.pages()[0];
      expect(attachedPage.url()).toBe(originalPage.url());
      expect(await attachedPage.getAttribute("body", "data-context-witness")).toBe("preexisting-page");
      expect(await session.context.cookies(origin)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: cookie.name, value: cookie.value, httpOnly: true }),
      ]));
      expect(await attachedPage.evaluate(() => document.cookie)).not.toContain(cookie.name);

      agent = await chromium.connectOverCDP(cdpUrl, { timeout: 5_000 });
      expect(agent.contexts()).toHaveLength(1);
      const agentContext = agent.contexts()[0];
      agentContext.setDefaultTimeout(5_000);
      expect(agentContext.pages()).toHaveLength(1);
      const agentPage = agentContext.pages()[0];
      expect(await agentContext.cookies(origin)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: cookie.name, value: cookie.value, httpOnly: true }),
      ]));
      expect(await agentPage.evaluate(() => document.cookie)).not.toContain(cookie.name);
      await browserExpect(attachedPage.getByTestId("plan-details")).toBeHidden();
      await agentPage.getByTestId("plan-details-btn").click();
      await browserExpect(attachedPage.getByTestId("plan-details-btn")).toHaveAttribute("aria-expanded", "true");
      await browserExpect(originalPage.getByTestId("plan-details")).toBeVisible();
      // Also prove state flows back from the provider to the independent agent.
      await attachedPage.getByTestId("plan-details-btn").click();
      await browserExpect(agentPage.getByTestId("plan-details")).toBeHidden();
      await agentPage.getByTestId("plan-details-btn").click();
      await agentPage.getByTestId("email").fill("nobody@example.test");
      await agentPage.getByTestId("password").fill("deliberately-invalid");
      await agentPage.getByRole("button", { name: "Sign in", exact: true }).click();
      await browserExpect(attachedPage.getByTestId("login-error")).toBeVisible();
      await browserExpect(originalPage.getByTestId("login-error")).toHaveText("Email or password is incorrect.");

      expect(session.metadata).toEqual({
        name: "browserbase", sessionId: "local-session", contextId: null,
        dashboardUrl: "https://www.browserbase.com/sessions/local-session",
      });
      expect(JSON.stringify(session.metadata)).not.toContain(cdpUrl);
      const evidence = await session.close();
      expect(await session.close()).toEqual(evidence);
      expect(client.releaseSession).toHaveBeenCalledExactlyOnceWith("local-session");
      expect(client.getSession).not.toHaveBeenCalled();
      expect(evidence.browserProvider).toEqual(session.metadata);
      expect(JSON.stringify(evidence)).not.toContain(cdpUrl);
      expect(evidence.violations.filter(({ kind }: { kind: string }) =>
        kind === "capture-failed" || kind === "session-close-failed")).toEqual([]);
      expect(evidence.screenshots).toHaveLength(1);
      expect(evidence.ariaSnapshots).toHaveLength(1);
      for (const file of [...evidence.screenshots, ...evidence.ariaSnapshots, evidence.tracePath]) {
        expect(typeof file).toBe("string");
        expect(statSync(file).size).toBeGreaterThan(0);
      }
      expect(readFileSync(evidence.screenshots[0]).subarray(0, 8))
        .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const aria = readFileSync(evidence.ariaSnapshots[0], "utf8");
      expect(aria).toContain("Acme Demo");
      expect(aria).toContain("Email or password is incorrect.");
      expect(aria).toContain("12 of 20");
      expect(readFileSync(evidence.tracePath).subarray(0, 4)).toEqual(Buffer.from([80, 75, 3, 4]));
      // macOS/Linux utility only, not an npm/runtime dependency. Checks every ZIP CRC.
      if (existsSync("/usr/bin/unzip")) {
        expect(execFileSync("/usr/bin/unzip", ["-t", evidence.tracePath], { encoding: "utf8", timeout: 5_000 }))
          .toContain("No errors detected");
        expect(execFileSync("/usr/bin/unzip", ["-Z1", evidence.tracePath], { encoding: "utf8", timeout: 5_000 }))
          .toMatch(/\.trace\b/);
      } else {
        console.warn("Trace ZIP CRC validation unavailable: /usr/bin/unzip is not installed. Header and nonempty artifacts were checked.");
      }
      expect(readdirSync(join(root, ".private")).filter(name => name.endsWith(".lock"))).toEqual([]);
      // Production close disconnects its CDP client, not the operator-owned browser.
      await browserExpect(agentPage.getByTestId("login-error")).toBeVisible();
      expect(owner.pages()).toHaveLength(1);
    } finally {
      // Nested finally ensures later resources are cleaned even when an earlier close fails.
      try { await session?.close(); }
      finally {
        try { await agent?.close(); }
        finally {
          try { await owner?.close(); }
          finally {
            try {
              server.closeAllConnections();
              if (server.listening) await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
              });
            } finally { rmSync(root, { recursive: true, force: true }); }
          }
        }
      }
    }
  }, 30_000);
});
