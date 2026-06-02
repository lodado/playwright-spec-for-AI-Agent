#!/usr/bin/env node
/**
 * Apply rule-based expectation abstraction to an existing qa-spec JSON.
 *
 * Usage:
 *   node scripts/abstract-page-qa-spec.mjs --page=dashboard
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { abstractSpec } from "./expectation-abstractor.mjs";
import {
  artifactPaths,
  ensureProjectConfig,
  parsePageArg,
} from "./page-qa-paths.mjs";
import { renderQaSpecMarkdown } from "./qa-spec-markdown.mjs";

async function main() {
  const argv = process.argv.slice(2);
  await ensureProjectConfig(argv);
  const page = parsePageArg(argv);
  const paths = artifactPaths(page);

  if (!existsSync(paths.specJson)) {
    console.error(
      `Missing ${paths.slug}-qa-spec.json. Run spec --page=${page} first.`
    );
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(paths.specJson, "utf8"));
  const abstracted = abstractSpec(raw);

  writeFileSync(paths.specAbstractedJson, `${JSON.stringify(abstracted, null, 2)}\n`);
  console.log(`Rule-abstracted spec: ${paths.specAbstractedJson}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
