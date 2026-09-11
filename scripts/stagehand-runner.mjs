import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentOutputError, EnvironmentError, UsageError } from "./errors.mjs";
import { finalizeAgentRun, writeAgentQueryArtifact } from "./agent-output.mjs";

export const STAGEHAND_CAPABILITIES = {
  auth: "cdp-attach", supportsMaxTurns: true, supportsToolsetDisable: true,
  supportsVideo: true, blocksEventLoop: false,
};

export function resolveStagehandModel() {
  return process.env.QA_STAGEHAND_MODEL?.trim() || null;
}

function positiveInteger(name, fallback) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) {
    throw new UsageError(`${name} must be a positive integer no greater than 2147483647.`);
  }
  return number;
}

export function resolveStagehandRequest(query, maxTurns, { mode = "browse" } = {}) {
  const model = resolveStagehandModel();
  if (!model) throw new EnvironmentError("Set QA_STAGEHAND_MODEL to an explicit provider/model (for example openai/gpt-4.1-mini). Model API usage is billed separately.");
  if (!model.includes("/")) throw new UsageError("QA_STAGEHAND_MODEL must include a provider, for example openai/gpt-4.1-mini.");
  if (!["browse", "text-only"].includes(mode)) throw new UsageError(`Unsupported Stagehand mode: ${mode}`);
  const cdpUrl = mode === "browse" ? process.env.BROWSER_CDP_URL?.trim() : undefined;
  if (mode === "browse" && !cdpUrl) throw new EnvironmentError("Stagehand requires a runner-provided BROWSER_CDP_URL. Run login first, configure storageState, or pass --cdp-url to judge.");
  const configuredSteps = positiveInteger("QA_STAGEHAND_MAX_STEPS", 20);
  const maxSteps = Number.isSafeInteger(maxTurns) && maxTurns > 0 ? Math.min(configuredSteps, maxTurns) : configuredSteps;
  return { query, model, mode, cdpUrl, maxSteps, timeoutMs: positiveInteger("QA_STAGEHAND_TIMEOUT_MS", 120000) };
}

/** Optional dependency: resolve from the consumer first, then this package. */
export function resolveStagehandDependency() {
  const resolvers = [createRequire(resolve(process.cwd(), "package.json")), createRequire(import.meta.url)];
  let entry;
  for (const require of resolvers) {
    try { entry = require.resolve("@browserbasehq/stagehand"); break; } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  if (!entry) throw new EnvironmentError("Stagehand is optional and is not installed.", { hint: "Install @browserbasehq/stagehand@3.7.3 in your project." });
  let dir = dirname(entry), manifest;
  while (dir !== dirname(dir)) {
    try {
      const candidate = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (candidate.name === "@browserbasehq/stagehand") { manifest = candidate; break; }
    } catch { /* Walk from the exported entry to its package manifest. */ }
    dir = dirname(dir);
  }
  if (manifest?.version !== "3.7.3") throw new EnvironmentError(`Stagehand adapter requires @browserbasehq/stagehand@3.7.3; found ${manifest?.version ?? "unknown"}. v4 has a different API.`);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22)) {
    throw new EnvironmentError("Stagehand 3.7.3 requires Node ^20.19.0 or >=22.12.0.");
  }
  return entry;
}

function providerSecrets(options) {
  return [...new Set([...(options.secrets ?? []), process.env.BROWSER_CDP_URL,
    process.env.QA_STAGEHAND_BASE_URL,
    ...Object.entries(process.env).filter(([key]) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY)$/.test(key)).map(([, value]) => value),
  ].filter(value => typeof value === "string" && value))];
}

/** Async parent, isolated SDK worker: live Playwright guards remain responsive. */
export async function runStagehand(query, maxTurns, options = {}) {
  const request = resolveStagehandRequest(query, maxTurns, options);
  const secrets = providerSecrets(options);
  writeAgentQueryArtifact(options.paths, query, secrets);
  const result = await new Promise(resolveResult => {
    let worker;
    try {
      worker = fork(fileURLToPath(new URL("./stagehand-process.mjs", import.meta.url)), [], {
        execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env },
      });
    } catch (error) { resolveResult({ error }); return; }
    let stdout = "", stderr = "", output, failure, workerExitCode, settled = false, bytes = 0;
    const capture = (stream, chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 10 * 1024 * 1024) {
        failure = new Error("Stagehand output exceeded 10 MiB."); worker.kill("SIGKILL"); return;
      }
      if (stream === "stdout") stdout += chunk; else stderr += chunk;
    };
    worker.stdout?.on("data", chunk => capture("stdout", chunk));
    worker.stderr?.on("data", chunk => capture("stderr", chunk));
    const timeout = setTimeout(() => {
      failure = Object.assign(new Error("Stagehand deadline exceeded"), { code: "ETIMEDOUT" });
      worker.kill("SIGKILL");
    }, request.timeoutMs);
    const cancel = () => { failure = new Error("Stagehand run interrupted."); worker.kill("SIGKILL"); };
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    const finish = status => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
      if (!failure && output === undefined && !stderr) failure = new Error("Stagehand worker exited without a result.");
      resolveResult({ status: output === undefined ? 1 : status, error: failure, workerExitCode, stdout: output ?? "", stderr: [stdout, stderr].filter(Boolean).join("\n") });
    };
    worker.once("error", error => { failure = error; finish(null); });
    worker.once("close", finish);
    worker.once("message", message => {
      if (message?.type === "result" && typeof message.output === "string") {
        if (Buffer.byteLength(message.output) > 10 * 1024 * 1024) {
          failure = new Error("Stagehand result exceeded 10 MiB."); worker.kill("SIGKILL");
        } else output = message.output;
      }
      else if (message?.type === "error") {
        workerExitCode = message.exitCode;
        // Keep SDK errors in stderr so the shared finalizer redacts them.
        stderr += `\n${message.message ?? "Stagehand worker failed"}`;
      } else stderr += "\nStagehand worker returned an invalid response.";
    });
    worker.send(request, error => { if (error) { failure = error; worker.kill("SIGKILL"); } });
  });
  // Error.message is also redacted by moving it through the finalizer's stderr path.
  if (result.error && !["ETIMEDOUT", "ENOENT"].includes(result.error.code)) {
    result.stderr = `${result.stderr ?? ""}\n${result.error.message}`;
    result.error = undefined; result.status = 1;
  }
  return finalizeAgentRun(result, {
    adapterLabel: "Stagehand", command: "Stagehand SDK worker", ...options, secrets,
    timeoutMs: request.timeoutMs, timeoutHint: "Adjust QA_STAGEHAND_TIMEOUT_MS only if the task needs a longer deadline.",
    inspect: redactedOutput => {
      if (result.workerExitCode === 4) throw new AgentOutputError(`Stagehand returned unusable output: ${redactedOutput}`);
    },
  });
}
