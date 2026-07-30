import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs, TextDecoder } from "node:util";

const DEBUG_ENV = "QA_NATIVE_DEBUG";
const INTEGRITY_KEY_ENV = "QA_NATIVE_INTEGRITY_KEY";
const PUBLICATION_KEY_ENV = "QA_NATIVE_PUBLICATION_KEY";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_STORAGE_STATE_PATH = [".private", "storage-state.json"];
const MAX_PRIVATE_JSON_BYTES = 4 * 1024 * 1024;
const REPORT_OPTIONS = new Set(["run-dir", "repository-root", "revision", "judgment"]);
const REPORT_COMMANDS = new Set(["diagnose", "suggest-fix", "report", "propose-patch", "verify-patch"]);
const PUBLISH_ISSUE_OPTIONS = new Set([...REPORT_OPTIONS, "repository"]);
const REMEDIATION_OPTIONS = new Set([...PUBLISH_ISSUE_OPTIONS, "publish"]);
const PUBLICATION_COMMANDS = new Set(["publish-issue", "publish", "remediate"]);
const COMMAND_OPTIONS = Object.freeze({
  execute: new Set(["spec", "base-url", "run-dir", "provider", "mode", "storage-state", "auth-bootstrap", "allowed-origin", "allow-partial", "budget-actions", "budget-turns", "budget-time-ms", "budget-tokens"]),
  judge: new Set(["run-dir", "fail-on"]),
  replay: new Set(["run-dir"]),
  diagnose: REPORT_OPTIONS,
  "suggest-fix": REPORT_OPTIONS,
  report: REPORT_OPTIONS,
  "propose-patch": REPORT_OPTIONS,
  "verify-patch": REPORT_OPTIONS,
  "publish-issue": PUBLISH_ISSUE_OPTIONS,
  publish: REMEDIATION_OPTIONS,
  remediate: REMEDIATION_OPTIONS,
});
const COMMAND_USAGE = Object.freeze({
  execute: "qa-native execute --spec=<file> --base-url=<url> --run-dir=.qa/runs/<id> [--storage-state=<file> (default .private/storage-state.json when present) --auth-bootstrap=.private/auth-bootstrap.json --allowed-origin=https://api.example.com --provider=playwright --mode=strict | --provider=hermes --mode=adaptive --allow-partial --budget-actions=<n> --budget-turns=<n> --budget-time-ms=<n> --budget-tokens=<n>]",
  judge: "qa-native judge --run-dir=.qa/runs/<id> [--fail-on=fail|manual-review]",
  replay: "qa-native replay --run-dir=.qa/runs/<id>",
  diagnose: "qa-native diagnose --run-dir=.qa/runs/<id> --repository-root=. [--revision=<commit>] [--judgment=<result.json>]",
  "suggest-fix": "qa-native suggest-fix --run-dir=.qa/runs/<id> --repository-root=. [--revision=<commit>] [--judgment=<result.json>]",
  report: "qa-native report --run-dir=.qa/runs/<id> --repository-root=. [--revision=<commit>] [--judgment=<result.json>]",
  "propose-patch": "qa-native propose-patch --run-dir=.qa/runs/<id> --repository-root=. [--revision=<commit>] [--judgment=<result.json>]",
  "verify-patch": "qa-native verify-patch --run-dir=.qa/runs/<id> --repository-root=. [--revision=<commit>] [--judgment=<result.json>]",
  "publish-issue": "qa-native publish-issue --run-dir=.qa/runs/<id> --repository-root=. --repository=<owner/repository> [--revision=<commit>] [--judgment=<result.json>]",
  publish: "qa-native publish --run-dir=.qa/runs/<id> --repository-root=. --repository=<owner/repository> --publish=auto [--revision=<commit>] [--judgment=<result.json>]",
  remediate: "qa-native remediate --run-dir=.qa/runs/<id> --repository-root=. --repository=<owner/repository> --publish=auto [--revision=<commit>] [--judgment=<result.json>]",
});

