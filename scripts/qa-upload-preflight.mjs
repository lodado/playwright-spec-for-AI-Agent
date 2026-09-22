import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { EnvironmentError } from "./errors.mjs";
import { collectUniqueUploadFixtures } from "./qa-spec-judge-document.mjs";
import { runBrowserbaseAgent } from "./browserbase-agent-runner.mjs";
import { startQaBrowserTools } from "./qa-browser-tools.mjs";
import { redactSensitiveText } from "./agent-output.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const hint = "Check the fixture paths and the selected agent's file-upload tools (including terminal tools). Re-run doctor --check-upload. No product verdict was produced.";

export function inspectUploadFixtures(payload) {
  return collectUniqueUploadFixtures(payload).map(fixture => {
    try {
      if (!statSync(fixture.absPath).isFile()) throw new Error("not a regular file");
      const bytes = readFileSync(fixture.absPath);
      return { ...fixture, filename: basename(fixture.absPath), size: bytes.length, sha256: digest(bytes) };
    } catch (cause) {
      throw new EnvironmentError(`Upload fixture ${fixture.absPath}: ${cause.message}`, { hint, cause });
    }
  });
}

export function assertUploadAdapter(adapter) {
  if (adapter.capabilities.auth !== "cdp-attach") {
    throw new EnvironmentError("Upload preflight requires a cdp-attach adapter so the runner can verify the uploaded bytes independently.", { hint });
  }
}

async function localSession() {
  const { chromium } = await import("@playwright/test");
  const { findFreePort } = await import("./qa-browser-session.mjs");
  const port = await findFreePort();
  const context = await chromium.launchPersistentContext("", { args: [`--remote-debugging-port=${port}`] });
  return { context, cdpUrl: `http://127.0.0.1:${port}`, close: () => context.close() };
}

/** Probe Hermes's upload bridge or an external adapter, then verify browser file bytes. */
export async function preflightUploads(payload, { adapter, session = null, createSession = localSession } = {}) {
  const fixtures = inspectUploadFixtures(payload);
  if (!fixtures.length) return { count: 0 };
  assertUploadAdapter(adapter);
  let probe;
  let ownedSession;
  let browserTools;
  let url;
  try {
    session ??= ownedSession = await createSession();
    probe = await session.context.newPage();
    const html = `<title>QA upload preflight ${randomUUID()}</title>` + fixtures.map((_, i) =>
      `<label>Fixture ${i + 1}<input type="file" id="fixture-${i + 1}"></label>`).join("");
    url = `data:text/html,${encodeURIComponent(html)}`;
    await probe.goto(url);
    if (adapter.name === "hermes") {
      browserTools = await startQaBrowserTools({ session, allowedUrls: [url], plannedChecks: fixtures.map((file, i) => ({
        checkId: `fixture_${i + 1}`, liveRunPolicy: "executable-interaction", uploadFixtures: { upload: file.absPath },
      })) });
    }
    if (browserTools) {
      // Hermes attachment is runner-owned; probe it without a second model session.
      for (let i = 0; i < fixtures.length; i += 1) {
        const checkId = `fixture_${i + 1}`;
        const response = await fetch(browserTools.url, {
          method: "POST",
          headers: { authorization: `Bearer ${browserTools.token}`, "content-type": "application/json" },
          body: JSON.stringify({ action: "upload", checkId, url, fixture: "upload", selector: `#fixture-${i + 1}` }),
          signal: AbortSignal.timeout(30000),
        });
        const receipt = await response.json();
        if (!response.ok || receipt?.error || receipt?.checkId !== checkId || !receipt?.receiptId) {
          throw new Error(receipt?.error || "Invalid upload probe receipt.");
        }
      }
    } else {
      // External adapters still need to demonstrate their own upload tooling.
      await runBrowserbaseAgent(session, [
        "Upload capability preflight, not a product test. Use the attached browser only.",
        `Open this isolated page: ${url}`,
        ...fixtures.map((file, i) => `Upload local file ${JSON.stringify(file.absPath)} into input labelled "Fixture ${i + 1}".`),
        "Use your available file-upload or terminal tools.",
        "Do not synthesize file content or modify the DOM. Do not visit the application, submit anything, or close the page.",
        'Return JSON {"status":"pass"} after uploading, or {"status":"fail"} if the tools cannot upload.',
      ].join("\n"), 12, { mode: "browse", requiredKeys: ["status"] });
    }
    let verified = false;
    for (const page of session.context.pages()) {
      const uploaded = await page.evaluate(async expectedUrl => {
        if (location.href !== expectedUrl) return [];
        return Promise.all([...document.querySelectorAll('input[type="file"]')].map(async input => {
          const file = input.files?.[0];
          return file ? { name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) } : null;
        }));
      }, url);
      if (uploaded.length === fixtures.length && uploaded.every((file, i) => file &&
        file.name === fixtures[i].filename && file.bytes.length === fixtures[i].size &&
        digest(Buffer.from(file.bytes)) === fixtures[i].sha256)) verified = true;
    }
    if (!verified) throw new Error("The agent did not place the declared fixture bytes in the upload inputs.");
    return { count: fixtures.length };
  } catch (cause) {
    const detail = redactSensitiveText(cause.message, [session?.cdpUrl, ...(session?.secrets ?? [])].filter(Boolean));
    throw new EnvironmentError(`Upload preflight failed; judge was not started: ${detail}`, { hint, cause });
  } finally {
    try { await browserTools?.close(); }
    finally {
    try {
      const probes = new Set([probe, ...(session?.context.pages() ?? []).filter(page => url && page.url?.() === url)]);
      for (const page of probes) if (page && !page.isClosed?.()) await page.close();
    }
    finally { if (ownedSession) await ownedSession.close(); }
    }
  }
}
