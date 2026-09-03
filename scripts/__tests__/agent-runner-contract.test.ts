/**
 * Adapter contract: every agent runner must honor the same
 * (query, maxTurns, options) -> JSON seam. A new backend is done when it
 * passes this suite — third-party adapters can import
 * {@link runAdapterContractSuite} and run it against their own `run`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

import {
  HERMES_QA_DEFAULT_TIMEOUT_MS,
  resolveHermesTimeoutMs,
  runHermes,
} from "../hermes-runner.mjs";
import {
  ASIDE_QA_DEFAULT_TIMEOUT_MS,
  resolveAsideTimeoutMs,
  runAside,
} from "../aside-runner.mjs";
import { execChildEnv, runExecAgent } from "../exec-runner.mjs";
import { runFixture } from "../fixture-runner.mjs";
import { runAgent } from "../ai-agent-adapter.mjs";
import { EnvironmentError } from "../errors.mjs";
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

type RunFn = (
  query: string,
  maxTurns: number,
  options?: Record<string, unknown>
) => Record<string, unknown>;

/**
 * @param options.spawns false for adapters that never start a process
 *   (fixture) — the process-failure cases do not apply to them.
 */
export function runAdapterContractSuite(
  name: string,
  run: RunFn,
  options: { spawns?: boolean; setup?: () => void } = {}
) {
  const { spawns = true, setup } = options;

  describe(`agent runner contract: ${name}`, () => {
    beforeEach(() => {
      setup?.();
    });

    const paths = () => ({
      hermesQuery: join(dir, "query.txt"),
      hermesRawOutput: join(dir, "raw.txt"),
    });

    it("returns parsed JSON when required keys are present", () => {
      spawnSyncMock.mockReturnValue(spawnResult());
      const result = run("do the thing", 5, { paths: paths() });
      expect(typeof result.status).toBe("string");
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

    it("throws when required keys are missing from the output", () => {
      spawnSyncMock.mockReturnValue(spawnResult());
      expect(() =>
        run("q", 5, { paths: paths(), requiredKeys: ["definitelyNotAKey"] })
      ).toThrow(/valid JSON/);
    });

    if (!spawns) return;

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

    it("keeps the captured output when the run times out", () => {
      spawnSyncMock.mockReturnValue(
        spawnResult({
          status: null,
          stdout: `ten minutes of work, saw ${SECRET}`,
          error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }),
        })
      );
      expect(() =>
        run("q", 5, { paths: paths(), secrets: [SECRET] })
      ).toThrow(EnvironmentError);

      expect(existsSync(join(dir, "raw.txt"))).toBe(true);
      const written = readFileSync(join(dir, "raw.txt"), "utf8");
      expect(written).toContain("ten minutes of work");
      expect(written).not.toContain(SECRET);
    });

    it("names the missing binary instead of throwing a bare ENOENT", () => {
      spawnSyncMock.mockReturnValue(
        spawnResult({
          status: null,
          stdout: "",
          error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
        })
      );
      expect(() => run("q", 5, { paths: paths() })).toThrow(
        /command not found/
      );
      expect(existsSync(join(dir, "raw.txt"))).toBe(true);
    });
  });
}

runAdapterContractSuite("hermes", runHermes);
runAdapterContractSuite("aside", runAside);
runAdapterContractSuite("exec", runExecAgent, {
  setup: () => vi.stubEnv("QA_AGENT_CMD", "my-agent --json"),
});
runAdapterContractSuite("fixture", runFixture, { spawns: false });

