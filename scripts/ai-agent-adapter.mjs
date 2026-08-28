import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readHermesModelConfig, runHermes } from "./hermes-runner.mjs";
import { runAside } from "./aside-runner.mjs";
import { preloginAside } from "./aside-prelogin.mjs";
import { execAdapterCapabilities, runExecAgent } from "./exec-runner.mjs";
import { FIXTURE_ADAPTER_CAPABILITIES, runFixture } from "./fixture-runner.mjs";
import { UsageError } from "./errors.mjs";

/**
 * Repository-pattern seam for the QA agent backend. Every pipeline stage
 * (abstract-ai, judge, review) calls runAgent with the same contract as the
 * original runHermes: (query, maxTurns, { paths, secrets, requiredKeys,
 * requiredKeyGroups, mode }) -> parsed JSON with the required keys.
 *
 * Select the backend with QA_AI_ADAPTER: a built-in name (hermes, aside, exec,
 * fixture) or a module specifier resolved against the consumer project root.
 */
/**
 * `blocksEventLoop` is load-bearing, not informational: every built-in adapter
 * runs its CLI with spawnSync, which freezes this process for the whole agent
 * run. Anything that needs the Node event loop *while* the agent browses —
 * Playwright `context.route` handlers above all — will deadlock the browser
 * waiting for a handler that cannot be serviced. Live request interception is
 * therefore only legal for an adapter that declares `blocksEventLoop: false`;
 * blocking adapters must fall back to post-run HAR inspection.
 */
const DEFAULT_CAPABILITIES = {
  auth: "credentials-in-prompt",
  supportsMaxTurns: false,
  supportsToolsetDisable: false,
  supportsVideo: false,
  blocksEventLoop: true,
};

const BUILTIN_ADAPTERS = {
  hermes: {
    run: runHermes,
    capabilities: {
      auth: "cdp-attach",
      supportsMaxTurns: true,
      supportsToolsetDisable: true,
      supportsVideo: true,
    },
    prelogin: null,
    resolveModel: () => {
      try {
        return readHermesModelConfig().model;
      } catch {
        return null;
      }
    },
  },
  aside: {
    run: runAside,
    capabilities: {
      auth: "self-prelogin",
      supportsMaxTurns: false,
      supportsToolsetDisable: false,
      supportsVideo: false,
    },
    prelogin: preloginAside,
    resolveModel: () => process.env.ASIDE_QA_MODEL?.trim() || null,
  },
  exec: {
    run: runExecAgent,
    capabilities: execAdapterCapabilities,
    prelogin: null,
    resolveModel: () => process.env.QA_AGENT_CMD?.trim() || null,
  },
  fixture: {
    run: runFixture,
    capabilities: FIXTURE_ADAPTER_CAPABILITIES,
    prelogin: null,
    resolveModel: () => null,
  },
};

export function resolveAdapterName() {
  return process.env.QA_AI_ADAPTER?.trim() || "hermes";
}

/** A path or package name, as opposed to a built-in adapter name. */
function isModuleSpecifier(name) {
  return name.startsWith("@") || name.includes("/") || name.includes(".");
}

function unknownAdapterError(name) {
  return new UsageError(
    `Unknown QA_AI_ADAPTER: ${JSON.stringify(name)}.`,
    {
      hint: [
        `Built-in adapters: ${Object.keys(BUILTIN_ADAPTERS).join(", ")}.`,
        "For a third-party backend, set QA_AI_ADAPTER to a module specifier —",
        'a path ("./qa-adapters/my-agent.mjs") or a package ("@acme/qa-adapter") —',
        "exporting `run(query, maxTurns, options)` and optionally `capabilities`,",
        "`prelogin`, and `resolveModel`.",
      ].join(" "),
    }
  );
}

/** Cache for the one module-specifier adapter a process can use. */
let loadedModuleAdapter = null;

/** Consumer project root: the directory the QA command was run from. */
function consumerRoot() {
  return process.cwd();
}

