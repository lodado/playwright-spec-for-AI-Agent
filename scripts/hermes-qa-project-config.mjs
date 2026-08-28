import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { UsageError } from "./errors.mjs";

const CONFIG_FILENAMES = [
  "playwright-spec-for-ai-agent.config.mjs",
  "playwright-spec-for-ai-agent.config.js",
  "playwright-spec-for-ai-agent.config.cjs",
  "playwright-spec-for-ai-agent.config.json",
  "hermes-qa.config.mjs",
  "hermes-qa.config.js",
  "hermes-qa.config.cjs",
  "hermes-qa.config.json",
  "playwright-spec-qa.config.mjs",
  "playwright-spec-qa.config.js",
  "playwright-spec-qa.config.cjs",
  "playwright-spec-qa.config.json",
];

export const DEFAULT_PATH_TEMPLATES = {
  specDir: "src/page/{page}/__tests__",
  outputDir: "src/page/{page}/__QA__",
};

export const DEFAULT_STAGING_ACCOUNT = {
  authRequired: true,
  expectedPlan: "",
  expectedSubscriptionStatus: "",
  accountNotes: "",
  fixtures: {},
};

/** The live-run verbs a `livePolicies` entry may name. */
export const LIVE_RUN_POLICIES = [
  "executable-readonly",
  "executable-interaction",
  "judgment-interaction-no-confirm",
  "judgment-mock-api",
  "blocked-subscription-mutation",
  "blocked-auth-mock",
  "blocked-live-skip",
];

const TOP_LEVEL_KEYS = [
  "root",
  "paths",
  "pages",
  "targetPaths",
  "staging",
  "fixtures",
  "livePolicies",
  "hooks",
];
const PATHS_KEYS = ["specDir", "outputDir"];
const ACCOUNT_KEYS = [
  "authRequired",
  "expectedPlan",
  "expectedSubscriptionStatus",
  "expectedAccountState",
  "accountNotes",
  "fixtures",
];
const URL_KEYS = ["baseUrl", "loginPath", "allowedOrigins", "versionUrl", "storageState"];
const STAGING_KEYS = [...ACCOUNT_KEYS, ...URL_KEYS, "dashboardPath"];
const PAGE_KEYS = [
  ...ACCOUNT_KEYS,
  ...URL_KEYS,
  "targetPath",
  "pageUrl",
  "specDir",
  "outputDir",
];
const LIVE_POLICY_KEYS = ["liveRunPolicy", "stagingMode"];
const HOOK_KEYS = ["onJudgment", "onReview"];

/** @type {Record<string, unknown> | null} */
let activeConfig = null;
/** @type {string} */
let activeOverrideSignature = "";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = deepMerge(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function applyPathTemplate(template, { page, root }) {
  return template
    .replaceAll("{page}", page)
    .replaceAll("{root}", root);
}

function parsePathOverrides(argv) {
  const overrides = {
    configPath: "",
    root: "",
    specDir: "",
    outputDir: "",
    strict: process.env.QA_STRICT_CONFIG === "1",
  };

  for (const arg of argv) {
    if (arg === "--strict-config") {
      overrides.strict = true;
    } else if (arg.startsWith("--config=")) {
      overrides.configPath = arg.slice("--config=".length).trim();
    } else if (arg.startsWith("--project-root=")) {
      overrides.root = arg.slice("--project-root=".length).trim();
    } else if (arg.startsWith("--root=")) {
      overrides.root = arg.slice("--root=".length).trim();
    } else if (arg.startsWith("--spec-dir=")) {
      overrides.specDir = arg.slice("--spec-dir=".length).trim();
    } else if (arg.startsWith("--output-dir=")) {
      overrides.outputDir = arg.slice("--output-dir=".length).trim();
    }
  }

  return overrides;
}

function findConfigFile(startDir) {
  let current = resolve(startDir);
  const seen = new Set();

  while (!seen.has(current)) {
    seen.add(current);
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

async function importConfigModule(configPath) {
  const ext = extname(configPath);
  if (ext === ".json") {
    return JSON.parse(readFileSync(configPath, "utf8"));
  }
  if (ext === ".cjs") {
    const require = createRequire(import.meta.url);
    const loaded = require(configPath);
    return loaded?.default ?? loaded;
  }
  const module = await import(pathToFileURL(configPath).href);
  return module.default ?? module;
}

function editDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = previous[j];
      previous[j] = next;
    }
  }
  return previous[b.length];
}

