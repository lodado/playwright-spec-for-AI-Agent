import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertRealpathWithinRoot,
  resolveWithinRoot,
  runtimeDir,
} from "../src/index.js";

describe("resolveWithinRoot", () => {
  const root = "/project";

  it("resolves a relative path inside root", () => {
    expect(resolveWithinRoot(root, "src/a.css")).toBe(
      resolve(root, "src/a.css"),
    );
  });

  it("allows a nested traversal that stays inside root", () => {
    expect(resolveWithinRoot(root, "a/../b")).toBe(resolve(root, "b"));
  });

  it("rejects an absolute path", () => {
    expect(() => resolveWithinRoot(root, "/etc/passwd")).toThrow(/absolute/);
  });

  it("rejects traversal outside root", () => {
    expect(() => resolveWithinRoot(root, "../secrets")).toThrow(/escapes/);
  });

  it("rejects a null byte", () => {
    expect(() => resolveWithinRoot(root, `a${String.fromCharCode(0)}b`)).toThrow(/null byte/);
  });
});

describe("assertRealpathWithinRoot (symlink escape)", () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "dc-root-"));
    outside = mkdtempSync(join(tmpdir(), "dc-out-"));
    writeFileSync(join(outside, "secret.txt"), "s");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "ok.txt"), "ok");
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("accepts a real file inside root", () => {
    expect(() =>
      assertRealpathWithinRoot(root, join(root, "sub", "ok.txt")),
    ).not.toThrow();
  });

  it("rejects a symlink whose target escapes root", () => {
    expect(() =>
      assertRealpathWithinRoot(root, join(root, "escape.txt")),
    ).toThrow(/symlink escapes/);
  });

  it("returns a not-yet-existing path unchanged", () => {
    const p = join(root, "does-not-exist.txt");
    expect(assertRealpathWithinRoot(root, p)).toBe(p);
  });
});

describe("runtimeDir", () => {
  it("builds paths under .design-convergence", () => {
    expect(runtimeDir("/project", "artifacts")).toBe(
      resolve("/project", ".design-convergence/artifacts"),
    );
  });
});
