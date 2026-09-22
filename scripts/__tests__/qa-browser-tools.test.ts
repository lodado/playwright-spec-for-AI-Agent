import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import { startQaBrowserTools } from '../qa-browser-tools.mjs';
import { normalizeBrowseDecision } from '../judge-verdict.mjs';
import { buildBrowseChecklist } from '../spec-annotation-reader.mjs';

const root = mkdtempSync(join(tmpdir(), 'qa-tools-test-'));
const fixture = join(root, 'fixture.txt');
writeFileSync(fixture, 'approved fixture bytes');
const checks = [{ checkId: 'chk_upload', item: 'upload a file', liveRunPolicy: 'executable-interaction', uploadFixtures: { upload: fixture } },
  { checkId: 'chk_read', item: 'read the dialog', liveRunPolicy: 'executable-readonly' }];
let browser: Browser;
let origin: string;
const app = createServer((_req, res) => res.end('<div role="dialog">Transient dialog</div><input type="file" onchange="window.uploads=(window.uploads||0)+1">'));
beforeAll(async () => {
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = app.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>(resolve => app.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

async function withTools(run: (state: any) => Promise<void>) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin);
  const session = { context, evidence: { screenshots: [], ariaSnapshots: [], violations: [] } };
  const tools = await startQaBrowserTools({ session, plannedChecks: checks, allowedOrigins: [origin], evidenceDir: root, label: 'test' });
  const call = async (body: object, headers: object = {}) => fetch(tools.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tools.token}`, ...headers }, body: JSON.stringify(body),
  });
  try { await run({ page, context, session, tools, call }); }
  finally { await tools.close(); await context.close(); }
}

it('does not let a selector escape into an iframe file input', async () => withTools(async ({ page, call }) => {
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.srcdoc = '<input type="file">'; document.body.append(frame); });
  await page.frameLocator('iframe').locator('input').waitFor({ state: 'attached' });
  const response = await call({ action: 'upload', checkId: 'chk_upload', fixture: 'upload', url: page.url(),
    selector: 'iframe >> internal:control=enter-frame >> input[type=file]' });
  expect(response.ok).toBe(false);
  expect(JSON.stringify(await response.json())).toContain('main-frame');
}));

it('binds upload receipts and intermediate snapshots to their own check', () => {
  const snapshot = join(root, 'owned.yaml');
  writeFileSync(snapshot, '- text: Upload complete');
  const other = { ...checks[0], checkId: 'chk_other' };
  const evidence = { ariaSnapshots: [snapshot], checkpoints: [{ checkId: 'chk_upload', evidenceRefs: [snapshot] }],
    uploads: [{ checkId: 'chk_upload', receiptId: 'upload_1', path: fixture, sha256: 'a'.repeat(64) }] };
  const decision = normalizeBrowseDecision({ checks: [checks[0], other].map(check => ({
    checkId: check.checkId, result: 'pass', detail: 'Saw "Upload complete"', evidenceRefs: [snapshot], uploadRefs: ['upload_1'],
  })) }, { plannedChecks: [checks[0], other], runnerEvidence: evidence });
  expect(decision.checks.map(check => check.result)).toEqual(['pass', 'manual_review']);
  expect(decision.checks[1].evidenceRefs).toEqual([]);
  expect(decision.checks[1].uploadRefs).toEqual([]);
});

it('does not turn available fixture defaults into a readonly upload requirement', () => {
  const snapshot = join(root, 'readonly.yaml');
  writeFileSync(snapshot, '- text: Readonly content');
  const planned = { ...checks[1], uploadFixtures: { upload: fixture }, requiredUploadFixtures: {} };
  const decision = normalizeBrowseDecision({ checks: [{ checkId: planned.checkId, result: 'pass', detail: 'Saw "Readonly content"' }] },
    { plannedChecks: [planned], runnerEvidence: { ariaSnapshots: [snapshot] } });
  expect(decision.status).toBe('pass');
});

it('carries inherited fixture capability separately from explicit upload requirements', () => {
  const checklist = buildBrowseChecklist({ scenarios: [{ scenarioId: 'S', fixtures: { upload: 'default.pdf' }, tests: [
    { title: 'read', liveRunPolicy: 'executable-readonly' },
    { title: 'upload', liveRunPolicy: 'executable-interaction', fixtures: { upload: 'override.pdf' } },
  ] }] });
  expect(checklist[0].fixtures).toEqual({ upload: 'default.pdf' });
  expect(checklist[0].requiredUploadFixtures).toBeUndefined();
  expect(checklist[1].fixtures).toEqual({ upload: 'override.pdf' });
  expect(checklist[1].requiredUploadFixtures).toEqual({ upload: 'override.pdf' });
});

it('retains per-check evidence after a transient dialog disappears', async () => withTools(async ({ page, session, call }) => {
  const captured = await (await call({ action: 'capture', checkId: 'chk_read', url: page.url() })).json();
  expect(captured.evidenceRefs.some((file: string) => file.endsWith('.yaml'))).toBe(true);
  await page.getByRole('dialog').evaluate((el: HTMLElement) => el.remove());
  expect(session.evidence.checkpoints[0].checkId).toBe('chk_read');
  expect(readFileSync(session.evidence.ariaSnapshots[0], 'utf8')).toContain('Transient dialog');
  const result = normalizeBrowseDecision({ checks: [{ checkId: 'chk_read', result: 'pass', detail: 'Saw "Transient dialog"' }] }, { plannedChecks: [checks[1]], runnerEvidence: session.evidence });
  expect(result.status).toBe('pass');
}));

it('uploads only declared bytes on the target page and does not duplicate a retry', async () => withTools(async ({ page, session, call }) => {
  const request = { action: 'upload', checkId: 'chk_upload', fixture: 'upload', url: page.url() };
  const first = await (await call(request)).json();
  expect(first.receiptId).toBeTruthy();
  expect(await page.locator('input').evaluate(async (el: HTMLInputElement) => el.files?.[0].text())).toBe('approved fixture bytes');
  expect(await (await call(request)).json()).toEqual(first);
  expect(await page.evaluate('window.uploads')).toBe(1);
  expect(session.evidence.uploads).toHaveLength(1);
  expect(session.evidence.uploads[0].sha256).toMatch(/^[0-9a-f]{64}$/);
}));

it('rejects forged IDs, undeclared files, cross-origin requests and browser-origin calls', async () => withTools(async ({ page, call }) => {
  for (const body of [
    { action: 'capture', checkId: 'forged', url: page.url() },
    { action: 'capture', checkId: 'chk_read', url: 'https://example.com' },
    { action: 'upload', checkId: 'chk_read', fixture: 'upload', url: page.url() },
    { action: 'upload', checkId: 'chk_upload', fixture: '/etc/passwd', url: page.url() },
  ]) expect((await call(body)).ok).toBe(false);
  const body = { action: 'capture', checkId: 'chk_read', url: page.url() };
  expect((await call(body, { Authorization: 'Bearer wrong' })).status).toBe(403);
  expect((await call(body, { Origin: origin })).status).toBe(403);
}));

it('refuses ambiguous tabs instead of silently capturing or uploading to the wrong one', async () => withTools(async ({ page, context, call }) => {
  await (await context.newPage()).goto(page.url());
  const result = await call({ action: 'upload', checkId: 'chk_upload', fixture: 'upload', url: page.url() });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(await result.json())).toMatch(/exactly one/i);
}));

it('does not accept an upload-dependent pass without a runner receipt', () => {
  const snapshot = join(root, 'completed.yaml');
  writeFileSync(snapshot, '- text: Upload complete');
  const raw = { checks: [{ checkId: 'chk_upload', result: 'pass', detail: 'Saw "Upload complete"', uploadRefs: ['invented'] }] };
  const result = normalizeBrowseDecision(raw, { plannedChecks: checks.slice(0, 1), runnerEvidence: { ariaSnapshots: [snapshot] } });
  expect(result.status).toBe('manual_review');
  expect(result.summary).toMatch(/upload.*receipt/i);
});
