import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs, TextDecoder } from "node:util";

const INTEGRITY_KEY_ENV = "QA_NATIVE_INTEGRITY_KEY";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_PRIVATE_JSON_BYTES = 4 * 1024 * 1024;
const REPORT_OPTIONS = new Set(["run-dir", "repository-root", "revision", "judgment"]);
const REPORT_COMMANDS = new Set(["diagnose", "suggest-fix", "report"]);
const COMMAND_OPTIONS = Object.freeze({
  execute: new Set(["spec", "base-url", "run-dir", "provider", "mode"]),
  judge: new Set(["run-dir"]),
  replay: new Set(["run-dir"]),
  diagnose: REPORT_OPTIONS,
  "suggest-fix": REPORT_OPTIONS,
  report: REPORT_OPTIONS,
});
const COMMAND_USAGE = Object.freeze({
  execute: "qa-native execute --spec=<file> --base-url=<url> --run-dir=.qa/runs/<id> [--provider=playwright --mode=strict | --provider=hermes --mode=adaptive]",
  judge: "qa-native judge --run-dir=.qa/runs/<id>",
  replay: "qa-native replay --run-dir=.qa/runs/<id>",
  diagnose: "qa-native diagnose --run-dir=.qa/runs/<id> --repository-root=. [--revision=<commit>] [--judgment=<result.json>]",
  "suggest-fix": "qa-native suggest-fix --run-dir=.qa/runs/<id> --repository-root=. [--revision=<commit>] [--judgment=<result.json>]",
  report: "qa-native report --run-dir=.qa/runs/<id> --repository-root=. [--revision=<commit>] [--judgment=<result.json>]",
});

export function decodeIntegrityKey(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new CliError("integrity key is missing or invalid");
  }
  const key = Buffer.from(value, "base64");
  if (key.byteLength < 32 || key.toString("base64") !== value) throw new CliError("integrity key is missing or invalid");
  return key;
}

export function resolvePrivateQaPath(value, { cwd = process.cwd() } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || isAbsolute(value)) throw new CliError("run directory must be a private .qa path");
  const parts = value.split(/[\\/]+/);
  if (parts.length < 2 || parts[0] !== ".qa" || parts.some((part) => part === "" || part === "." || part === "..")) throw new CliError("run directory must be a private .qa path");
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
  const restoreProcessKey = env !== process.env;
  const previousProcessKey = restoreProcessKey ? process.env[INTEGRITY_KEY_ENV] : undefined;
  try {
    const request = parseRequest(argv);
    if (request.help) {
      stdout(helpText(Object.keys(handlers)));
      return 0;
    }
    const handler = handlers[request.command];
    if (typeof handler !== "function") throw new CliError("command is not available");
    if (platform === "win32") throw new CliError("command is not supported on this platform");
    integrityKey = decodeIntegrityKey(env[INTEGRITY_KEY_ENV]);
    delete process.env[INTEGRITY_KEY_ENV];
    const normalized = normalizeRequest(request, cwd);
    const status = await handler({ ...normalized, integrityKey });
    return Number.isInteger(status) ? status : 0;
  } catch (error) {
    stderr(`qa-native: ${error instanceof CliError ? error.message : "command failed"}\n`);
    return 1;
  } finally {
    integrityKey?.fill(0);
    if (restoreProcessKey && previousProcessKey !== undefined) process.env[INTEGRITY_KEY_ENV] = previousProcessKey;
    else delete process.env[INTEGRITY_KEY_ENV];
  }
}

function helpText(commands) {
  const available = commands.filter((command) => COMMAND_USAGE[command]);
  return `qa-native — evidence-driven Playwright QA runtime

Usage:
${available.map((command) => `  ${COMMAND_USAGE[command]}`).join("\n") || "  No runtime commands are installed."}

Environment:
  QA_NATIVE_INTEGRITY_KEY  Canonical base64 encoding of at least 32 random bytes
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
        provider: { type: "string" },
        mode: { type: "string" },
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
  const required = command === "execute" ? ["spec", "base-url", "run-dir"] : REPORT_COMMANDS.has(command) ? ["run-dir", "repository-root"] : ["run-dir"];
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
    return Object.freeze({
      command: request.command,
      cwd,
      runDirectory,
      specPath: resolveRegularInput(request.options.spec, { root: cwd, label: "spec" }),
      baseUrl: safeBaseUrl(request.options["base-url"]),
      provider,
      mode,
    });
  }

  assertPrivateDirectory(runDirectory);
  if (!REPORT_COMMANDS.has(request.command)) return Object.freeze({ command: request.command, cwd, runDirectory });
  const repositoryRoot = resolveRepositoryRoot(request.options["repository-root"], cwd);
  const judgmentPath = request.options.judgment === undefined ? undefined : resolveRegularInput(request.options.judgment, { root: runDirectory, label: "judgment" });
  return Object.freeze({
    command: request.command,
    cwd,
    runDirectory,
    repositoryRoot,
    revision: safeRevision(request.options.revision ?? "HEAD"),
    ...(judgmentPath === undefined ? {} : { judgmentPath }),
  });
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
class CliError extends Error {}
