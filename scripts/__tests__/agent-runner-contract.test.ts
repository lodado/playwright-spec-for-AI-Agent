/**
 * Adapter contract: every agent runner must honor the same
 * (query, maxTurns, options) -> JSON seam. A new backend is done when it
 * passes this suite.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

import { runHermes } from "../hermes-runner.mjs";
import {
  ASIDE_QA_DEFAULT_TIMEOUT_MS,
  resolveAsideTimeoutMs,
  runAside,
} from "../aside-runner.mjs";
import { runAgent } from "../ai-agent-adapter.mjs";
import {
  buildAsidePreloginScript,
  preloginAside,
} from "../aside-prelogin.mjs";

const SECRET = "hunter2-secret";

function spawnResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 0,
    stdout: `{"status":"pass","note":"saw ${SECRET} on screen"}`,
    stderr: "",
    error: undefined,
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-contract-"));
  vi.stubEnv("HERMES_INFERENCE_MODEL", "test-model");
  spawnSyncMock.mockReset();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe.each([
  ["hermes", runHermes],
  ["aside", runAside],
] as const)("agent runner contract: %s", (_name, run) => {
  const paths = () => ({
    hermesQuery: join(dir, "query.txt"),
    hermesRawOutput: join(dir, "raw.txt"),
  });

  it("returns parsed JSON when required keys are present", () => {
    spawnSyncMock.mockReturnValue(spawnResult());
    const result = run("do the thing", 5, { paths: paths() });
    expect(result.status).toBe("pass");
  });

  it("writes the query artifact with secrets redacted", () => {
    spawnSyncMock.mockReturnValue(spawnResult());
    run(`login with password ${SECRET}`, 5, {
      paths: paths(),
      secrets: [SECRET],
    });
    const written = readFileSync(join(dir, "query.txt"), "utf8");
    expect(written).not.toContain(SECRET);
    expect(written).toContain("[redacted]");
  });

  it("writes the raw output artifact with secrets redacted", () => {
    spawnSyncMock.mockReturnValue(spawnResult());
    run("q", 5, { paths: paths(), secrets: [SECRET] });
    const written = readFileSync(join(dir, "raw.txt"), "utf8");
    expect(written).not.toContain(SECRET);
  });

  it("throws on non-zero exit without leaking secrets", () => {
    spawnSyncMock.mockReturnValue(
      spawnResult({ status: 1, stdout: "", stderr: `boom ${SECRET}` })
    );
    expect(() => run("q", 5, { paths: paths(), secrets: [SECRET] })).toThrow(
      /failed \(exit 1\)/
    );
    try {
      run("q", 5, { paths: paths(), secrets: [SECRET] });
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
    }
  });

  it("throws when required keys are missing from the output", () => {
    spawnSyncMock.mockReturnValue(spawnResult({ stdout: '{"other":1}' }));
    expect(() => run("q", 5, { paths: paths() })).toThrow(/valid JSON/);
  });
});

describe("aside timeout guard", () => {
  it("defaults to 10 minutes and forwards to spawnSync", () => {
    spawnSyncMock.mockReturnValue(spawnResult());
    runAside("q", 5, {});
    expect(spawnSyncMock.mock.calls[0][2].timeout).toBe(
      ASIDE_QA_DEFAULT_TIMEOUT_MS
    );
  });

  it("honors ASIDE_QA_TIMEOUT_MS", () => {
    vi.stubEnv("ASIDE_QA_TIMEOUT_MS", "1234");
    expect(resolveAsideTimeoutMs()).toBe(1234);
  });

  it("reports a timeout as a clear error", () => {
    spawnSyncMock.mockReturnValue(
      spawnResult({ error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) })
    );
    expect(() => runAside("q", 5, {})).toThrow(/timed out after/);
  });
});

describe("runAgent metadata", () => {
  it("stamps authoritative source and agentMeta on the result", () => {
    vi.stubEnv("QA_AI_ADAPTER", "aside");
    vi.stubEnv("ASIDE_QA_MODEL", "test/model-x");
    spawnSyncMock.mockReturnValue(
      spawnResult({ stdout: '{"status":"pass","source":"hermes-agent"}' })
    );
    const result = runAgent("q", 5, {});
    expect(result.source).toBe("aside");
    expect(result.agentMeta.adapter).toBe("aside");
    expect(result.agentMeta.model).toBe("test/model-x");
    expect(typeof result.agentMeta.durationMs).toBe("number");
  });
});

describe("aside prelogin", () => {
  it("keeps credentials in stdin, never in argv", () => {
    spawnSyncMock.mockReturnValue(
      spawnResult({ stdout: "ASIDE_PRELOGIN_OK:https://x/dash" })
    );
    preloginAside({
      loginUrl: "https://x/login",
      email: "qa@x.com",
      password: SECRET,
    });
    const [cmd, args, options] = spawnSyncMock.mock.calls[0];
    expect(cmd).toBe("aside");
    expect(args).toEqual(["repl"]);
    expect(JSON.stringify(args)).not.toContain(SECRET);
    expect(options.input).toContain(SECRET);
    expect(options.input).toContain('input[type="password"]');
  });

  it("fails without echoing the repl transcript when the marker is missing", () => {
    spawnSyncMock.mockReturnValue(
      spawnResult({ stdout: `typed ${SECRET} but login failed` })
    );
    expect(() =>
      preloginAside({
        loginUrl: "https://x/login",
        email: "qa@x.com",
        password: SECRET,
      })
    ).toThrow(/never left the login page/);
    try {
      preloginAside({
        loginUrl: "https://x/login",
        email: "qa@x.com",
        password: SECRET,
      });
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
    }
  });

  it("escapes credentials safely into the script", () => {
    const script = buildAsidePreloginScript({
      loginUrl: "https://x/login",
      email: "qa@x.com",
      password: `pw"with'quotes`,
    });
    expect(script).toContain('"pw\\"with\'quotes"');
    expect(script).toContain("login form still visible");
    expect(script.endsWith("\n")).toBe(true);
    expect(script.trimEnd()).not.toContain("\n");
  });
});