/** Closest allowlisted key, or "" when nothing is near enough to suggest. */
function suggestKey(key, allowed) {
  const lower = key.toLowerCase();
  let best = "";
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(key.length / 3)) ? best : "";
}

/**
 * Reserved/example hostnames that must never reach a live run. `""` counts as a
 * placeholder so callers can use one predicate for "unset or fake".
 *
 * Subdomains count too: RFC 2606 reserves example.com and everything under it
 * for documentation, so `https://staging.example.com` — what this project's own
 * example config ships — can never be someone's real staging origin. Letting it
 * through turned "you left the placeholder in" into "staging is unreachable".
 */
const RESERVED_HOSTS = ["example", "example.com", "example.org", "example.net"];

export function isPlaceholderBaseUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return true;
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (
    RESERVED_HOSTS.some(
      reserved => host === reserved || host.endsWith(`.${reserved}`)
    )
  ) {
    return true;
  }
  return ["your-", "yourdomain", "changeme", "todo"].some(token =>
    host.includes(token)
  );
}

function collectKeyIssues(issues, object, allowed, prefix) {
  if (!isPlainObject(object)) return;
  for (const key of Object.keys(object)) {
    if (allowed.includes(key)) continue;
    const suggestion = suggestKey(key, allowed);
    issues.push(
      `unknown config key "${prefix}${key}"${
        suggestion ? ` — did you mean "${suggestion}"?` : ""
      }`
    );
  }
}

function collectTypeIssues(issues, object, prefix) {
  if (!isPlainObject(object)) return;
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) continue;
    if (
      ["specDir", "outputDir", "targetPath", "loginPath", "dashboardPath"].includes(key) &&
      typeof value !== "string"
    ) {
      issues.push(`"${prefix}${key}" must be a string, got ${typeof value}`);
    }
    if (key === "authRequired" && typeof value !== "boolean") {
      issues.push(`"${prefix}${key}" must be a boolean, got ${typeof value}`);
    }
    if (["pageUrl", "baseUrl", "versionUrl"].includes(key)) {
      try {
        new URL(String(value));
      } catch {
        issues.push(`"${prefix}${key}" is not a valid URL: ${String(value)}`);
      }
    }
    if (key === "allowedOrigins" && value !== false) {
      if (!Array.isArray(value) || value.some(o => typeof o !== "string")) {
        issues.push(
          `"${prefix}allowedOrigins" must be an array of origin strings, or false to disable origin pinning`
        );
      }
    }
    if (key === "baseUrl" && isPlaceholderBaseUrl(value)) {
      issues.push(
        `"${prefix}baseUrl" is a placeholder (${String(value)}) — set a real staging origin before judging`
      );
    }
  }
}

