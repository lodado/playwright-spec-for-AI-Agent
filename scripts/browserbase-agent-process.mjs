import { prepareAdapter, runAgentAsync } from "./ai-agent-adapter.mjs";

process.once("message", async ({ query, maxTurns, options }) => {
  try {
    await prepareAdapter();
    const result = await runAgentAsync(query, maxTurns, options);
    process.send({ type: "result", result });
  } catch (error) {
    // Transfer only the CLI error contract. The parent redacts it before use.
    process.send({ type: "error", error: {
      name: error?.name,
      message: String(error?.message ?? error),
      stack: error?.stack,
      hint: error?.hint,
      exitCode: error?.exitCode,
    } });
  }
});
