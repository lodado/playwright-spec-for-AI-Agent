import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAnnotations } from "./dashboard-spec-parser.mjs";

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

export const DEFAULT_TARGET_PATHS = {};

export const DEFAULT_STAGING_ACCOUNT = {
  authRequired: true,
  expectedPlan: "",
  expectedScenario: "",
  expectedSubscriptionStatus: "",
  accountNotes: "",
  fixtures: {},
};

/** @type {Record<string, unknown> | null} */
let activeConfig = null;

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
  return template.replaceAll("{page}", page).replaceAll("{root}", root);
}

function parsePathOverrides(argv) {
  const overrides = {
    configPath: "",
    root: "",
    specDir: "",
    outputDir: "",
  };

  for (const arg of argv) {
    if (arg.startsWith("--config=")) {
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

function normalizeFileConfig(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Config file must export a plain object (default export).");
  }

  const paths = {
    ...DEFAULT_PATH_TEMPLATES,
    ...(raw.paths ?? {}),
  };

  const pages = isPlainObject(raw.pages) ? raw.pages : {};
  const targetPaths = {
    ...DEFAULT_TARGET_PATHS,
    ...(raw.targetPaths ?? {}),
  };

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
  const remediation = isPlainObject(raw.remediation) ? raw.remediation : {};
  const batch = isPlainObject(raw.batch) ? raw.batch : {};

  return {
    root: raw.root ? resolve(raw.root) : null,
    paths,
    pages,
    targetPaths,
    staging,
    fixtures,
    remediation,
    batch,
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
    targetPaths: { ...DEFAULT_TARGET_PATHS },
    staging: { ...DEFAULT_STAGING_ACCOUNT, fixtures: {} },
    fixtures: {},
    batch: {},
    cliOverrides: {
      specDir: overrides.specDir || "",
      outputDir: overrides.outputDir || "",
    },
  };
}

/**
 * Load and cache project config from cwd, optional config file, and CLI flags.
 * @param {string[]} [argv]
 */
export async function loadProjectConfig(argv = process.argv.slice(2)) {
  if (activeConfig) return activeConfig;

  const overrides = parsePathOverrides(argv);
  const cwd = process.cwd();
  const configPath =
    overrides.configPath || findConfigFile(overrides.root || cwd);

  let config = buildDefaultConfig(cwd, overrides);

  if (configPath) {
    const fileConfig = normalizeFileConfig(
      await importConfigModule(resolve(configPath)),
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
  return activeConfig;
}

/** Synchronous access after {@link loadProjectConfig} was awaited. */
export function getProjectConfig() {
  if (!activeConfig) {
    activeConfig = buildDefaultConfig(process.cwd());
  }
  return activeConfig;
}

export function resetProjectConfigForTests() {
  activeConfig = null;
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

/** The @qa-scenario value designated for a page (page config, then staging default). */
export function resolveExpectedScenarioForPage(page) {
  const config = getProjectConfig();
  const pageConfig = getPageConfig(page);
  const raw =
    [
      pageConfig.expectedScenario,
      pageConfig.expectedSubscriptionStatus,
      config.staging?.expectedScenario,
      config.staging?.expectedSubscriptionStatus,
    ].find((value) => value !== undefined && String(value).trim() !== "") ?? "";
  return raw ? String(raw).trim().toUpperCase() : "";
}

/** @deprecated Use resolveExpectedScenarioForPage. */
export const resolveExpectedStatusForPage = resolveExpectedScenarioForPage;

/**
 * Every `*.spec.ts` under the page's spec directory, sorted for a stable run order. Helper modules
 * and non-spec files are excluded. This is the raw glob; `selectSpecFilesForPage` narrows it to the
 * config-designated specs.
 */
export function resolveSpecFilesForPage(page, { readdir = readdirSync } = {}) {
  const specDir = resolveSpecDirForPage(page);
  let entries;
  try {
    entries = readdir(specDir);
  } catch {
    throw new Error(
      `spec directory for page "${page}" does not exist: ${specDir}`,
    );
  }
  const specFiles = entries
    .filter((name) => name.endsWith(".spec.ts"))
    .sort()
    .map((name) => join(specDir, name));
  if (specFiles.length === 0)
    throw new Error(
      `no *.spec.ts files found for page "${page}" in ${specDir}`,
    );
  return specFiles;
}

/**
 * The specs the config designates for `qa-native execute --page=<name>`: from the page's directory,
 * keep those whose `@qa-scenario` matches `expectedScenario` (case-insensitive) or that
 * carry `// @qa-always-run: true`, and drop any `// @qa-live-skip: true`. When no status is
 * configured the whole directory is designated (backward compatible). Scenario-level `@qa-live-skip`
 * / blocked policies are still filtered later by the adapter — this is only the file-level cut.
 */
export function selectSpecFilesForPage(page, { readFile = readFileSync } = {}) {
  const files = resolveSpecFilesForPage(page);
  const expected = resolveExpectedScenarioForPage(page);
  const kept = [];
  const seen = new Set();
  let skippedDesignated = 0;
  for (const file of files) {
    const { scenario, liveSkip, alwaysRun } = parseAnnotations(
      readFile(file, "utf8"),
    );
    const scenarioStatus = scenario ? scenario.trim().toUpperCase() : null;
    if (scenarioStatus) seen.add(scenarioStatus);
    const designated = !expected || alwaysRun || scenarioStatus === expected;
    if (liveSkip) {
      if (designated) skippedDesignated += 1;
      continue;
    }
    if (designated) kept.push(file);
  }
  if (kept.length === 0 && skippedDesignated > 0)
    throw new Error(
      `page "${page}": all ${skippedDesignated} config-designated spec(s) are excluded by // @qa-live-skip: true`,
    );
  if (kept.length === 0)
    throw new Error(
      `page "${page}": no spec matches expectedScenario "${expected}" (@qa-scenario found: ${[...seen].join(", ") || "none"}; mark cross-state specs with // @qa-always-run: true)`,
    );
  return kept;
}

/** Base URL designated by the config (batch default, then staging), or null when neither is set. */
export function resolveConfigBaseUrl() {
  const config = getProjectConfig();
  const batchBaseUrl = isPlainObject(config.batch)
    ? config.batch.defaultBaseUrl
    : undefined;
  const stagingBaseUrl = config.staging?.baseUrl;
  const baseUrl = batchBaseUrl ?? stagingBaseUrl;
  return baseUrl ? String(baseUrl) : null;
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
  if (targetPath) return targetPath;
  const segments = String(page).split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))
  )
    throw new Error(
      "page must contain only letters, numbers, underscore, hyphen, and slash-separated segments",
    );
  return `/${segments.join("/")}`;
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
  const cliArg = argv.find((arg) => arg.startsWith("--target-path="));
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

/**
 * Merge staging URL defaults from project config (does not override CLI/env).
 * @param {Record<string, string>} config
 * @param {string[]} [argv]
 */
export function applyStagingUrlDefaults(config, argv = []) {
  const project = getProjectConfig();
  const global = project.staging ?? {};

  const hasCli = (prefix) => argv.some((arg) => arg.startsWith(prefix));

  if (
    !hasCli("--base-url=") &&
    !process.env.STAGING_QA_BASE_URL &&
    global.baseUrl
  ) {
    config.baseUrl = String(global.baseUrl);
  }
  if (
    !hasCli("--login-path=") &&
    !process.env.STAGING_QA_LOGIN_PATH &&
    global.loginPath
  ) {
    config.loginPath = String(global.loginPath);
  }
  if (
    !hasCli("--dashboard-path=") &&
    !process.env.STAGING_QA_DASHBOARD_PATH &&
    global.dashboardPath
  ) {
    config.dashboardPath = String(global.dashboardPath);
  }
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
    config.expectedPlan = pageConfig.expectedPlan ?? global.expectedPlan ?? "";
  }
  if (!config.expectedScenario) {
    config.expectedScenario =
      pageConfig.expectedScenario ??
      pageConfig.expectedSubscriptionStatus ??
      global.expectedScenario ??
      global.expectedSubscriptionStatus ??
      "";
  }
  if (!config.expectedSubscriptionStatus) {
    config.expectedSubscriptionStatus =
      pageConfig.expectedSubscriptionStatus ??
      global.expectedSubscriptionStatus ??
      "";
  }
  if (!config.accountNotes) {
    config.accountNotes = pageConfig.accountNotes ?? global.accountNotes ?? "";
  }

  if (config.expectedSubscriptionStatus) {
    config.expectedSubscriptionStatus = String(
      config.expectedSubscriptionStatus,
    )
      .trim()
      .toUpperCase();
  }
  if (config.expectedScenario) {
    config.expectedScenario = String(config.expectedScenario)
      .trim()
      .toUpperCase();
  }
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

Config file names (first match wins):
  playwright-spec-for-ai-agent.config.mjs | .js | .cjs | .json
  hermes-qa.config.mjs | .js | .cjs | .json  (legacy)
  playwright-spec-qa.config.mjs | .js | .cjs | .json  (legacy)

Example playwright-spec-for-ai-agent.config.mjs:
  export default {
    root: process.cwd(),
    paths: {
      specDir: "e2e/{page}",
      outputDir: "qa-output/{page}",
    },
    pages: {
      "account/settings": { targetPath: "/app/account/settings" },
      catalog: { targetPath: "/catalog" },
    },
  };
`);
}