function validateFileConfig(raw) {
  const issues = [];

  collectKeyIssues(issues, raw, TOP_LEVEL_KEYS, "");
  collectKeyIssues(issues, raw.paths, PATHS_KEYS, "paths.");
  collectTypeIssues(issues, raw.paths, "paths.");
  collectKeyIssues(issues, raw.staging, STAGING_KEYS, "staging.");
  collectTypeIssues(issues, raw.staging, "staging.");

  if (isPlainObject(raw.pages)) {
    for (const [page, pageConfig] of Object.entries(raw.pages)) {
      if (!isPlainObject(pageConfig)) {
        issues.push(`"pages.${page}" must be an object`);
        continue;
      }
      collectKeyIssues(issues, pageConfig, PAGE_KEYS, `pages.${page}.`);
      collectTypeIssues(issues, pageConfig, `pages.${page}.`);
    }
  }

  if (isPlainObject(raw.livePolicies)) {
    for (const [key, entry] of Object.entries(raw.livePolicies)) {
      if (!isPlainObject(entry)) {
        issues.push(`"livePolicies.${key}" must be an object`);
        continue;
      }
      collectKeyIssues(issues, entry, LIVE_POLICY_KEYS, `livePolicies.${key}.`);
      if (!LIVE_RUN_POLICIES.includes(entry.liveRunPolicy)) {
        issues.push(
          `"livePolicies.${key}.liveRunPolicy" must be one of: ${LIVE_RUN_POLICIES.join(", ")}`
        );
      }
    }
  }

  if (isPlainObject(raw.hooks)) {
    collectKeyIssues(issues, raw.hooks, HOOK_KEYS, "hooks.");
    for (const [key, value] of Object.entries(raw.hooks)) {
      if (HOOK_KEYS.includes(key) && typeof value !== "function") {
        issues.push(`"hooks.${key}" must be a function, got ${typeof value}`);
      }
    }
  }

  return issues;
}

function reportConfigIssues(issues, strict) {
  if (issues.length === 0) return;
  if (strict) {
    throw new UsageError(
      `Invalid project config (${issues.length} problem${issues.length > 1 ? "s" : ""}):\n  ${issues.join("\n  ")}`,
      { hint: "Fix the keys above, or drop --strict-config / QA_STRICT_CONFIG=1 to downgrade these to warnings." }
    );
  }
  for (const issue of issues) {
    console.warn(`[qa-config] ${issue}`);
  }
}

function normalizeFileConfig(raw, { strict = false } = {}) {
  if (!raw || typeof raw !== "object") {
    throw new UsageError(
      "Config file must export a plain object (default export)."
    );
  }

  reportConfigIssues(validateFileConfig(raw), strict);

  const paths = {
    ...DEFAULT_PATH_TEMPLATES,
    ...(raw.paths ?? {}),
  };

  const pages = isPlainObject(raw.pages) ? raw.pages : {};
  const targetPaths = { ...(raw.targetPaths ?? {}) };

  for (const [pageKey, pageConfig] of Object.entries(pages)) {
    if (!isPlainObject(pageConfig)) continue;
    if (pageConfig.targetPath) {
      targetPaths[pageKey] = pageConfig.targetPath;
    }
  }

  const staging = {
    ...DEFAULT_STAGING_ACCOUNT,
    fixtures: {},
    ...(isPlainObject(raw.staging) ? raw.staging : {}),
  };
  if (!isPlainObject(staging.fixtures)) {
    staging.fixtures = {};
  }

  const fixtures = isPlainObject(raw.fixtures) ? raw.fixtures : {};

  return {
    root: raw.root ? resolve(raw.root) : null,
    paths,
    pages,
    targetPaths,
    staging,
    fixtures,
    livePolicies: isPlainObject(raw.livePolicies) ? raw.livePolicies : {},
    hooks: isPlainObject(raw.hooks) ? raw.hooks : {},
  };
}

function buildDefaultConfig(cwd, overrides = {}) {
  return {
    root: resolve(overrides.root || cwd),
    configPath: overrides.configPath || null,
    paths: {
      ...DEFAULT_PATH_TEMPLATES,
      ...(overrides.specDir || overrides.outputDir
        ? {
            ...(overrides.specDir ? { specDir: overrides.specDir } : {}),
            ...(overrides.outputDir ? { outputDir: overrides.outputDir } : {}),
          }
        : {}),
    },
    pages: {},
    targetPaths: {},
    staging: { ...DEFAULT_STAGING_ACCOUNT, fixtures: {} },
    fixtures: {},
    livePolicies: {},
    hooks: {},
    strict: Boolean(overrides.strict),
    cliOverrides: {
      specDir: overrides.specDir || "",
      outputDir: overrides.outputDir || "",
    },
  };
}

/**
 * Load and cache project config from cwd, optional config file, and CLI flags.
 *
 * A second call with different flags re-resolves instead of silently handing
 * back the first call's config: a stale root or spec dir writes artifacts to
 * the wrong place with no error.
 *
 * @param {string[]} [argv]
 */
