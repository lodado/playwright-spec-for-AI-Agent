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
  formatSpecDirLabel,
  parsePageArg,
  resolveSpecDir,
} from "./page-qa-paths.mjs";
import { renderQaSpecMarkdown } from "./qa-spec-markdown.mjs";

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
  const {
    outputDir,
    specJson: jsonPath,
    specAbstractedJson,
    specMd: mdPath,
  } = artifactPaths(page);

  mkdirSync(outputDir, { recursive: true });

  const spec = parseSpecDirectory(specDir);
  const abstracted = abstractSpec(spec);

  writeFileSync(jsonPath, `${JSON.stringify(spec, null, 2)}\n`);
  writeFileSync(specAbstractedJson, `${JSON.stringify(abstracted, null, 2)}\n`);
  writeFileSync(mdPath, renderQaSpecMarkdown(abstracted, page));

  const scenarioIds = [...new Set(spec.scenarios.map(s => s.scenarioId))];
  const liveScenarios = spec.scenarios.filter(s => !s.liveSkip);
  const skipCount = spec.scenarios.length - liveScenarios.length;

  const summary = scenarioIds.map(scenarioId =>
    formatScenarioCoverageSummary(spec, scenarioId)
  );

  console.log(`${label(page)} QA spec written: ${jsonPath}`);
  console.log(`${label(page)} rule-abstracted spec: ${specAbstractedJson}`);
  console.log(`${label(page)} QA markdown written: ${mdPath}`);
  for (const line of summary) console.log(`  - ${line}`);
  if (skipCount > 0) {
    console.log(`  (${skipCount} scenario(s) skipped via @qa-live-skip)`);
  }
}

function label(page) {
  return pageLabel(page);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
