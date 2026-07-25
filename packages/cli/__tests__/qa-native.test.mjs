import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExclusiveQaDirectory,
  decodeIntegrityKey,
  readPrivateJson,
  resolvePrivateQaPath,
  runQaNative,
  writePrivateFileExclusive,
  writePrivateJsonExclusive,
} from "../qa-native.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "qa-native-cli-"));
  temporaryDirectories.push(root);
  return root;
}

describe("qa-native CLI security foundation", () => {
  it("strictly decodes an external base64 integrity key", () => {
    const encoded = Buffer.alloc(32, 0x42).toString("base64");
    expect(decodeIntegrityKey(encoded)).toEqual(Buffer.alloc(32, 0x42));
    for (const invalid of [undefined, "", "not-base64", Buffer.alloc(31).toString("base64"), `${encoded}\n`, encoded.replace(/=$/, "")]) {
      expect(() => decodeIntegrityKey(invalid)).toThrow(/integrity key/);
    }
    expect(() => decodeIntegrityKey(`${encoded.slice(0, -2)}J=`)).toThrow(/integrity key/);
  });

  it("keeps run paths inside .qa and rejects existing symlink components", () => {
    const cwd = temporaryRoot();
    expect(resolvePrivateQaPath(".qa/runs/run-1", { cwd })).toBe(join(cwd, ".qa", "runs", "run-1"));
    for (const invalid of ["run-1", "../run-1", ".qa/../outside", join(cwd, ".qa", "run-1")]) {
      expect(() => resolvePrivateQaPath(invalid, { cwd })).toThrow(/private .qa path/);
    }

    mkdirSync(join(cwd, ".qa"), { mode: 0o700 });
    symlinkSync(tmpdir(), join(cwd, ".qa", "linked"));
    expect(() => resolvePrivateQaPath(".qa/linked/run-1", { cwd })).toThrow(/symbolic link/);
    symlinkSync(join(cwd, "missing"), join(cwd, ".qa", "dangling"));
    expect(() => resolvePrivateQaPath(".qa/dangling/run-1", { cwd })).toThrow(/symbolic link/);
  });

  it("creates private outputs exclusively and refuses overwrite", () => {
    const cwd = temporaryRoot();
    const runDirectory = createExclusiveQaDirectory(".qa/runs/run-1", { cwd });
    expect(lstatSync(join(cwd, ".qa")).mode & 0o777).toBe(0o700);
    expect(lstatSync(runDirectory).mode & 0o777).toBe(0o700);
    expect(() => createExclusiveQaDirectory(".qa/runs/run-1", { cwd })).toThrow(/already exists/);

    const artifact = writePrivateJsonExclusive(".qa/runs/run-1/run.json", { runId: "run-1" }, { cwd });
    expect(lstatSync(artifact).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(artifact, "utf8"))).toEqual({ runId: "run-1" });
    expect(() => writePrivateJsonExclusive(".qa/runs/run-1/run.json", { replaced: true }, { cwd })).toThrow(/already exists/);
    const raw = writePrivateFileExclusive(".qa/runs/run-1/report.md", "private report", { cwd });
    expect(lstatSync(raw).mode & 0o777).toBe(0o600);
    expect(() => writePrivateFileExclusive(".qa/runs/run-1/report.md", "replaced", { cwd })).toThrow(/already exists/);
    expect(readFileSync(raw, "utf8")).toBe("private report");
    expect(() => writePrivateJsonExclusive(".qa/runs/run-1/undefined.json", undefined, { cwd })).toThrow(/JSON-serializable/);
  });

  it("reads only bounded private JSON through no-follow file descriptors", () => {
    const cwd = temporaryRoot();
    createExclusiveQaDirectory(".qa/runs/run-1", { cwd });
    const artifact = writePrivateJsonExclusive(".qa/runs/run-1/input.json", { ok: true }, { cwd });
    expect(readPrivateJson(".qa/runs/run-1/input.json", { cwd })).toEqual({ ok: true });
    chmodSync(artifact, 0o644);
    expect(() => readPrivateJson(".qa/runs/run-1/input.json", { cwd })).toThrow(/private JSON/);
  });

  it("dispatches known commands without exposing the key or raw errors", async () => {
    const cwd = temporaryRoot();
    writeFileSync(join(cwd, "dashboard.spec.ts"), "test('dashboard', () => {})");
    const stdout = vi.fn();
    const stderr = vi.fn();
    const execute = vi.fn(async ({ integrityKey, runDirectory }) => {
      expect(integrityKey).toEqual(Buffer.alloc(32, 0x51));
      expect(runDirectory).toBe(join(cwd, ".qa", "runs", "run-1"));
      throw new Error("provider-secret");
    });
    const exitCode = await runQaNative([
      "execute",
      "--spec=dashboard.spec.ts",
      "--base-url=https://example.test",
      "--run-dir=.qa/runs/run-1",
    ], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: Buffer.alloc(32, 0x51).toString("base64") },
      handlers: { execute },
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0].integrityKey).toEqual(Buffer.alloc(32));
    expect(stderr).toHaveBeenCalledWith("qa-native: command failed\n");
    expect(JSON.stringify({ stdout: stdout.mock.calls, stderr: stderr.mock.calls })).not.toContain("provider-secret");
  });

  it("shows help without a key and rejects secret-bearing or unknown arguments", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    expect(await runQaNative(["--help"], { env: {}, handlers: { execute: vi.fn() }, stdout, stderr })).toBe(0);
    expect(stdout.mock.calls[0][0]).toContain("qa-native execute");

    expect(await runQaNative(["execute", "--integrity-key=secret"], { env: {}, stdout, stderr })).toBe(1);
    expect(await runQaNative(["--run-dir=.qa/runs/1"], { env: {}, stdout, stderr })).toBe(1);
    expect(await runQaNative(["unknown"], { env: {}, stdout, stderr })).toBe(1);
    expect(await runQaNative(["judge", "--run-dir=.qa/missing"], { env: {}, handlers: { execute: vi.fn() }, stdout, stderr })).toBe(1);
    expect(stderr.mock.calls.at(-1)[0]).toBe("qa-native: command is not available\n");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("secret");
  });

  it("shows help but rejects commands on platforms without private POSIX modes", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const execute = vi.fn();
    expect(await runQaNative(["--help"], { env: {}, handlers: { execute }, platform: "win32", stdout, stderr })).toBe(0);
    expect(stdout.mock.calls[0][0]).toContain("qa-native execute");

    expect(await runQaNative([
      "execute",
      "--spec=missing.spec.ts",
      "--base-url=https://example.test",
      "--run-dir=.qa/runs/windows",
    ], { cwd: "Z:\\missing", env: {}, handlers: { execute }, platform: "win32", stdout, stderr })).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenLastCalledWith("qa-native: command is not supported on this platform\n");
  });

  it("recognizes every native command through validated handler inputs", async () => {
    const cwd = temporaryRoot();
    writeFileSync(join(cwd, "a.spec.ts"), "test('a', () => {})");
    const key = Buffer.alloc(32, 0x61).toString("base64");
    const handler = vi.fn(() => 0);
    const handlers = { execute: handler, judge: handler, replay: handler, diagnose: handler, "suggest-fix": handler, report: handler };
    const shared = { cwd, env: { QA_NATIVE_INTEGRITY_KEY: key }, handlers, stdout: vi.fn(), stderr: vi.fn() };
    expect(await runQaNative(["execute", "--spec=a.spec.ts", "--base-url=https://example.test", "--run-dir=.qa/runs/new"], shared)).toBe(0);
    createExclusiveQaDirectory(".qa/runs/existing", { cwd });
    expect(await runQaNative(["judge", "--run-dir=.qa/runs/existing"], shared)).toBe(0);
    expect(await runQaNative(["replay", "--run-dir=.qa/runs/existing"], shared)).toBe(0);
    expect(await runQaNative(["diagnose", "--run-dir=.qa/runs/existing", "--repository-root=."], shared)).toBe(0);
    expect(await runQaNative(["suggest-fix", "--run-dir=.qa/runs/existing", "--repository-root=."], shared)).toBe(0);
    expect(await runQaNative(["report", "--run-dir=.qa/runs/existing", "--repository-root=."], shared)).toBe(0);
    expect(handler).toHaveBeenCalledTimes(6);
    expect(handler.mock.calls.at(-2)[0]).toMatchObject({
      command: "suggest-fix",
      repositoryRoot: realpathSync(cwd),
      revision: "HEAD",
    });
  });

  it("removes the raw key from the process environment before dispatch", async () => {
    const cwd = temporaryRoot();
    writeFileSync(join(cwd, "a.spec.ts"), "test('a', () => {})");
    process.env.QA_NATIVE_INTEGRITY_KEY = Buffer.alloc(32, 0x71).toString("base64");
    const handler = vi.fn(() => {
      expect(process.env.QA_NATIVE_INTEGRITY_KEY).toBeUndefined();
      return 0;
    });
    try {
      expect(await runQaNative(["execute", "--spec=a.spec.ts", "--base-url=https://example.test", "--run-dir=.qa/runs/new"], { cwd, handlers: { execute: handler }, stdout: vi.fn(), stderr: vi.fn() })).toBe(0);
    } finally {
      delete process.env.QA_NATIVE_INTEGRITY_KEY;
    }
  });

  it("restores unrelated process state after dispatch with an injected environment", async () => {
    const cwd = temporaryRoot();
    writeFileSync(join(cwd, "a.spec.ts"), "test('a', () => {})");
    process.env.QA_NATIVE_INTEGRITY_KEY = "unrelated-global-value";
    const handler = vi.fn(() => {
      expect(process.env.QA_NATIVE_INTEGRITY_KEY).toBeUndefined();
      return 0;
    });
    try {
      expect(await runQaNative(["execute", "--spec=a.spec.ts", "--base-url=https://example.test", "--run-dir=.qa/runs/new"], {
        cwd,
        env: { QA_NATIVE_INTEGRITY_KEY: Buffer.alloc(32, 0x72).toString("base64") },
        handlers: { execute: handler },
        stdout: vi.fn(),
        stderr: vi.fn(),
      })).toBe(0);
      expect(process.env.QA_NATIVE_INTEGRITY_KEY).toBe("unrelated-global-value");
    } finally {
      delete process.env.QA_NATIVE_INTEGRITY_KEY;
    }
  });

  it("rejects public or non-directory run targets before dispatch", async () => {
    const cwd = temporaryRoot();
    mkdirSync(join(cwd, ".qa"), { mode: 0o700 });
    mkdirSync(join(cwd, ".qa", "public"), { mode: 0o777 });
    writeFileSync(join(cwd, ".qa", "file"), "not a run");
    const handler = vi.fn();
    const common = { cwd, env: { QA_NATIVE_INTEGRITY_KEY: Buffer.alloc(32).toString("base64") }, handlers: { judge: handler }, stdout: vi.fn(), stderr: vi.fn() };
    expect(await runQaNative(["judge", "--run-dir=.qa/public"], common)).toBe(1);
    expect(await runQaNative(["judge", "--run-dir=.qa/file"], common)).toBe(1);
    expect(handler).not.toHaveBeenCalled();
  });
});