export async function loadProjectConfig(argv = process.argv.slice(2)) {
  const overrides = parsePathOverrides(argv);
  const signature = JSON.stringify([overrides, process.cwd()]);

  if (activeConfig) {
    if (signature === activeOverrideSignature) return activeConfig;
    console.warn(
      "[qa-config] loadProjectConfig() called again with different flags — re-resolving project config. Load it once, in the entry script."
    );
  }

  const cwd = process.cwd();
  const configPath =
    overrides.configPath || findConfigFile(overrides.root || cwd);

  let config = buildDefaultConfig(cwd, overrides);

  if (configPath) {
    const fileConfig = normalizeFileConfig(
      await importConfigModule(resolve(configPath)),
      { strict: overrides.strict }
    );
    config = deepMerge(config, fileConfig);
    config.configPath = resolve(configPath);
    if (!config.root) {
      config.root = dirname(resolve(configPath));
    }
  }

  if (overrides.root) {
    config.root = resolve(overrides.root);
  } else if (!config.root) {
    config.root = cwd;
  }

  if (overrides.specDir) {
    config.paths.specDir = overrides.specDir;
    config.cliOverrides.specDir = overrides.specDir;
  }
  if (overrides.outputDir) {
    config.paths.outputDir = overrides.outputDir;
    config.cliOverrides.outputDir = overrides.outputDir;
  }

  activeConfig = config;
  activeOverrideSignature = signature;
  return activeConfig;
}

/**
 * Synchronous access after {@link loadProjectConfig} was awaited. Throws rather
 * than fabricating a cwd default: a module-ordering mistake used to silently
 * ignore the user's config file and judge the wrong URLs.
 */
export function getProjectConfig() {
  if (!activeConfig) {
    throw new Error(
      "Project config was read before loadProjectConfig() was awaited. Entry scripts must `await ensureProjectConfig(argv)` before any other QA module runs."
    );
  }
  return activeConfig;
}

export function resetProjectConfigForTests() {
  activeConfig = null;
  activeOverrideSignature = "";
}

export function resolvePathFromConfig(templateOrPath, page) {
  const config = getProjectConfig();
  const templated = applyPathTemplate(templateOrPath, {
    page,
    root: config.root,
  });
  return resolve(config.root, templated);
}

export function getPageConfig(page) {
  const config = getProjectConfig();
  const pageConfig = config.pages?.[page];
  return isPlainObject(pageConfig) ? pageConfig : {};
}

export function resolveSpecDirForPage(page) {
  const config = getProjectConfig();
  const pageConfig = getPageConfig(page);

  if (config.cliOverrides.specDir) {
    return resolvePathFromConfig(config.cliOverrides.specDir, page);
  }
  if (pageConfig.specDir) {
    return resolvePathFromConfig(pageConfig.specDir, page);
  }
  return resolvePathFromConfig(config.paths.specDir, page);
}

export function resolveOutputDirForPage(page) {
  if (process.env.QA_OUTPUT_DIR) {
    return resolve(process.env.QA_OUTPUT_DIR);
  }
  if (page === "dashboard" && process.env.DASHBOARD_QA_OUTPUT_DIR) {
    return resolve(process.env.DASHBOARD_QA_OUTPUT_DIR);
  }

  const config = getProjectConfig();
  const pageConfig = getPageConfig(page);

  if (config.cliOverrides.outputDir) {
    return resolvePathFromConfig(config.cliOverrides.outputDir, page);
  }
  if (pageConfig.outputDir) {
    return resolvePathFromConfig(pageConfig.outputDir, page);
  }
  return resolvePathFromConfig(config.paths.outputDir, page);
}

/** Default upload fixtures from config (root → staging → page). Paths are repo-relative. */
export function resolveDefaultUploadFixtures(page) {
  const config = getProjectConfig();
  const pageConfig = getPageConfig(page);
  return {
    ...(config.fixtures ?? {}),
    ...(config.staging?.fixtures ?? {}),
    ...(pageConfig.fixtures ?? {}),
  };
}

