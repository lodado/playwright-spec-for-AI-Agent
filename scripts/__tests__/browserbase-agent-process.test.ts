import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapter = vi.hoisted(() => ({
  prepareAdapter: vi.fn(),
  runAgentAsync: vi.fn(),
}));
vi.mock("../ai-agent-adapter.mjs", () => adapter);

type Handler = (message: unknown) => Promise<void>;

/** Import the entry point fresh and capture the one-shot IPC handler it registers. */
async function loadHandler(): Promise<{ handler: Handler; send: ReturnType<typeof vi.fn> }> {
  vi.resetModules();
  let handler: Handler | undefined;
  vi.spyOn(process, "once").mockImplementation(((event: string, fn: Handler) => {
    if (event === "message") handler = fn;
    return process;
  }) as never);
  const send = vi.fn();
  (process as unknown as { send: unknown }).send = send;
  await import("../browserbase-agent-process.mjs");
  if (!handler) throw new Error("entry point registered no message handler");
  return { handler, send };
}

beforeEach(() => {
  adapter.prepareAdapter.mockReset().mockResolvedValue(undefined);
  adapter.runAgentAsync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (process as unknown as { send?: unknown }).send;
});

describe("browserbase-agent-process as a forked child receiving one IPC message", () => {
  it("to be a registration on process.once('message') only", async () => {
    vi.resetModules();
    const once = vi.spyOn(process, "once").mockImplementation((() => process) as never);

    await import("../browserbase-agent-process.mjs");

    expect(once.mock.calls.map(call => call[0])).toEqual(["message"]);
  });

  it("to be prepareAdapter then runAgentAsync(query, maxTurns, options), replied as a result message", async () => {
    adapter.runAgentAsync.mockResolvedValue({ verdict: "ok" });
    const { handler, send } = await loadHandler();
    const options = { secrets: ["s"], paths: { raw: "/r" } };

    await handler({ query: "check the page", maxTurns: 12, options });

    expect(adapter.prepareAdapter).toHaveBeenCalledTimes(1);
    expect(adapter.prepareAdapter.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.runAgentAsync.mock.invocationCallOrder[0],
    );
    expect(adapter.runAgentAsync).toHaveBeenCalledWith("check the page", 12, options);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "result", result: { verdict: "ok" } });
  });

  it("to be only the CLI error contract fields when the agent throws", async () => {
    const failure = Object.assign(new Error("boom"), {
      name: "UsageError",
      hint: "try again",
      exitCode: 2,
      leaked: "secret-token",
    });
    adapter.runAgentAsync.mockRejectedValue(failure);
    const { handler, send } = await loadHandler();

    await handler({ query: "q", maxTurns: 1, options: {} });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "error",
      error: {
        name: "UsageError",
        message: "boom",
        stack: failure.stack,
        hint: "try again",
        exitCode: 2,
      },
    });
  });

  it("to be an error reply and no agent run when prepareAdapter rejects with a non-Error", async () => {
    adapter.prepareAdapter.mockRejectedValue("no cli");
    const { handler, send } = await loadHandler();

    await handler({ query: "q", maxTurns: 1, options: {} });

    expect(adapter.runAgentAsync).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      type: "error",
      error: {
        name: undefined,
        message: "no cli",
        stack: undefined,
        hint: undefined,
        exitCode: undefined,
      },
    });
  });
});
