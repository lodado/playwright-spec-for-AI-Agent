import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPrivateProfileDir,
  ensurePrivateProfileDir,
  findFreePort,
  hasSessionProfile,
  sessionProfilePath,
} from "../qa-browser-session.mjs";

const dirs: string[] = [];

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), "qa-session-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("qa browser session profile", () => {
  it("reports no session before login", () => {
    expect(hasSessionProfile(makeRoot())).toBe(false);
  });

  it("creates an owner-only profile directory", () => {
    const root = makeRoot();
    ensurePrivateProfileDir(root);

    expect(hasSessionProfile(root)).toBe(true);
    expect(() => assertPrivateProfileDir(root)).not.toThrow();
  });

  it("rejects a group- or world-readable profile", () => {
    const root = makeRoot();
    ensurePrivateProfileDir(root);
    chmodSync(sessionProfilePath(root), 0o755);

    expect(() => assertPrivateProfileDir(root)).toThrow(/owner-only/);
  });

  it("finds a free loopback port", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});