export function decodeIntegrityKey(value) {
  return decodeKey(value, "integrity");
}

export function decodePublicationKey(value) {
  return decodeKey(value, "publication");
}

function decodeKey(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new CliError(`${label} key is missing or invalid`);
  }
  const key = Buffer.from(value, "base64");
  if (key.byteLength < 32 || key.toString("base64") !== value) throw new CliError(`${label} key is missing or invalid`);
  return key;
}

export function resolvePrivateQaPath(value, { cwd = process.cwd() } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || isAbsolute(value)) throw new CliError("run directory must be a private .qa path");
  const parts = value.split(/[\\/]+/);
  if (parts.length < 2 || parts[0] !== ".qa" || parts.some((part) => part === "" || part === "." || part === "..")) throw new CliError("run directory must be a private .qa path");
  // <run-dir>.invalid holds evidence that failed validation (see qa-native-execute preserveInvalidRun);
  // no command may read it back, so a rejected run can never become a verdict or a report.
  if (parts.some((part) => part.endsWith(".invalid"))) throw new CliError("run directory is quarantined invalid evidence");
  const root = resolve(cwd, ".qa");
  const target = resolve(cwd, ...parts);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new CliError("run directory must be a private .qa path");
  assertSafeExistingComponents(root, target);
  return target;
}

export function createExclusiveQaDirectory(value, { cwd = process.cwd() } = {}) {
  const target = resolvePrivateQaPath(value, { cwd });
  const root = resolve(cwd, ".qa");
  ensurePrivateDirectory(root);
  const parts = relative(root, target).split(sep);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    ensurePrivateDirectory(current);
  }
  try {
    mkdirSync(target, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error?.code === "EEXIST") throw new CliError("run directory already exists");
    throw error;
  }
  assertPrivateDirectory(target);
  return target;
}

export function writePrivateJsonExclusive(value, payload, { cwd = process.cwd() } = {}) {
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new CliError("output is not JSON-serializable");
  }
  if (serialized === undefined) throw new CliError("output is not JSON-serializable");
  return writePrivateFileExclusive(value, `${serialized}\n`, { cwd });
}

