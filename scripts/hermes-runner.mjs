import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  AGENT_DEFAULT_TIMEOUT_MS,
  extractAgentJson,
  extractFinalResponseText,
  finalizeAgentRun,
  prepareJsonParseSurface,
  redactSensitiveText,
  resolveTimeoutMs,
  unwrapAgentEnvelope,
  writeAgentQueryArtifact,
} from "./agent-output.mjs";
import { EnvironmentError, UsageError } from "./errors.mjs";

// Adapter-neutral helpers now live in agent-output.mjs; re-exported under their
// original names because callers and tests still import them from here.
export { redactSensitiveText };
export const extractHermesFinalResponseText = extractFinalResponseText;
export const unwrapHermesEnvelope = unwrapAgentEnvelope;
export const prepareHermesJsonParseSurface = prepareJsonParseSurface;
export function extractJsonFromHermesOutput(output, options = {}) {
  return extractAgentJson(output, { adapterLabel: "hermes", ...options });
}

export const REQUIRED_HERMES_AGENT_BIN = "hermes-agent";
export const HERMES_QA_COMMAND =
  process.env.HERMES_QA_COMMAND?.trim() || REQUIRED_HERMES_AGENT_BIN;

/**
 * --max_turns caps conversation length, not wall clock: a single turn that
 * stalls (API hang, CDP deadlock) would block a nightly forever without this.
 */
export const HERMES_QA_DEFAULT_TIMEOUT_MS = AGENT_DEFAULT_TIMEOUT_MS;

export function resolveHermesTimeoutMs() {
  return resolveTimeoutMs("HERMES_QA_TIMEOUT_MS", HERMES_QA_DEFAULT_TIMEOUT_MS);
}

/** Disable browsing/terminal for abstract-ai and review (JSON-in, JSON-out). */
export const HERMES_QA_TEXT_ONLY_DISABLED_TOOLSETS =
  process.env.HERMES_QA_DISABLED_TOOLSETS?.trim() ||
  "browser,web,terminal";

/**
 * Hermes memory toolset, disabled on every QA run so the agent cannot write
 * long-term memory that would carry into a later run — QA judgments must boot
 * fresh each time, never learned from prior runs.
 */
export const HERMES_QA_TEXT_ONLY_BASELINE_DISABLED_TOOLSETS = "browser,web,terminal";

export function mergeDisabledToolsets(...values) {
  const merged = [];
  for (const value of values) {
    for (const toolset of String(value ?? "").split(",")) {
      const normalized = toolset.trim();
      if (normalized && !merged.includes(normalized)) merged.push(normalized);
    }
  }
  return merged.join(",");
}

export const HERMES_QA_STATELESS_DISABLED_TOOLSETS = "memory";