export function mergeUploadFixtures(defaultFixtures, ...overrides) {
  const merged = { ...(defaultFixtures ?? {}) };
  for (const override of overrides) {
    if (!override || typeof override !== "object") continue;
    Object.assign(merged, override);
  }
  return merged;
}

/** Resolve repo-relative fixture paths to absolute paths on disk. */
export function resolveFixturePaths(fixtures, root = getProjectConfig().root) {
  const resolved = {};
  for (const [name, fixturePath] of Object.entries(fixtures ?? {})) {
    resolved[name] = resolve(root, fixturePath);
  }
  return resolved;
}

export function resolveTargetPathForPage(page) {
  const config = getProjectConfig();
  const pageConfig = getPageConfig(page);
  const targetPath = pageConfig.targetPath ?? config.targetPaths[page];
  if (!targetPath) {
    return null;
  }
  return targetPath;
}

export function resolvePageUrlForPage(page) {
  const pageConfig = getPageConfig(page);
  const pageUrl = pageConfig.pageUrl;
  return pageUrl ? String(pageUrl) : null;
}

/**
 * @param {string[]} [argv]
 * @returns {{ targetPath: string | null, pageUrl: string | null }}
 */
export function resolveJudgeTarget(argv = [], page) {
  const cliArg = argv.find(arg => arg.startsWith("--target-path="));
  if (cliArg) {
    return {
      targetPath: cliArg.slice("--target-path=".length).trim(),
      pageUrl: null,
    };
  }

  const pageUrl = resolvePageUrlForPage(page);
  if (pageUrl) {
    return { targetPath: null, pageUrl };
  }

  const targetPath = resolveTargetPathForPage(page);
  if (!targetPath) {
    return { targetPath: null, pageUrl: null };
  }

  return { targetPath, pageUrl: null };
}

function pageFromArgv(argv) {
  const arg = argv.find(item => item.startsWith("--page="));
  return arg ? arg.slice("--page=".length).trim() : "";
}

/**
 * Merge staging URL defaults from project config (does not override CLI/env).
 * Page-level baseUrl/loginPath win over the global `staging` block so a
 * monorepo can point app B at its own origin and login flow.
 *
 * @param {Record<string, string>} config
 * @param {string[]} [argv]
 * @param {string} [page] defaults to `--page=` in argv
 */
export function applyStagingUrlDefaults(config, argv = [], page = pageFromArgv(argv)) {
  const project = getProjectConfig();
  const global = project.staging ?? {};
  const pageConfig = page ? getPageConfig(page) : {};
  const pick = key => pageConfig[key] ?? global[key];

  const hasCli = prefix =>
    argv.some(arg => arg.startsWith(prefix));

  const baseUrl = pick("baseUrl");
  if (!hasCli("--base-url=") && !process.env.STAGING_QA_BASE_URL && baseUrl) {
    config.baseUrl = String(baseUrl);
  }
  const loginPath = pick("loginPath");
  if (
    !hasCli("--login-path=") &&
    !process.env.STAGING_QA_LOGIN_PATH &&
    loginPath
  ) {
    config.loginPath = String(loginPath);
  }
  if (
    !hasCli("--dashboard-path=") &&
    !process.env.STAGING_QA_DASHBOARD_PATH &&
    global.dashboardPath
  ) {
    config.dashboardPath = String(global.dashboardPath);
  }
}

/** Effective staging origin for a page: env > page config > global config. */
export function resolveBaseUrlForPage(page) {
  if (process.env.STAGING_QA_BASE_URL) return process.env.STAGING_QA_BASE_URL;
  const project = getProjectConfig();
  const pageConfig = page ? getPageConfig(page) : {};
  const baseUrl = pageConfig.baseUrl ?? project.staging?.baseUrl;
  return baseUrl ? String(baseUrl) : "";
}

/** Every page named by `pages` or by the legacy `targetPaths` block. */
export function listConfiguredPages() {
  const config = getProjectConfig();
  return [
    ...new Set([
      ...Object.keys(config.pages ?? {}),
      ...Object.keys(config.targetPaths ?? {}),
    ]),
  ].sort();
}