export function readPrivateJson(value, { cwd = process.cwd() } = {}) {
  const target = resolvePrivateQaPath(value, { cwd });
  assertPrivateDirectory(dirname(target));
  let descriptor;
  try {
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_PRIVATE_JSON_BYTES) throw new CliError("private JSON input is invalid");
    const buffer = Buffer.alloc(MAX_PRIVATE_JSON_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PRIVATE_JSON_BYTES) throw new CliError("private JSON input is invalid");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("private JSON input is invalid");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writePrivateFileExclusive(value, content, { cwd = process.cwd() } = {}) {
  const target = resolvePrivateQaPath(value, { cwd });
  assertPrivateDirectory(dirname(target));
  if (typeof content !== "string" && !(content instanceof Uint8Array)) throw new CliError("output content is invalid");
  try {
    writeFileSync(target, content, { flag: "wx", mode: PRIVATE_FILE_MODE });
  } catch (error) {
    if (error?.code === "EEXIST") throw new CliError("output already exists");
    throw error;
  }
  return target;
}

export async function runQaNative(argv, {
  cwd = process.cwd(),
  env = process.env,
  handlers = {},
  platform = process.platform,
  stdout = (value) => process.stdout.write(value),
  stderr = (value) => process.stderr.write(value),
} = {}) {
  let integrityKey;
  let publicationKey;
  let commandLabel = "command";
  const restoreProcessKey = env !== process.env;
  const previousProcessKey = restoreProcessKey ? process.env[INTEGRITY_KEY_ENV] : undefined;
  const previousPublicationKey = restoreProcessKey ? process.env[PUBLICATION_KEY_ENV] : undefined;
  try {
    const request = parseRequest(argv);
    if (request.help) {
      stdout(helpText(Object.keys(handlers)));
      return 0;
    }
    if (typeof request.command === "string") commandLabel = request.command;
    const handler = handlers[request.command];
    if (typeof handler !== "function") throw new CliError("command is not available");
    if (platform === "win32") throw new CliError("command is not supported on this platform");
    integrityKey = decodeIntegrityKey(env[INTEGRITY_KEY_ENV]);
    if (PUBLICATION_COMMANDS.has(request.command)) publicationKey = decodePublicationKey(env[PUBLICATION_KEY_ENV]);
    delete process.env[INTEGRITY_KEY_ENV];
    delete process.env[PUBLICATION_KEY_ENV];
    const normalized = normalizeRequest(request, cwd);
    const status = await handler({ ...normalized, integrityKey, ...(publicationKey === undefined ? {} : { publicationKey }) });
    return Number.isInteger(status) ? status : 0;
  } catch (error) {
    // CliError messages are user-facing. For internal errors we surface the failure category — the
    // error's stable .code or its class name, both free of payload — so a failure is never silently
    // swallowed (AGENTS.md §3-4), while the raw message/stack (which may embed sensitive data such as
    // evidence bytes) stays behind QA_NATIVE_DEBUG.
    let detail;
    if (error instanceof CliError) {
      detail = error.message;
    } else if (env[DEBUG_ENV]) {
      detail = error?.stack ?? String(error?.message ?? error);
    } else {
      const cause = typeof error?.code === "string" ? error.code : (error?.constructor?.name ?? "Error");
      detail = `${commandLabel} failed: ${cause}`;
    }
    stderr(`qa-native: ${detail}\n`);
    return 1;
  } finally {
    integrityKey?.fill(0);
    publicationKey?.fill(0);
    if (restoreProcessKey && previousProcessKey !== undefined) process.env[INTEGRITY_KEY_ENV] = previousProcessKey;
    else delete process.env[INTEGRITY_KEY_ENV];
    if (restoreProcessKey && previousPublicationKey !== undefined) process.env[PUBLICATION_KEY_ENV] = previousPublicationKey;
    else delete process.env[PUBLICATION_KEY_ENV];
  }
}

function helpText(commands) {
  const available = commands.filter((command) => COMMAND_USAGE[command]);
  return `qa-native — evidence-driven Playwright QA runtime

Usage:
${available.map((command) => `  ${COMMAND_USAGE[command]}`).join("\n") || "  No runtime commands are installed."}

Environment:
  QA_NATIVE_INTEGRITY_KEY  Canonical base64 encoding of at least 32 random bytes
  QA_NATIVE_PUBLICATION_KEY  Stable canonical base64 key for GitHub publication HMAC state
`;
}

function parseRequest(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        spec: { type: "string" },
        "base-url": { type: "string" },
        "run-dir": { type: "string" },
        "repository-root": { type: "string" },
        revision: { type: "string" },
        judgment: { type: "string" },
        repository: { type: "string" },
        publish: { type: "string" },
        provider: { type: "string" },
        mode: { type: "string" },
        "storage-state": { type: "string" },
        "auth-bootstrap": { type: "string" },
        "allowed-origin": { type: "string" },
        "allow-partial": { type: "boolean" },
        "fail-on": { type: "string" },
        "budget-actions": { type: "string" },
        "budget-turns": { type: "string" },
        "budget-time-ms": { type: "string" },
        "budget-tokens": { type: "string" },
      },
    });
  } catch {
    throw new CliError("invalid command arguments");
  }
  if (parsed.values.help || (parsed.positionals.length === 0 && Object.keys(parsed.values).length === 0)) return { help: true };
  if (parsed.positionals.length !== 1 || !COMMAND_OPTIONS[parsed.positionals[0]]) throw new CliError("unknown command");
  const command = parsed.positionals[0];
  const supplied = Object.keys(parsed.values).filter((key) => key !== "help");
  if (supplied.some((key) => !COMMAND_OPTIONS[command].has(key))) throw new CliError("invalid command arguments");
  const required = command === "execute" ? ["spec", "base-url", "run-dir"] : PUBLICATION_COMMANDS.has(command) ? ["run-dir", "repository-root", "repository"] : REPORT_COMMANDS.has(command) ? ["run-dir", "repository-root"] : ["run-dir"];
  if (required.some((key) => typeof parsed.values[key] !== "string" || parsed.values[key].length === 0)) throw new CliError("required command argument is missing");
  return { command, options: Object.freeze({ ...parsed.values }) };
}

