#!/usr/bin/env node
/**
 * Generic QA spec extractor for any page.
 *
 * Usage:
 *   node scripts/extract-page-e2e-spec.mjs --page=dashboard
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  formatScenarioCoverageSummary,
  parseSpecDirectory,
} from "./dashboard-spec-parser.mjs";
import { abstractSpec } from "./expectation-abstractor.mjs";
import {
  artifactPaths,
  ensureProjectConfig,
  parsePageArg,
  resolveSpecDir,
} from "./page-qa-paths.mjs";
import {
  collectLiveSkippedEntries,
  countLiveSpecTests,
  filterSpecForLiveJson,
  printLiveSkippedTable,
} from "./spec-live-filter.mjs";

function pageLabel(page) {
  return page
    .split("/")
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

async function main() {
  const argv = process.argv.slice(2);
  await ensureProjectConfig(argv);
  const page = parsePageArg(argv);
  const specDir = resolveSpecDir(page);
  const { specJson: jsonPath, specAbstractedJson } = artifactPaths(page);

  mkdirSync(artifactPaths(page).outputDir, { recursive: true });

  const parsedSpec = parseSpecDirectory(specDir);
  const skippedEntries = collectLiveSkippedEntries(parsedSpec);
  const spec = filterSpecForLiveJson(parsedSpec);
  const abstracted = abstractSpec(spec);

  writeFileSync(jsonPath, `${JSON.stringify(spec, null, 2)}\n`);
  writeFileSync(specAbstractedJson, `${JSON.stringify(abstracted, null, 2)}\n`);

  const includedTests = countLiveSpecTests(spec);
  const parsedTests = countLiveSpecTests(parsedSpec);

  const scenarioIds = [...new Set(spec.scenarios.map(s => s.scenarioId))];
  const summary = scenarioIds.map(scenarioId =>
    formatScenarioCoverageSummary(spec, scenarioId)
  );

  console.log(`${label(page)} QA spec written: ${jsonPath}`);
  console.log(`${label(page)} rule-abstracted spec: ${specAbstractedJson}`);
  console.log(
    `  Live QA tests in JSON: ${includedTests} included, ${skippedEntries.length} skipped (${parsedTests} parsed total)`
  );
  console.log(`  (run abstract-ai --page=${page} for qa-spec-live.json + .md)`);
  for (const line of summary) console.log(`  - ${line}`);
  printLiveSkippedTable(skippedEntries);
}

function label(page) {
  return pageLabel(page);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