function resolveModuleUrl(specifier) {
  const root = consumerRoot();
  const requireFromRoot = createRequire(join(root, "noop.cjs"));
  try {
    return pathToFileURL(requireFromRoot.resolve(specifier)).href;
  } catch {
    // ESM-only packages and bare paths that require.resolve cannot see: let
    // import() report the real failure against the project-root-relative path.
    return pathToFileURL(resolve(root, specifier)).href;
  }
}

function toAdapterEntry(specifier, module) {
  if (typeof module?.run !== "function") {
    throw new UsageError(
      `QA_AI_ADAPTER module ${JSON.stringify(specifier)} does not export a \`run\` function.`,
      { hint: "Export `run(query, maxTurns, options)` returning parsed JSON." }
    );
  }
  return {
    run: module.run,
    capabilities: { ...DEFAULT_CAPABILITIES, ...(module.capabilities ?? {}) },
    prelogin: typeof module.prelogin === "function" ? module.prelogin : null,
    resolveModel:
      typeof module.resolveModel === "function" ? module.resolveModel : () => null,
  };
}

/**
 * Resolve (and import) a module-specifier adapter. runAgent stays synchronous
 * for its three call sites, so entry scripts must await this before running a
 * stage; built-in adapters need no prepare call.
 */
export async function prepareAdapter() {
  const name = resolveAdapterName();
  if (BUILTIN_ADAPTERS[name]) return describeAdapter(name);
  if (!isModuleSpecifier(name)) throw unknownAdapterError(name);

  if (loadedModuleAdapter?.specifier !== name) {
    let module;
    try {
      module = await import(resolveModuleUrl(name));
    } catch (error) {
      throw new UsageError(
        `Could not load QA_AI_ADAPTER module ${JSON.stringify(name)} from ${consumerRoot()}: ${error.message}`,
        { cause: error }
      );
    }
    loadedModuleAdapter = { specifier: name, entry: toAdapterEntry(name, module) };
  }
  return describeAdapter(name);
}

/** Test seam: forget the imported module adapter. */
export function resetAdapterCacheForTests() {
  loadedModuleAdapter = null;
}

function resolveAdapterEntry(name) {
  const builtin = BUILTIN_ADAPTERS[name];
  if (builtin) return builtin;
  if (!isModuleSpecifier(name)) throw unknownAdapterError(name);
  if (loadedModuleAdapter?.specifier === name) return loadedModuleAdapter.entry;
  throw new UsageError(
    `QA_AI_ADAPTER module ${JSON.stringify(name)} was never loaded: call prepareAdapter() first.`,
    {
      hint: "A module-specifier adapter must be imported before use: `await prepareAdapter()` at the start of the command, before runAgent.",
    }
  );
}

/**
 * Capability descriptor, so callers branch on what a backend can do instead of
 * on its name.
 *
 * @returns {{ name: string, run: Function, capabilities: { auth: "cdp-attach"|"self-prelogin"|"credentials-in-prompt", supportsMaxTurns: boolean, supportsToolsetDisable: boolean, supportsVideo: boolean }, prelogin: Function|null }}
 */
export function describeAdapter(name = resolveAdapterName()) {
  const entry = resolveAdapterEntry(name);
  const capabilities =
    typeof entry.capabilities === "function"
      ? entry.capabilities()
      : entry.capabilities;
  return {
    name,
    run: entry.run,
    capabilities: { ...DEFAULT_CAPABILITIES, ...capabilities },
    prelogin: entry.prelogin ?? null,
  };
}

export function runAgent(query, maxTurns, options = {}) {
  const name = resolveAdapterName();
  const entry = resolveAdapterEntry(name);
  const startedAt = Date.now();
  const result = entry.run(query, maxTurns, options);
  // The agent's self-reported `source` comes from a prompt template and lies
  // when the backend is swapped — the adapter is the authority on who ran.
  if (result && typeof result === "object" && !Array.isArray(result)) {
    result.source = name === "hermes" ? "hermes-agent" : name;
    result.agentMeta = {
      adapter: name,
      model: entry.resolveModel?.() ?? null,
      durationMs: Date.now() - startedAt,
    };
  }
  return result;
}