function normalizeRequest(request, cwd) {
  const runDirectory = resolvePrivateQaPath(request.options["run-dir"], { cwd });
  if (request.command === "execute") {
    if (lstatIfExists(runDirectory)) throw new CliError("run directory already exists");
    const provider = request.options.provider ?? "playwright";
    const mode = request.options.mode ?? "strict";
    if (!((provider === "playwright" && mode === "strict") || (provider === "hermes" && mode === "adaptive"))) throw new CliError("execution provider and mode combination is unsupported");
    const storageStatePath = request.options["storage-state"] === undefined
      ? defaultStorageStatePath(cwd)
      : resolvePrivateRegularInput(request.options["storage-state"], { root: cwd, label: "storage state" });
    const authBootstrapPath = request.options["auth-bootstrap"] === undefined
      ? undefined
      : resolveRegularInput(request.options["auth-bootstrap"], { root: cwd, label: "auth bootstrap" });
    const budgetOverrides = {
      ...(request.options["budget-actions"] === undefined ? {} : { actions: safePositiveInteger(request.options["budget-actions"], "budget actions") }),
      ...(request.options["budget-turns"] === undefined ? {} : { turns: safePositiveInteger(request.options["budget-turns"], "budget turns") }),
      ...(request.options["budget-time-ms"] === undefined ? {} : { timeMs: safePositiveInteger(request.options["budget-time-ms"], "budget time") }),
      ...(request.options["budget-tokens"] === undefined ? {} : { tokens: safePositiveInteger(request.options["budget-tokens"], "budget tokens") }),
    };
    return Object.freeze({
      command: request.command,
      cwd,
      runDirectory,
      specPath: resolveRegularInput(request.options.spec, { root: cwd, label: "spec" }),
      baseUrl: safeBaseUrl(request.options["base-url"]),
      provider,
      mode,
      ...(storageStatePath === undefined ? {} : { storageStatePath }),
      ...(authBootstrapPath === undefined ? {} : { authBootstrapPath }),
      ...(request.options["allowed-origin"] === undefined ? {} : { allowedOrigins: parseAllowedOrigins(request.options["allowed-origin"]) }),
      ...(request.options["allow-partial"] ? { allowPartial: true } : {}),
      ...(Object.keys(budgetOverrides).length === 0 ? {} : { budgetOverrides }),
    });
  }

  assertPrivateDirectory(runDirectory);
  if (!REPORT_COMMANDS.has(request.command) && !PUBLICATION_COMMANDS.has(request.command)) {
    const failOn = request.options["fail-on"] === undefined ? undefined : safeFailOn(request.options["fail-on"]);
    return Object.freeze({ command: request.command, cwd, runDirectory, ...(failOn === undefined ? {} : { failOn }) });
  }
  const repositoryRoot = resolveRepositoryRoot(request.options["repository-root"], cwd);
  const judgmentPath = request.options.judgment === undefined ? undefined : resolveRegularInput(request.options.judgment, { root: runDirectory, label: "judgment" });
  return Object.freeze({
    command: request.command,
    cwd,
    runDirectory,
    repositoryRoot,
    ...(PUBLICATION_COMMANDS.has(request.command) ? { repository: safeRepositorySlug(request.options.repository) } : {}),
    ...(["publish", "remediate"].includes(request.command) ? { publish: safePublishMode(request.options.publish ?? "auto") } : {}),
    revision: safeRevision(request.options.revision ?? "HEAD"),
    ...(judgmentPath === undefined ? {} : { judgmentPath }),
  });
}