/**
 * Per-scenario live-run policy overrides from the `livePolicies` config block.
 * @returns {Record<string, { liveRunPolicy: string, stagingMode?: string }>}
 */
export function getLivePolicyOverrides() {
  const raw = getProjectConfig().livePolicies ?? {};
  const overrides = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry)) continue;
    if (!LIVE_RUN_POLICIES.includes(entry.liveRunPolicy)) continue;
    overrides[key] = entry.stagingMode
      ? { liveRunPolicy: entry.liveRunPolicy, stagingMode: String(entry.stagingMode) }
      : { liveRunPolicy: entry.liveRunPolicy };
  }
  return overrides;
}

/** @returns {{ onJudgment?: Function, onReview?: Function }} */
export function getHooks() {
  const raw = getProjectConfig().hooks ?? {};
  const hooks = {};
  for (const key of HOOK_KEYS) {
    if (typeof raw[key] === "function") hooks[key] = raw[key];
  }
  return hooks;
}

/**
 * Origins the browser layer may navigate to. Defaults to the resolved staging
 * origin so a run cannot wander off-site; `allowedOrigins: false` opts out.
 * @returns {string[]} empty = no restriction
 */
export function getAllowedOrigins(page) {
  const project = getProjectConfig();
  const pageConfig = page ? getPageConfig(page) : {};
  // A page with its own baseUrl must not inherit the global allowlist — that
  // would pin app B to app A's origin and block every navigation.
  const configured =
    pageConfig.allowedOrigins ??
    (pageConfig.baseUrl ? undefined : project.staging?.allowedOrigins);
  if (configured === false) return [];
  if (Array.isArray(configured)) return configured.map(String);

  const baseUrl = resolveBaseUrlForPage(page);
  if (!baseUrl || isPlaceholderBaseUrl(baseUrl)) return [];
  try {
    return [new URL(baseUrl).origin];
  } catch {
    return [];
  }
}

/** Deploy-version endpoint used to skip judging an unchanged staging build. */
/**
 * Path to a Playwright `storageState` file that already holds a valid session.
 * Apps whose e2e suite mints its session in code have no login form for the
 * `login` command to drive, so reusing that file is the only way to judge them
 * signed in — and it keeps credentials out of this tool entirely.
 */
export function getStorageStatePath(page) {
  const project = getProjectConfig();
  const pageConfig = page ? getPageConfig(page) : {};
  const configured = pageConfig.storageState ?? project.staging?.storageState;
  if (!configured) return null;
  return resolve(project.root, String(configured));
}

/**
 * Footer appended to every filed GitHub issue. It is the only place an agent
 * trigger (`@claude`, a label mention) can come from: hardcoding one would make
 * this tool decide who acts on a verdict, which is the operator's call.
 */
export function getGithubIssueConfig() {
  const project = getProjectConfig();
  const footer = project.github?.issueFooter;
  return { footer: footer ? String(footer) : "" };
}

export function getStagingVersionUrl(page) {
  const project = getProjectConfig();
  const pageConfig = page ? getPageConfig(page) : {};
  const versionUrl = pageConfig.versionUrl ?? project.staging?.versionUrl;
  return versionUrl ? String(versionUrl) : null;
}

