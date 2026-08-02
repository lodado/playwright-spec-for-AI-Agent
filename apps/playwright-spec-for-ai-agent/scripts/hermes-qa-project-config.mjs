import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseAnnotations } from "./playwright-spec-parser.mjs";

const CONFIG_FILENAMES = [
  "playwright-spec-for-ai-agent.config.mjs",
  "playwright-spec-for-ai-agent.config.js",
  "playwright-spec-for-ai-agent.config.cjs",
  "playwright-spec-for-ai-agent.config.json",
];
const DEFAULT_SPEC_DIR = "src/page/{page}/__tests__";
const TOP_LEVEL_KEYS = new Set(["root", "specDir", "baseUrl", "pages"]);
const PAGE_KEYS = new Set(["specDir", "baseUrl", "targetPath", "pageUrl"]);

let activeConfig;

export function applyPathTemplate(template, { page, root }) {
  return template.replaceAll("{page}", page).replaceAll("{root}", root);
}

export async function loadProjectConfig(argv = process.argv.slice(2)) {
  if (activeConfig) return activeConfig;
  const options = parseOptions(argv);
  const configPath = options.configPath || findConfigFile(options.root || process.cwd());
  const raw = configPath ? await importConfig(resolve(configPath)) : {};
  if (!isPlainObject(raw) || Object.keys(raw).some(key => !TOP_LEVEL_KEYS.has(key))) throw new Error("Config file contains unsupported v3 fields.");

  const root = resolve(options.root || (raw.root ? String(raw.root) : configPath ? dirname(resolve(configPath)) : process.cwd()));
  const pages = normalizePages(raw.pages);
  activeConfig = {
    root,
    specDir: text(raw.specDir, DEFAULT_SPEC_DIR, "specDir"),
    baseUrl: optionalText(raw.baseUrl, "baseUrl"),
    pages,
  };
  return activeConfig;
}

export function resetProjectConfigForTests() {
  activeConfig = undefined;
}

export function resolveSpecFilesForPage(page, { readdir = readdirSync } = {}) {
  const config = currentConfig();
  const pageConfig = config.pages[page] ?? {};
  const specDir = resolve(config.root, applyPathTemplate(pageConfig.specDir ?? config.specDir, { page, root: config.root }));
  let entries;
  try {
    entries = readdir(specDir);
  } catch {
    throw new Error(`spec directory for page "${page}" does not exist: ${specDir}`);
  }
  const files = entries.filter(name => name.endsWith(".spec.ts")).sort().map(name => join(specDir, name));
  if (files.length === 0) throw new Error(`no *.spec.ts files found for page "${page}" in ${specDir}`);
  return files;
}

export function selectSpecFilesForPage(page, { readFile = readFileSync } = {}) {
  const files = resolveSpecFilesForPage(page);
  const selected = files.filter(file => !parseAnnotations(readFile(file, "utf8")).liveSkip);
  if (selected.length === 0) throw new Error(`page "${page}": all ${files.length} spec(s) are excluded by // @qa-live-skip: true`);
  return selected;
}

export function resolveConfigBaseUrl(page) {
  const config = currentConfig();
  return config.pages[page]?.baseUrl ?? config.baseUrl ?? null;
}

export function resolveTargetPathForPage(page) {
  const configured = currentConfig().pages[page]?.targetPath;
  if (configured) return configured;
  const segments = String(page).split("/");
  if (segments.length === 0 || segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment))) throw new Error("page must contain only letters, numbers, underscore, hyphen, and slash-separated segments");
  return `/${segments.join("/")}`;
}

export function resolveJudgeTarget(_argv = [], page) {
  const pageUrl = currentConfig().pages[page]?.pageUrl;
  return pageUrl ? { targetPath: null, pageUrl } : { targetPath: resolveTargetPathForPage(page), pageUrl: null };
}

function currentConfig() {
  if (!activeConfig) throw new Error("Project config must be loaded first.");
  return activeConfig;
}

function parseOptions(argv) {
  const options = { configPath: "", root: "" };
  for (const arg of argv) {
    if (arg.startsWith("--config=")) options.configPath = arg.slice("--config=".length).trim();
    if (arg.startsWith("--project-root=")) options.root = arg.slice("--project-root=".length).trim();
  }
  return options;
}

function findConfigFile(startDirectory) {
  let current = resolve(startDirectory);
  while (true) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function importConfig(configPath) {
  const extension = extname(configPath);
  if (extension === ".json") return JSON.parse(readFileSync(configPath, "utf8"));
  if (extension === ".cjs") {
    const loaded = createRequire(import.meta.url)(configPath);
    return loaded?.default ?? loaded;
  }
  const loaded = await import(pathToFileURL(configPath).href);
  return loaded.default ?? loaded;
}

function normalizePages(value) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new Error("Config pages must be a plain object.");
  return Object.fromEntries(Object.entries(value).map(([page, config]) => {
    if (!isPlainObject(config) || Object.keys(config).some(key => !PAGE_KEYS.has(key))) throw new Error(`Config page "${page}" contains unsupported v3 fields.`);
    return [page, Object.fromEntries(Object.entries(config).map(([key, child]) => [key, text(child, undefined, `pages.${page}.${key}`)]))];
  }));
}

function optionalText(value, label) {
  return value === undefined ? null : text(value, undefined, label);
}

function text(value, fallback, label) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Config ${label} must be a non-empty string.`);
  return value.trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
