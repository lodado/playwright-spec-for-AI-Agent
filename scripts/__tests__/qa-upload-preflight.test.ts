import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { inspectUploadFixtures, preflightUploads } from '../qa-upload-preflight.mjs';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../browserbase-agent-runner.mjs', () => ({ runBrowserbaseAgent: mocks.run }));
const root = mkdtempSync(join(tmpdir(), 'upload-preflight-test-'));
const file = join(root, 'sample.txt');
writeFileSync(file, 'fixture');
const payload = { defaults: { sample: file }, byCheckId: { one: { sample: file } } };
const adapter = { name: 'exec', capabilities: { auth: 'cdp-attach' } };
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

it('checks Hermes runner uploads without another model call', async () => {
  await expect(preflightUploads(payload, { adapter: { ...adapter, name: 'hermes' } })).resolves.toEqual({ count: 1 });
  expect(mocks.run).not.toHaveBeenCalled();
});

it.each([
  { receiptId: 'forged', checkId: 'fixture_1' },
  { error: 'Upload outcome is unknown' },
])('rejects an unverified Hermes bridge response: %j', async (receipt) => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(receipt));
  await expect(preflightUploads(payload, { adapter: { ...adapter, name: 'hermes' } })).rejects.toThrow(/Upload preflight failed/);
  expect(mocks.run).not.toHaveBeenCalled();
});

it('deduplicates paths and rejects missing files and directories', () => {
  expect(inspectUploadFixtures(payload)).toHaveLength(1);
  expect(() => inspectUploadFixtures({ defaults: { bad: root } })).toThrow(/regular file/);
  expect(() => inspectUploadFixtures({ defaults: { bad: join(root, 'missing') } })).toThrow(/fixture/i);
});

it('does nothing without fixtures, even for unsupported adapters', async () => {
  await preflightUploads({}, { adapter: { capabilities: {} } });
  expect(mocks.run).not.toHaveBeenCalled();
});

it('fails closed when the adapter cannot attach to the upload probe', async () => {
  await expect(preflightUploads(payload, { adapter: { capabilities: {} } })).rejects.toThrow(/cdp-attach/);
  expect(mocks.run).not.toHaveBeenCalled();
});

it('ignores an agent success claim without the actual fixture bytes; closes the probe', async () => {
  const page = { goto: vi.fn(), evaluate: vi.fn().mockResolvedValue([]), close: vi.fn() };
  const session = { context: { newPage: async () => page, pages: () => [page] }, cdpUrl: 'http://localhost:1234' };
  mocks.run.mockResolvedValue({ status: 'pass' });
  await expect(preflightUploads(payload, { adapter, session })).rejects.toThrow(/upload/i);
  expect(page.close).toHaveBeenCalledOnce();
});

it('accepts matching bytes and cleans up after a tool failure', async () => {
  const page = { goto: vi.fn(), evaluate: vi.fn().mockResolvedValue([{ name: 'sample.txt', bytes: [...Buffer.from('fixture')] }]), close: vi.fn() };
  const session = { context: { newPage: async () => page, pages: () => [page] }, cdpUrl: 'http://localhost:1234' };
  mocks.run.mockResolvedValue({ status: 'pass' });
  await expect(preflightUploads(payload, { adapter, session })).resolves.toEqual({ count: 1 });
  mocks.run.mockRejectedValue(new Error('tool unavailable'));
  await expect(preflightUploads(payload, { adapter, session })).rejects.toThrow(/upload preflight/i);
  expect(page.close).toHaveBeenCalledTimes(2);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

it('verifies an actual browser File and rejects same-sized wrong content', async () => {
  const { chromium } = await import('@playwright/test');
  mocks.run.mockImplementation(async (session: any, query: string) => {
    const browser = await chromium.connectOverCDP(session.cdpUrl);
    try {
      const page = browser.contexts()[0].pages().find(page => page.url().startsWith('data:'))!;
      expect(query).toContain(file);
      await page.getByLabel('Fixture 1').setInputFiles(file);
    } finally { await browser.close(); }
    return { status: 'pass' };
  });
  await expect(preflightUploads(payload, { adapter })).resolves.toEqual({ count: 1 });
  mocks.run.mockImplementation(async (session: any) => {
    const browser = await chromium.connectOverCDP(session.cdpUrl);
    try {
      const page = browser.contexts()[0].pages().find(page => page.url().startsWith('data:'))!;
      await page.getByLabel('Fixture 1').setInputFiles({ name: 'sample.txt', mimeType: 'text/plain', buffer: Buffer.from('WRONG!!') });
    } finally { await browser.close(); }
    return { status: 'pass' };
  });
  await expect(preflightUploads(payload, { adapter })).rejects.toThrow(/Upload preflight failed/);
}, 20000);
