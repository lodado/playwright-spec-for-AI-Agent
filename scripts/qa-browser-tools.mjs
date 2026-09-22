import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { captureSettledEvidence } from "./qa-evidence.mjs";
import { redactSensitiveText } from "./agent-output.mjs";

/** The runner owns the browser and artifacts; the model can request only these two operations. */
export async function startQaBrowserTools({ session, plannedChecks, allowedOrigins = [], allowedUrls = [], evidenceDir = null, label = "qa", secrets = [] }) {
  const checks = new Map(plannedChecks.map(check => [check.checkId, check]));
  if (checks.size !== plannedChecks.length) throw new Error("Duplicate tool check IDs.");
  const files = new Map();
  for (const check of plannedChecks) for (const path of Object.values(check.uploadFixtures ?? {})) {
    if (files.has(path)) continue;
    const buffer = readFileSync(path);
    files.set(path, { buffer, filename: basename(path), size: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") });
  }
  const token = randomBytes(32).toString("hex");
  const evidence = session.evidence ??= {};
  for (const key of ["screenshots", "ariaSnapshots", "violations", "checkpoints", "uploads"]) evidence[key] ??= [];
  const receipts = new Map();
  let sequence = 0;
  let queue = Promise.resolve();
  let closing = false;

  async function capture(page, checkId) {
    if (!evidenceDir) return { checkId, url: page.url(), evidenceRefs: [] };
    const captured = await captureSettledEvidence({ pages: () => [page] }, evidenceDir, `${label}-checkpoint-${++sequence}`);
    for (const key of ["screenshots", "ariaSnapshots", "violations"]) evidence[key].push(...captured[key]);
    const checkpoint = { checkId, url: page.url(), evidenceRefs: [...captured.screenshots, ...captured.ariaSnapshots] };
    evidence.checkpoints.push(checkpoint);
    if (!checkpoint.evidenceRefs.length) throw new Error("No checkpoint artifacts could be captured.");
    return checkpoint;
  }

  async function execute(input) {
    if (!input || !["capture", "upload"].includes(input.action) || !checks.has(input.checkId)) throw new Error("Unknown action or check ID.");
    if (typeof input.url !== "string" || (!allowedUrls.includes(input.url) && !allowedOrigins.includes(new URL(input.url).origin))) throw new Error("Target URL is not allowed.");
    const pages = session.context.pages().filter(page => page.url() === input.url && !page.isClosed());
    if (pages.length !== 1) throw new Error("Expected exactly one open tab at the requested URL. Refresh the browser snapshot.");
    const page = pages[0];
    if (input.action === "capture") return capture(page, input.checkId);
    const check = checks.get(input.checkId);
    if (check.liveRunPolicy !== "executable-interaction") throw new Error("This check does not authorize a file upload.");
    if (typeof input.fixture !== "string" || !Object.hasOwn(check.uploadFixtures ?? {}, input.fixture)) throw new Error("Fixture is not declared for this check.");
    const key = JSON.stringify([input.checkId, input.fixture]);
    if (receipts.has(key)) return receipts.get(key);
    const path = check.uploadFixtures[input.fixture];
    const file = files.get(path);
    const selector = input.selector ?? 'input[type="file"]';
    if (typeof selector !== "string" || selector.length > 1024) throw new Error("Invalid file input selector.");
    const locator = page.locator(selector);
    if (await locator.count() !== 1) throw new Error("Expected exactly one file input. Supply its exact selector.");
    const inputElement = await locator.elementHandle({ timeout: 5000 });
    if (!inputElement) throw new Error("File input disappeared; refresh the snapshot.");
    try {
      // Pin the element: selector re-resolution could enter a foreign frame or a new document.
      if (await inputElement.ownerFrame() !== page.mainFrame()) throw new Error("Only main-frame file inputs are allowed.");
      if (!await inputElement.evaluate(el => el.tagName === "INPUT" && el.type === "file")) throw new Error("Expected a file input.");
      if (page.url() !== input.url) throw new Error("The page navigated before upload; refresh the snapshot.");
      // Once dispatch starts it must not be retried blindly, even if the browser disconnects.
      receipts.set(key, { checkId: input.checkId, error: "Upload outcome is unknown; automatic retry is blocked." });
      await inputElement.setInputFiles({ name: file.filename, mimeType: ({ ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".txt": "text/plain", ".csv": "text/csv" })[extname(file.filename).toLowerCase()] ?? "application/octet-stream", buffer: file.buffer }, { timeout: 10000 });
      const receipt = { receiptId: `upload_${evidence.uploads.length + 1}`, checkId: input.checkId, fixture: input.fixture,
        path, filename: file.filename, size: file.size, sha256: file.sha256, url: input.url,
        note: "Declared bytes attached to the file input. Application completion still requires UI evidence." };
      if (evidenceDir) {
        receipt.receiptPath = join(evidenceDir, `${label}-${receipt.receiptId}.json`);
        writeFileSync(receipt.receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
      }
      evidence.uploads.push(receipt);
      receipts.set(key, receipt);
      return receipt;
    } finally { await inputElement.dispose(); }
  }

  const server = createServer(async (req, res) => {
    const respond = (status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    const supplied = Buffer.from(String(req.headers.authorization ?? ""));
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.headers.origin || req.headers.host !== new URL(url).host || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return respond(403, { error: "Forbidden" });
    if (closing || req.method !== "POST" || req.url !== "/") return respond(405, { error: "Only tool POST requests are accepted." });
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 8192) { respond(413, { error: "Tool request too large." }); return; }
      }
      const input = JSON.parse(body);
      const operation = queue.then(() => execute(input));
      queue = operation.catch(() => {});
      respond(200, await operation);
    } catch (error) {
      respond(400, { error: redactSensitiveText(error.message, [token, session.cdpUrl, ...secrets].filter(Boolean)) });
    }
  });
  server.requestTimeout = 30000;
  let url;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${server.address().port}/`;
  return {
    url, token,
    async close() {
      closing = true;
      await queue;
      await new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
    },
  };
}