const HERMES_QA_BROWSER_PLUGIN_NAME = "qa-browser-tools";
const HERMES_QA_BROWSER_PLUGIN_DIR = "qa_browser_tools";
const HERMES_QA_BROWSER_PLUGIN_MANIFEST = `name: ${HERMES_QA_BROWSER_PLUGIN_NAME}
version: 1.0.0
description: "Ephemeral QA browser evidence tools"
author: playwright-spec-for-ai-agent
provides_tools:
  - qa_checkpoint
  - qa_upload_fixture
`;
const HERMES_QA_BROWSER_PLUGIN_SOURCE = `"""Ephemeral bridge to the local QA browser tools server."""
import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def _post(payload):
    endpoint = os.environ.get("QA_BROWSER_TOOLS_URL", "").strip()
    token = os.environ.get("QA_BROWSER_TOOLS_TOKEN", "")
    if not endpoint or not token:
        return {"error": "QA browser tools are not configured"}
    request = Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8")
        try:
            return json.loads(body)
        except (TypeError, ValueError):
            return {"error": "QA browser tools returned invalid JSON"}
    except HTTPError as error:
        # The loopback server returns only validated, redacted error messages.
        try:
            detail = json.loads(error.read(8192).decode("utf-8")).get("error", "")
            return {"error": str(detail).replace(token, "[redacted]") or "QA browser tools request failed"}
        except (AttributeError, TypeError, ValueError, OSError):
            return {"error": "QA browser tools request failed"}
    except (URLError, TimeoutError, OSError):
        return {"error": "QA browser tools request failed; refresh state before retrying an upload"}


def _checkpoint(args, **kwargs):
    return json.dumps(_post({
        "action": "capture",
        "checkId": args["checkId"],
        "url": args["url"],
    }))


def _upload_fixture(args, **kwargs):
    payload = {
        "action": "upload",
        "checkId": args["checkId"],
        "url": args["url"],
        "fixture": args["fixture"],
    }
    if args.get("selector") is not None:
        payload["selector"] = args["selector"]
    return json.dumps(_post(payload))


def register(ctx):
    ctx.register_tool(
        name="qa_checkpoint",
        toolset="qa_browser_tools",
        schema={"name": "qa_checkpoint", "description": "Capture runner-owned evidence before changing the current page.", "parameters": {
            "type": "object",
            "properties": {
                "checkId": {"type": "string"},
                "url": {"type": "string"},
            },
            "required": ["checkId", "url"],
            "additionalProperties": False,
        }},
        handler=_checkpoint,
        description="Capture a QA browser checkpoint for the current page.",
    )
    ctx.register_tool(
        name="qa_upload_fixture",
        toolset="qa_browser_tools",
        schema={"name": "qa_upload_fixture", "description": "Attach approved fixture bytes to the current page. Returns a receipt, not a product verdict.", "parameters": {
            "type": "object",
            "properties": {
                "checkId": {"type": "string"},
                "url": {"type": "string"},
                "fixture": {"type": "string"},
                "selector": {"type": "string"},
            },
            "required": ["checkId", "url", "fixture"],
            "additionalProperties": False,
        }},
        handler=_upload_fixture,
        description="Upload a symbolic QA fixture through the browser tools server.",
    )
`;

/** Boot-critical files copied into the ephemeral home. Never memories/sessions. */
const HERMES_HOME_BOOT_FILES = ["auth.json", "config.yaml", ".env", "SOUL.md"];

/**
 * Seed a throwaway HERMES_HOME so every Hermes run boots stateless: empty
 * memories/ and sessions/, so nothing from one QA run leaks into the next.
 * Only boot-critical, non-learned files (auth, model config, persona) are
 * copied from the real ~/.hermes. Returns the path plus cleanup() to delete it.
 */