/**
 * Identity helper so editors type-check and autocomplete the config file with
 * no build step.
 *
 * @typedef {Object} QaPageConfig
 * @property {string} [targetPath] Path appended to the staging base URL
 * @property {string} [pageUrl] Absolute URL; wins over targetPath
 * @property {string} [baseUrl] Per-page staging origin (monorepos)
 * @property {string} [loginPath] Per-page login path
 * @property {boolean} [authRequired]
 * @property {string} [expectedPlan]
 * @property {string} [expectedAccountState] Expected @qa-scenario account state
 * @property {string} [expectedSubscriptionStatus] Legacy alias of expectedAccountState
 * @property {string} [accountNotes]
 * @property {string} [specDir] Overrides paths.specDir for this page
 * @property {string} [outputDir] Overrides paths.outputDir for this page
 * @property {Record<string, string>} [fixtures] Upload fixtures, repo-relative
 * @property {string[]|false} [allowedOrigins] Origin allowlist; false disables pinning
 * @property {string} [versionUrl] Deploy-version endpoint for cost gating
 *
 * @typedef {Object} QaProjectConfig
 * @property {string} [root]
 * @property {{ specDir?: string, outputDir?: string }} [paths] Templates with {page} and {root}
 * @property {Record<string, QaPageConfig>} [pages]
 * @property {Record<string, string>} [targetPaths] Legacy alias of pages.{page}.targetPath
 * @property {QaPageConfig & { dashboardPath?: string }} [staging] Defaults for every page
 * @property {Record<string, string>} [fixtures]
 * @property {Record<string, { liveRunPolicy: string, stagingMode?: string }>} [livePolicies]
 * @property {{ onJudgment?: Function, onReview?: Function }} [hooks]
 *
 * @param {QaProjectConfig} config
 * @returns {QaProjectConfig}
 */
export function defineConfig(config) {
  return config;
}

/**
 * Merge staging account defaults from hermes-qa.config (does not override CLI/env).
 * @param {Record<string, string>} config
 * @param {string} page
 */
export function applyStagingAccountDefaults(config, page) {
  const project = getProjectConfig();
  const pageConfig = getPageConfig(page);
  const global = project.staging ?? DEFAULT_STAGING_ACCOUNT;

  if (config.authRequired === undefined) {
    config.authRequired =
      pageConfig.authRequired ??
      global.authRequired ??
      DEFAULT_STAGING_ACCOUNT.authRequired;
  }
  if (!config.expectedPlan) {
    config.expectedPlan =
      pageConfig.expectedPlan ?? global.expectedPlan ?? "";
  }
  if (!config.expectedSubscriptionStatus) {
    // expectedAccountState is the de-branded name; expectedSubscriptionStatus
    // stays a supported legacy alias, like targetPaths.
    config.expectedSubscriptionStatus =
      config.expectedAccountState ??
      pageConfig.expectedAccountState ??
      pageConfig.expectedSubscriptionStatus ??
      global.expectedAccountState ??
      global.expectedSubscriptionStatus ??
      "";
  }
  if (!config.accountNotes) {
    config.accountNotes =
      pageConfig.accountNotes ?? global.accountNotes ?? "";
  }

  if (config.expectedSubscriptionStatus) {
    config.expectedSubscriptionStatus = String(
      config.expectedSubscriptionStatus
    )
      .trim()
      .toUpperCase();
  }
  config.expectedAccountState = config.expectedSubscriptionStatus;
}

export function getPackageScriptsDir() {
  return dirname(fileURLToPath(import.meta.url));
}

export function printProjectConfigHelp() {
  console.log(`Project layout options (config file or CLI):

  --config=<path>           Config file path (default: search upward from cwd)
  --project-root=<path>     Project root (default: config file dir or cwd)
  --spec-dir=<template>     Spec directory template or path ({page}, {root})
  --output-dir=<template>   Output directory template or path ({page}, {root})
  --strict-config           Turn config warnings into errors (recommended in CI;
                            same as QA_STRICT_CONFIG=1)

Config file names (first match wins):
  playwright-spec-for-ai-agent.config.mjs | .js | .cjs | .json
  hermes-qa.config.mjs | .js | .cjs | .json  (legacy)
  playwright-spec-qa.config.mjs | .js | .cjs | .json  (legacy)

Example playwright-spec-for-ai-agent.config.mjs:
  import { defineConfig } from "playwright-spec-for-ai-agent/scripts/hermes-qa-project-config.mjs";

  export default defineConfig({
    root: process.cwd(),
    paths: {
      specDir: "e2e/{page}",
      outputDir: "qa-output/{page}",
    },
    staging: { baseUrl: "https://staging.acme.dev", loginPath: "/login" },
    pages: {
      search: { targetPath: "/search", authRequired: false },
      settings: { targetPath: "/settings" },
    },
  });
`);
}
