import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ABSTRACT_PLAYWRIGHT_SPEC_VERSION, abstractPlaywrightSource } from "../abstract-playwright/index.mjs";
import { collectStaticAuthority } from "../static-authority/index.mjs";
import { canonicalHash } from "../contracts/index.mjs";
import { createHermesFullSpecAbstractor, createHermesFullSpecReviewer } from "../provider-hermes/index.mjs";
import { CliError, ensurePrivateQaDirectory, readBoundedSpec, readPrivateJson, writePrivateFileExclusive, writePrivateJsonExclusive } from "./qa-native.mjs";

const CACHE_VERSION = "qa-native-abstract-cache/0.2";
const CACHE_DIRECTORY = ".qa/abstract/cache";

export async function abstractQaNative({ specPath, specPaths, page, cwd }, overrides = {}) {
  const results = await abstractSpecInputs({ specPath, specPaths, page, cwd }, { ...overrides, progress: overrides.progress ?? defaultProgress });
  const report = overrides.report ?? defaultReport;
  report({ directory: abstractDirectory(page), results });
  return results.length > 0 && results.every(result => result.artifact.status === "APPROVED") ? 0 : 1;
}

export async function abstractSpecInputs({ specPath, specPaths, sourceInputs, page, cwd }, overrides = {}) {
  const extract = overrides.extract ?? createHermesFullSpecAbstractor();
  const review = overrides.review ?? createHermesFullSpecReviewer();
  const progress = overrides.progress ?? defaultProgress;
  const directory = abstractDirectory(page);
  ensurePrivateQaDirectory(directory, { cwd });
  ensurePrivateQaDirectory(CACHE_DIRECTORY, { cwd });
  const rawInputs = sourceInputs ?? (specPaths ?? [specPath]).map(path => ({ sourcePath: relative(cwd, path), source: readBoundedSpec(path) }));
  const authority = collectStaticAuthority(rawInputs);
  for (const rejected of authority.rejected) (overrides.reportSkipped ?? defaultReportSkipped)(rejected);
  const inputs = authority.accepted;
  const results = [];

  for (const [index, input] of inputs.entries()) {
    progress({ index, total: inputs.length, sourcePath: input.sourcePath });
    const cacheKey = abstractionCacheKey(input.source, input.manifest, extract, review);
    const jsonPath = `${CACHE_DIRECTORY}/${cacheKey}.json`;
    const legacyJsonPath = `${directory}/${cacheKey}.json`;
    const markdownPath = `${directory}/${cacheKey}.md`;
    let cached = false;
    let record;
    const cachedPath = existsSync(`${cwd}/${jsonPath}`) ? jsonPath : existsSync(`${cwd}/${legacyJsonPath}`) ? legacyJsonPath : findLegacyCachePath(cacheKey, cwd);
    if (cachedPath !== undefined) {
      record = validateCacheRecord(readPrivateJson(cachedPath, { cwd }), { cacheKey, input });
      cached = true;
      if (cachedPath !== jsonPath) writePrivateJsonExclusive(jsonPath, record, { cwd });
    } else {
      let artifact;
      try {
        artifact = await abstractPlaywrightSource({ ...input, extract, review });
      } catch (error) {
        throw new CliError(`AI abstraction failed for "${input.sourcePath}": ${error?.code ?? error?.name ?? "provider error"}`);
      }
      record = {
        schemaVersion: CACHE_VERSION,
        cacheKey,
        sourcePath: input.sourcePath,
        manifest: input.manifest,
        extractor: providerRecord(extract),
        reviewer: providerRecord(review),
        artifact,
      };
      writePrivateJsonExclusive(jsonPath, record, { cwd });
    }
    if (!existsSync(`${cwd}/${markdownPath}`)) writePrivateFileExclusive(markdownPath, renderAbstractMarkdown(record), { cwd });
    results.push({ cacheKey, jsonPath, markdownPath, cached, manifest: input.manifest, artifact: record.artifact });
  }

  return results;
}

export function abstractionCacheKey(source, manifest, extract, review) {
  return canonicalHash({
    cacheVersion: CACHE_VERSION,
    artifactVersion: ABSTRACT_PLAYWRIGHT_SPEC_VERSION,
    source: canonicalHash(source),
    manifest: canonicalHash(manifest),
    extractor: providerRecord(extract),
    reviewer: providerRecord(review),
  }).slice("sha256:".length);
}

export function renderAbstractMarkdown(record) {
  const artifact = record.artifact;
  const lines = [
    "# Playwright spec abstraction",
    "",
    `- Source: \`${markdownText(record.sourcePath)}\``,
    `- Status: **${artifact.status}**`,
    `- Cache key: \`${record.cacheKey}\``,
    "",
  ];
  if (artifact.status !== "APPROVED") {
    lines.push(`> ${markdownText(artifact.reason)}`, "");
    return lines.join("\n");
  }
  for (const test of artifact.tests) {
    const staticTest = record.manifest.tests.find(item => item.testId === test.testId);
    lines.push(`## ${markdownText(staticTest?.title ?? test.testId)}`, "", `- Test ID: \`${markdownText(test.testId)}\``, `- Policy: \`${markdownText(staticTest?.livePolicyAnnotation ?? "blocked") }\``, `- Classification: **${test.classification}**`);
    for (const [label, values] of [["Given", test.given], ["When", test.when], ["Then", test.then]]) {
      lines.push("", `### ${label}`, ...values.map(value => `- ${markdownText(value)}`));
    }
    lines.push("");
  }
  return lines.join("\n");
}

function abstractDirectory(page) {
  if (page === undefined) return ".qa/abstract/spec";
  const segments = page.split("/");
  if (segments.length === 0 || segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment))) throw new CliError("page name is invalid");
  return `.qa/abstract/${segments.join("/")}`;
}

function findLegacyCachePath(cacheKey, cwd) {
  const root = ".qa/abstract";
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(join(cwd, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isFile() && entry.name === `${cacheKey}.json`) return path;
      if (entry.isDirectory() && path !== CACHE_DIRECTORY) pending.push(path);
    }
  }
  return undefined;
}

function providerRecord(provider) {
  return { ...(provider.identity ?? { provider: "unknown", model: "unknown", modelVersion: "unknown" }), promptVersion: provider.promptVersion ?? "unknown" };
}

function validateCacheRecord(record, { cacheKey, input }) {
  if (record?.schemaVersion !== CACHE_VERSION || record.cacheKey !== cacheKey || record.sourcePath !== input.sourcePath || canonicalHash(record.manifest) !== canonicalHash(input.manifest) || record.artifact?.source?.contentHash !== canonicalHash(input.source) || record.artifact?.source?.manifestHash !== canonicalHash(input.manifest)) throw new CliError("AI abstraction cache is invalid");
  if (!["APPROVED", "MANUAL_REVIEW"].includes(record.artifact.status)) throw new CliError("AI abstraction cache is invalid");
  return record;
}

function markdownText(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("`", "\\`");
}

function defaultReport({ directory, results }) {
  const cached = results.filter(result => result.cached).length;
  const approved = results.filter(result => result.artifact.status === "APPROVED").length;
  process.stdout.write(`qa-native: abstracted ${approved}/${results.length} spec(s), ${cached} cache hit(s) → ${directory}\n`);
}

function defaultProgress({ index, total, sourcePath }) {
  process.stdout.write(`qa-native: abstracting ${index + 1}/${total} ${JSON.stringify(sourcePath)}\n`);
}

function defaultReportSkipped({ sourcePath, reason }) {
  process.stderr.write(`qa-native: skipped ${JSON.stringify(sourcePath)} — ${reason}\n`);
}