export function prepareEphemeralHermesHome() {
  const realHome = join(homedir(), ".hermes");
  const path = mkdtempSync(join(tmpdir(), "hermes-qa-home-"));
  for (const name of HERMES_HOME_BOOT_FILES) {
    const src = join(realHome, name);
    if (existsSync(src)) cpSync(src, join(path, name));
  }
  return {
    path,
    cleanup() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

function replaceTopLevelYamlSection(text, section, replacement) {
  const lines = text.split(/\r?\n/);
  const key = new RegExp(`^(?:${section}|"${section}"|'${section}')\\s*:`);
  // YAML comments do not end an indented mapping.
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    if (!key.test(lines[start])) continue;
    let end = start + 1;
    while (end < lines.length && (lines[end].trim() === "" || /^\s|^#/.test(lines[end]))) end += 1;
    lines.splice(start, end - start);
  }
  return `${lines.join("\n").trimEnd()}\n${replacement}\n`;
}

function isolateEphemeralHermesPluginConfig(hermesHome, enabledPlugins) {
  const configPath = join(hermesHome, "config.yaml");
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const enabled = enabledPlugins.map(name => `    - ${name}`).join("\n");
  const isolatedPlugins = `plugins:\n  enabled:${enabled ? `\n${enabled}` : " []"}\n  disabled: []`;
  writeFileSync(
    configPath,
    replaceTopLevelYamlSection(config, "plugins", isolatedPlugins),
    "utf8",
  );
}

/** Install only the QA bridge in an ephemeral Hermes home. */
export function installEphemeralHermesBrowserTools(hermesHome, browserTools) {
  if (!browserTools || typeof browserTools !== "object") {
    throw new UsageError("browserTools must include url and token");
  }
  const url = typeof browserTools.url === "string" ? browserTools.url.trim() : "";
  const token = typeof browserTools.token === "string" ? browserTools.token : "";
  if (!url || !token) {
    throw new UsageError("browserTools must include url and token");
  }

  const pluginDir = join(hermesHome, "plugins", HERMES_QA_BROWSER_PLUGIN_DIR);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "plugin.yaml"), HERMES_QA_BROWSER_PLUGIN_MANIFEST, "utf8");
  writeFileSync(join(pluginDir, "__init__.py"), HERMES_QA_BROWSER_PLUGIN_SOURCE, "utf8");

  isolateEphemeralHermesPluginConfig(hermesHome, [HERMES_QA_BROWSER_PLUGIN_NAME]);
}

export function resolveHermesAgentInvocation() {
  const installRoot = join(homedir(), ".hermes", "hermes-agent");
  const localPython = join(installRoot, "venv", "bin", "python");
  const localRunner = join(installRoot, "run_agent.py");
  if (existsSync(localPython) && existsSync(localRunner)) {
    return { command: localPython, baseArgs: [localRunner] };
  }

  const localInstallBin = join(
    homedir(),
    ".hermes",
    "hermes-agent",
    "venv",
    "bin",
    REQUIRED_HERMES_AGENT_BIN
  );
  if (existsSync(localInstallBin)) {
    return { command: localInstallBin, baseArgs: [] };
  }

  return { command: REQUIRED_HERMES_AGENT_BIN, baseArgs: [] };
}

export function readHermesModelConfig() {
  const envModel = process.env.HERMES_INFERENCE_MODEL?.trim();
  if (envModel) {
    return {
      model: envModel,
      baseUrl: process.env.HERMES_INFERENCE_BASE_URL?.trim() || null,
    };
  }

  const configPath = join(homedir(), ".hermes", "config.yaml");
  if (!existsSync(configPath)) {
    return { model: null, baseUrl: null };
  }

  const text = readFileSync(configPath, "utf8");
  const readField = name => {
    const match = text.match(new RegExp(`^  ${name}:\\s*(.+)$`, "m"));
    if (!match) return null;
    return match[1].trim().replace(/^['"]|['"]$/g, "");
  };

  return {
    model: readField("default") || readField("model"),
    baseUrl: readField("base_url"),
  };
}

export function buildHermesAgentArgs(
  query,
  maxTurns,
  { disabledToolsets = null, verbose = false } = {}
) {
  const { model, baseUrl } = readHermesModelConfig();
  if (!model) {
    throw new EnvironmentError(
      "Hermes model is not configured. Set model.default in ~/.hermes/config.yaml or export HERMES_INFERENCE_MODEL."
    );
  }

  const args = [
    `--query=${query}`,
    `--max_turns=${maxTurns}`,
    `--model=${model}`,
  ];
  if (baseUrl) args.push(`--base_url=${baseUrl}`);
  // Fire splits on commas unless the value is quoted: --disabled_toolsets="a,b,c"
  if (disabledToolsets) {
    args.push(`--disabled_toolsets="${disabledToolsets}"`);
  }
  if (verbose) args.push("--verbose");
  return args;
}

/**
 * An agent that never started is an environment failure, not unusable output.
 * Hermes prints its own diagnosis and exits 0, so without this the run surfaces
 * as "did not return valid JSON" (exit 4) and sends the operator hunting for a
 * parser bug instead of an unset API key.
 */
function throwIfHermesDidNotStart(output, rawOutputPath = null) {
  const artifactHint = rawOutputPath ? ` See raw output: ${rawOutputPath}` : "";

  if (/API key was rejected|PermissionDeniedError|HTTP 403/i.test(output)) {
    throw new EnvironmentError(
      `Hermes API key was rejected or permission denied.${artifactHint}`
    );
  }

  const failedToInit = output.match(/Failed to initialize agent:\s*(.+)/i);
  if (failedToInit) {
    throw new EnvironmentError(
      `Hermes could not start: ${failedToInit[1].trim()}${artifactHint}`,
      {
        hint: "Fix the provider/model in ~/.hermes/config.yaml (or `hermes model`), then re-run. `doctor` checks this before a run.",
      }
    );
  }
}

/**
 * @param {"browse"|"text-only"} [options.mode]
 *   text-only — disable browser/terminal toolsets (abstract-ai, review)
 *   browse — full toolsets (judge)
 */
export function runHermes(
  query,
  maxTurns,
  {
    paths = null,
    secrets = [],
    requiredKeys = ["status"],
    requiredKeyGroups = null,
    mode = "browse",
    disabledToolsets: callerDisabledToolsets = null,
    browserTools = null,
  } = {}
) {
  if (HERMES_QA_COMMAND !== REQUIRED_HERMES_AGENT_BIN) {
    throw new UsageError(
      `Hermes command must be exactly ${REQUIRED_HERMES_AGENT_BIN}. Got: ${JSON.stringify(HERMES_QA_COMMAND)}`
    );
  }

  const disabledToolsets = mergeDisabledToolsets(
    mode === "text-only" ? HERMES_QA_TEXT_ONLY_BASELINE_DISABLED_TOOLSETS : null,
    mode === "text-only" ? HERMES_QA_TEXT_ONLY_DISABLED_TOOLSETS : null,
    callerDisabledToolsets,
    HERMES_QA_STATELESS_DISABLED_TOOLSETS,
  );

  const invocation = resolveHermesAgentInvocation();
  writeAgentQueryArtifact(paths, query, secrets);

  // Fresh HERMES_HOME per run: empty memories/ and sessions/ so nothing learned
  // in one QA run carries into the next. Torn down as soon as Hermes exits.
  const hermesHome = prepareEphemeralHermesHome();
  const timeout = resolveHermesTimeoutMs();
  let result;
  try {
    const browserToolsEnabled = mode === "browse" && browserTools !== null;
    if (browserToolsEnabled) {
      installEphemeralHermesBrowserTools(hermesHome.path, browserTools);
    } else {
      isolateEphemeralHermesPluginConfig(hermesHome.path, []);
    }
    const childEnv = {
      ...process.env,
      HERMES_HOME: hermesHome.path,
      // Project plugins are not part of this run's isolated tool surface.
      HERMES_ENABLE_PROJECT_PLUGINS: "",
    };
    delete childEnv.QA_BROWSER_TOOLS_URL;
    delete childEnv.QA_BROWSER_TOOLS_TOKEN;
    if (browserToolsEnabled) {
      childEnv.QA_BROWSER_TOOLS_URL = browserTools.url.trim();
      childEnv.QA_BROWSER_TOOLS_TOKEN = browserTools.token;
    }
    result = spawnSync(
      invocation.command,
      [
        ...invocation.baseArgs,
        ...buildHermesAgentArgs(query, maxTurns, { disabledToolsets }),
      ],
      {
        shell: false,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 10,
        env: childEnv,
        timeout,
      }
    );
  } finally {
    hermesHome.cleanup();
  }

  return finalizeAgentRun(result, {
    adapterLabel: "Hermes",
    command: invocation.command,
    paths,
    secrets,
    requiredKeys,
    requiredKeyGroups,
    timeoutMs: timeout,
    timeoutHint:
      "Raise HERMES_QA_TIMEOUT_MS if Hermes legitimately needs longer.",
    inspect: throwIfHermesDidNotStart,
  });
}
