import { readHermesModelConfig, runHermes } from "./hermes-runner.mjs";
import { runAside } from "./aside-runner.mjs";

/**
 * Repository-pattern seam for the QA agent backend. Every pipeline stage
 * (abstract-ai, judge, review) calls runAgent with the same contract as the
 * original runHermes: (query, maxTurns, { paths, secrets, requiredKeys,
 * requiredKeyGroups, mode }) -> parsed JSON with the required keys.
 *
 * Select the backend with QA_AI_ADAPTER=hermes (default) or QA_AI_ADAPTER=aside.
 */
const ADAPTERS = {
  hermes: runHermes,
  aside: runAside,
};

export function resolveAdapterName() {
  return process.env.QA_AI_ADAPTER?.trim() || "hermes";
}

function resolveAdapterModel(name) {
  if (name === "aside") return process.env.ASIDE_QA_MODEL?.trim() || null;
  try {
    return readHermesModelConfig().model;
  } catch {
    return null;
  }
}

export function runAgent(query, maxTurns, options = {}) {
  const name = resolveAdapterName();
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(
      `Unknown QA_AI_ADAPTER: ${JSON.stringify(name)}. Supported: ${Object.keys(ADAPTERS).join(", ")}`
    );
  }
  const startedAt = Date.now();
  const result = adapter(query, maxTurns, options);
  // The agent's self-reported `source` comes from a prompt template and lies
  // when the backend is swapped — the adapter is the authority on who ran.
  if (result && typeof result === "object" && !Array.isArray(result)) {
    result.source = name === "hermes" ? "hermes-agent" : name;
    result.agentMeta = {
      adapter: name,
      model: resolveAdapterModel(name),
      durationMs: Date.now() - startedAt,
    };
  }
  return result;
}