function parseAllowedOrigins(value) {
  const origins = value.split(",").filter(Boolean);
  if (origins.length === 0 || origins.length > 7) throw new CliError("allowed origin is invalid");
  for (const origin of origins) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new CliError("allowed origin is invalid");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new CliError("allowed origin is invalid");
  }
  return Object.freeze(origins);
}

function safePositiveInteger(value, label) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new CliError(`${label} must be a positive integer`);
  return Number(value);
}

function safeFailOn(value) {
  if (value !== "fail" && value !== "manual-review") throw new CliError("fail-on must be fail or manual-review");
  return value;
}

function safePublishMode(value) {
  if (value !== "auto") throw new CliError("publish mode must be auto");
  return value;
}

function safeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("base URL is invalid");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new CliError("base URL is invalid");
  return url.href;
}

function resolveRegularInput(value, { root, label }) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || isAbsolute(value)) throw new CliError(`${label} path is invalid`);
  const parts = value.split(/[\\/]+/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new CliError(`${label} path is invalid`);
  const canonicalRoot = realpathSync(root);
  const target = resolve(canonicalRoot, ...parts);
  const fromRoot = relative(canonicalRoot, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new CliError(`${label} path is invalid`);
  assertSafeExistingComponents(canonicalRoot, target);
  const stat = lstatIfExists(target);
  if (!stat?.isFile()) throw new CliError(`${label} path is invalid`);
  return target;
}

function resolvePrivateRegularInput(value, { root, label }) {
  const target = resolveRegularInput(value, { root, label });
  if ((lstatSync(target).mode & 0o077) !== 0) throw new CliError(`${label} must be private`);
  return target;
}

// Shared login: drop a private (0600) Playwright storageState at
// .private/storage-state.json and every execute in this project reuses it
// without --storage-state. Absent file keeps the unauthenticated default.
function defaultStorageStatePath(cwd) {
  const candidate = resolve(realpathSync(cwd), ...DEFAULT_STORAGE_STATE_PATH);
  if (lstatIfExists(candidate) === undefined) return undefined;
  return resolvePrivateRegularInput(DEFAULT_STORAGE_STATE_PATH.join("/"), { root: cwd, label: "storage state" });
}

function resolveRepositoryRoot(value, cwd) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new CliError("repository root is invalid");
  let target;
  try {
    target = realpathSync(resolve(cwd, value));
  } catch {
    throw new CliError("repository root is invalid");
  }
  if (!lstatSync(target).isDirectory()) throw new CliError("repository root is invalid");
  return target;
}

function safeRevision(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,199}$/.test(value)) throw new CliError("repository revision is invalid");
  return value;
}

function safeRepositorySlug(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value) || value.split("/").some((part) => part === "." || part === "..")) throw new CliError("GitHub repository is invalid");
  return value;
}

function assertSafeExistingComponents(root, target) {
  const relativeParts = relative(root, target).split(sep);
  let current = root;
  for (const part of ["", ...relativeParts]) {
    if (part) current = join(current, part);
    const stat = lstatIfExists(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new CliError("run path contains a symbolic link");
    if (current !== target && !stat.isDirectory()) throw new CliError("run path contains a non-directory component");
  }
}

function ensurePrivateDirectory(path) {
  if (!lstatIfExists(path)) mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
  assertPrivateDirectory(path);
}

function assertPrivateDirectory(path) {
  const stat = lstatIfExists(path);
  if (!stat) throw new CliError("run directory does not exist");
  if (stat.isSymbolicLink()) throw new CliError("run path contains a symbolic link");
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new CliError("run directory must be private");
}

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

// ponytail: .qa is single-process private storage; use descriptor-relative no-follow I/O before supporting shared writers.
// CliError messages are printed to the operator verbatim (see runQaNative), so they must never
// embed evidence bytes or secrets — only controlled, enumerable detail.
export class CliError extends Error {}
