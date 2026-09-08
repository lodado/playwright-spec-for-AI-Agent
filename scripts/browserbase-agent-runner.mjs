import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveAdapterName } from "./ai-agent-adapter.mjs";
import { redactSensitiveText, resolveTimeoutMs } from "./agent-output.mjs";
import { AgentOutputError, EnvironmentError, QaError, UsageError } from "./errors.mjs";

function redact(value, secrets) {
  let text = String(value ?? "");
  // Match whole CDP URLs before generic redaction changes their query strings.
  for (const secret of secrets) {
    text = text.split(secret).join("[redacted]");
    text = text.split(encodeURIComponent(secret)).join("[redacted]");
  }
  return redactSensitiveText(text, secrets);
}

function restoreError(value, secrets) {
  const types = { QaError, UsageError, EnvironmentError, AgentOutputError };
  const Type = Object.hasOwn(types, value?.name) ? types[value.name] : Error;
  const options = { hint: redact(value?.hint, secrets) };
  if (Number.isInteger(value?.exitCode)) options.exitCode = value.exitCode;
  const error = new Type(redact(value?.message ?? "Browserbase agent process failed.", secrets), options);
  if (value?.stack) error.stack = redact(value.stack, secrets);
  return error;
}

/** Keep the owning CDP client's event loop alive while a synchronous adapter runs.
 * Console output is deliberately suppressed. Built-in adapters still write their
 * redacted raw-output artifacts through options.paths. POSIX uses a dedicated
 * process group. Windows can terminate the direct child only, not descendants.
 */
export async function runBrowserbaseAgent(session, query, maxTurns, options = {}) {
  const secrets = [...new Set([session.cdpUrl, ...(session.secrets ?? []), ...(options.secrets ?? [])]
    .filter(value => typeof value === "string" && value))].sort((a, b) => b.length - a.length);
  const env = { ...process.env, BROWSER_CDP_URL: session.cdpUrl, PLAYWRIGHT_MCP_CDP_ENDPOINT: session.cdpUrl };
  delete env.BROWSERBASE_API_KEY;
  const timeoutVar = resolveAdapterName() === "hermes" ? "HERMES_QA_TIMEOUT_MS" : "QA_AGENT_TIMEOUT_MS";
  const timeoutMs = Math.min(2147483647, Math.ceil(resolveTimeoutMs(timeoutVar)));

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = fork(fileURLToPath(new URL("./browserbase-agent-process.mjs", import.meta.url)), [], {
        env,
        // Inheriting a parent's -e/--eval would run its caller again recursively.
        execArgv: [],
        detached: process.platform !== "win32",
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch (error) {
      reject(new EnvironmentError(`Browserbase agent process could not start: ${redact(error.message, secrets)}`));
      return;
    }
    const killGroup = signal => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch { /* The dedicated process group may already have exited. */ }
    };
    let finishing = false, settled = false, graceTimer;
    const finish = (error, value, force = false) => {
      if (settled || (finishing && !force)) return;
      finishing = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      const settle = () => {
        settled = true;
        process.removeListener("SIGINT", onInt);
        process.removeListener("SIGTERM", onTerm);
        if (child.connected) child.disconnect();
        child.unref();
        if (error) reject(error);
        else resolve(value);
      };
      if (force) {
        // Provider signal cleanup may process.exit soon. Kill synchronously so
        // a blocked adapter or its descendants cannot outlive that exit.
        killGroup("SIGKILL");
        settle();
      } else {
        killGroup("SIGTERM");
        graceTimer = setTimeout(() => { killGroup("SIGKILL"); settle(); }, 250);
      }
    };
    const cancel = signal => finish(new EnvironmentError(`Browserbase agent interrupted by ${signal}.`, {
      exitCode: signal === "SIGINT" ? 130 : 143,
    }), undefined, true);
    const onInt = () => cancel("SIGINT"), onTerm = () => cancel("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const timer = setTimeout(() => finish(new EnvironmentError(`Browserbase agent process timed out after ${timeoutMs}ms.`)), timeoutMs);
    child.once("error", error => finish(restoreError(error, secrets)));
    child.once("exit", code => finish(new EnvironmentError(`Browserbase agent process exited without a result (exit ${code}).`)));
    child.once("message", message => {
      try {
        if (message?.type === "error") finish(restoreError(message.error, secrets));
        else if (message?.type === "result") {
          const value = message.result === undefined ? undefined : JSON.parse(redact(JSON.stringify(message.result), secrets));
          finish(null, value);
        } else finish(new EnvironmentError("Browserbase agent process returned an invalid response."));
      } catch (error) { finish(restoreError(error, secrets)); }
    });
    // Prompts/options travel through IPC, never command arguments visible in ps.
    try {
      child.send({ query, maxTurns, options: { ...options, secrets } }, error => {
        if (error) finish(restoreError(error, secrets));
      });
    } catch (error) { finish(restoreError(error, secrets)); }
  });
}