describe("wall-clock timeout guards", () => {
  it("hermes defaults to 10 minutes and forwards to spawnSync", () => {
    spawnSyncMock.mockReturnValue(spawnResult());
    runHermes("q", 5, {});
    expect(spawnSyncMock.mock.calls[0][2].timeout).toBe(
      HERMES_QA_DEFAULT_TIMEOUT_MS
    );
  });

  it("hermes honors HERMES_QA_TIMEOUT_MS", () => {
    vi.stubEnv("HERMES_QA_TIMEOUT_MS", "4321");
    expect(resolveHermesTimeoutMs()).toBe(4321);
  });

  it("hermes reports a stalled turn as an environment failure", () => {
    spawnSyncMock.mockReturnValue(
      spawnResult({
        status: null,
        error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }),
      })
    );
    expect(() => runHermes("q", 5, {})).toThrow(EnvironmentError);
    expect(() => runHermes("q", 5, {})).toThrow(/timed out after/);
  });

  it("aside defaults to 10 minutes and forwards to spawnSync", () => {
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

describe("exec adapter", () => {
  it("passes the prompt on stdin, never in argv", () => {
    vi.stubEnv("QA_AGENT_CMD", "claude -p --output-format json");
    spawnSyncMock.mockReturnValue(spawnResult());
    runExecAgent(`judge this page, password ${SECRET}`, 5, {});

    const [cmd, args, spawnOptions] = spawnSyncMock.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toEqual(["-p", "--output-format", "json"]);
    expect(JSON.stringify(args)).not.toContain("judge this page");
    expect(JSON.stringify(args)).not.toContain(SECRET);
    expect(spawnOptions.input).toContain("judge this page");
  });

  it("forwards the run's CDP endpoint to a browser MCP server under cdp-attach", () => {
    vi.stubEnv("QA_AGENT_AUTH", "cdp-attach");
    vi.stubEnv("BROWSER_CDP_URL", "http://127.0.0.1:9222");
    expect(execChildEnv().PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe(
      "http://127.0.0.1:9222"
    );
  });

  it("never overwrites a CDP endpoint the operator set themselves", () => {
    vi.stubEnv("QA_AGENT_AUTH", "cdp-attach");
    vi.stubEnv("BROWSER_CDP_URL", "http://127.0.0.1:9222");
    vi.stubEnv("PLAYWRIGHT_MCP_CDP_ENDPOINT", "http://127.0.0.1:9333");
    expect(execChildEnv().PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe(
      "http://127.0.0.1:9333"
    );
  });

  it("leaves the endpoint unset when the adapter is not attaching to our browser", () => {
    vi.stubEnv("QA_AGENT_AUTH", "");
    vi.stubEnv("BROWSER_CDP_URL", "http://127.0.0.1:9222");
    expect(execChildEnv().PLAYWRIGHT_MCP_CDP_ENDPOINT).toBeUndefined();
  });

  it("fails with a named env var when QA_AGENT_CMD is unset", () => {
    vi.stubEnv("QA_AGENT_CMD", "");
    expect(() => runExecAgent("q", 5, {})).toThrow(/QA_AGENT_CMD/);
    expect(() => runExecAgent("q", 5, {})).toThrow(EnvironmentError);
  });
});

describe("fixture adapter", () => {
  it("serves a stage-shaped payload per pipeline stage, offline", () => {
    const judge = runFixture("q", 5, { requiredKeys: ["status"] });
    expect(judge.status).toBe("manual_review");

    const abstract = runFixture("q", 5, { requiredKeys: ["livePlan"] });
    expect(abstract.livePlan).toContain("Given");

    const review = runFixture("q", 5, {
      requiredKeys: ["criteria", "overallReview"],
    });
    expect(review.overallReview).toBe("flagged");

    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  /**
   * The offline plan is cross-checked against the parser like any other. A plan
   * that names nothing concrete disagrees with every test that asserts on a
   * test id, so `abstract-ai --force` reported a repair per check and the
   * offline pipeline could never be quiet enough to show a real signal.
   */
  it("to name the test ids the quoted source asserts on, so the plan survives its own cross-check", () => {
    const payload = {
      specDefinition: {
        scenarios: [
          {
            scenarioId: "ACTIVE",
            tests: [
              {
                title: "shows the credit total",
                qaLivePolicy: "readonly",
                source:
                  'await expect(page.getByTestId("credit-total")).toBeVisible();',
              },
            ],
          },
        ],
      },
    };
    const query = `## Payload\n${JSON.stringify(payload)}`;

    const { livePlan } = runFixture(query, 5, { requiredKeys: ["livePlan"] });

    expect(livePlan).toContain("credit-total");
    expect(livePlan).toContain("mutations: 0");
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
