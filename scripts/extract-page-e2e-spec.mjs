#!/usr/bin/env node
/**
 * Generic QA spec extractor for any page.
 *
 * Usage:
 *   node scripts/extract-page-e2e-spec.mjs --page=dashboard
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withSchema } from "./artifact-schema.mjs";
import {
  formatScenarioCoverageSummary,
  parseSpecDirectory,
  SPEC_READER_VERSION,
} from "./spec-annotation-reader.mjs";
import { runMain, UsageError } from "./errors.mjs";
import {
  artifactPaths,
  ensureProjectConfig,
  parsePageArg,
  resolveSpecDir,
} from "./page-qa-paths.mjs";
import { assertFixturesExist, hashSpecSources } from "./qa-spec-artifacts.mjs";
import {
  collectLiveSkippedEntries,
  countLiveSpecTests,
  countUnparsedSpecTests,
  filterSpecForLiveJson,
  printLiveSkippedTable,
} from "./spec-live-filter.mjs";

function pageLabel(page) {
  return page
    .split("/")
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export async function run(argv) {
  await ensureProjectConfig(argv);
  const page = parsePageArg(argv);
  const specDir = resolveSpecDir(page);
  if (!existsSync(specDir)) {
    throw new UsageError(`Spec directory does not exist: ${specDir}`, {
      hint: `Create it, set pages.${page}.specDir in playwright-spec-for-ai-agent.config.*, or pass --spec-dir=<template>.`,
    });
  }
  const paths = artifactPaths(page);

  mkdirSync(paths.outputDir, { recursive: true });

  const parsedSpec = parseSpecDirectory(specDir);
  assertFixturesExist(parsedSpec, page, {
    allowMissing: argv.includes("--allow-missing-fixtures"),
  });

  const excluded = collectLiveSkippedEntries(parsedSpec);
  const unparsedTestCount = countUnparsedSpecTests(parsedSpec);
  const filtered = filterSpecForLiveJson(parsedSpec);

  const stamps = {
    specSourcesHash: hashSpecSources(specDir, SPEC_READER_VERSION),
    parserVersion: SPEC_READER_VERSION,
    excluded,
    unparsedTestCount,
  };
  const spec = withSchema({ ...filtered, ...stamps }, "qa-spec");

  writeFileSync(paths.specJson, `${JSON.stringify(spec, null, 2)}\n`);

  const includedTests = countLiveSpecTests(filtered);
  const parsedTests = countLiveSpecTests(parsedSpec);

  const scenarioIds = [...new Set(filtered.scenarios.map(s => s.scenarioId))];
  const label = pageLabel(page);

  console.log(`${label} QA spec written: ${paths.specJson}`);
  console.log(
    `  Live QA tests in JSON: ${includedTests} included, ${excluded.length} excluded (${parsedTests} read total)`
  );
  console.log(`  Excluded tests recorded in artifact: ${excluded.length}`);
  if (unparsedTestCount > 0) {
    console.warn(
      `  Unreadable test declarations recorded in artifact: ${unparsedTestCount}`
    );
  }
  console.log(`  Spec sources hash: ${stamps.specSourcesHash}`);
  console.log(`  (run abstract-ai --page=${page} for qa-spec-live.json + .md)`);
  for (const scenarioId of scenarioIds) {
    console.log(`  - ${formatScenarioCoverageSummary(filtered, scenarioId)}`);
  }
  printLiveSkippedTable(excluded);
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) runMain(() => run(process.argv.slice(2)));
