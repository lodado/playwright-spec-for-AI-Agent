import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getProjectConfig,
  mergeUploadFixtures,
  resolveDefaultUploadFixtures,
  resolveFixturePaths,
} from "./hermes-qa-project-config.mjs";
import { listAnnotatedSpecFiles } from "./page-qa-paths.mjs";

export function loadSpecSourceFiles(specDir) {
  const files = listAnnotatedSpecFiles(specDir);
  const result = {};
  for (const file of files) {
    result[file] = readFileSync(join(specDir, file), "utf8");
  }
  return result;
}

export function buildUploadFixturesPayload(specDefinition, page) {
  const projectRoot = getProjectConfig().root;
  const configDefaults = resolveDefaultUploadFixtures(page);
  const resolvedDefaults = resolveFixturePaths(configDefaults, projectRoot);
  const byCheckId = {};

  for (const scenario of specDefinition?.scenarios ?? []) {
    const scenarioDefaults = mergeUploadFixtures(
      configDefaults,
      scenario.fixtures ?? {}
    );
    for (const test of scenario.tests ?? []) {
      const merged = mergeUploadFixtures(scenarioDefaults, test.fixtures ?? {});
      if (Object.keys(merged).length === 0) continue;
      byCheckId[test.checkId] = resolveFixturePaths(merged, projectRoot);
    }
  }

  const allPaths = new Set([
    ...Object.values(resolvedDefaults),
    ...Object.values(byCheckId).flatMap(entry => Object.values(entry)),
  ]);
  for (const absPath of allPaths) {
    if (!existsSync(absPath)) {
      console.warn(`QA fixture missing on disk: ${absPath}`);
    }
  }

  return {
    projectRoot,
    defaults: resolvedDefaults,
    byCheckId,
  };
}
