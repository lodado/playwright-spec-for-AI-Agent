import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "./errors.mjs";
import {
  getProjectConfig,
  mergeUploadFixtures,
  resolveDefaultUploadFixtures,
  resolveFixturePaths,
} from "./hermes-qa-project-config.mjs";
import { hashJson } from "./spec-hash.mjs";
import { listAnnotatedSpecFiles } from "./page-qa-paths.mjs";

export function loadSpecSourceFiles(specDir) {
  const files = listAnnotatedSpecFiles(specDir);
  const result = {};
  for (const file of files) {
    result[file] = readFileSync(join(specDir, file), "utf8");
  }
  return result;
}

/**
 * `sourceHash` for the `spec` stage: every `.spec.ts` in the directory (not
 * just the annotated ones — adding an annotation is itself a change) plus the
 * abstraction rules version, so a parser change invalidates downstream plans.
 */
export function hashSpecSources(specDir, rulesVersion) {
  const specSources = {};
  for (const file of readdirSync(specDir).filter(f => f.endsWith(".spec.ts")).sort()) {
    specSources[file] = readFileSync(join(specDir, file), "utf8");
  }
  return hashJson({ specSources, rulesVersion });
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

  const payload = {
    projectRoot,
    defaults: resolvedDefaults,
    byCheckId,
  };

  for (const absPath of missingFixturePaths(payload)) {
    console.warn(`QA fixture missing on disk: ${absPath}`);
  }

  return payload;
}

/** Absolute fixture paths the spec references that are not on disk. */
export function missingFixturePaths(payload) {
  const all = new Set([
    ...Object.values(payload?.defaults ?? {}),
    ...Object.values(payload?.byCheckId ?? {}).flatMap(entry =>
      Object.values(entry)
    ),
  ]);
  return [...all].filter(absPath => !existsSync(absPath));
}

/**
 * A fixture that does not exist is a `spec`-time authoring bug. Letting it
 * through only moves the failure to the judge run, where it looks like the
 * product broke rather than like a wrong `@qa-fixture:` path.
 */
export function assertFixturesExist(specDefinition, page, { allowMissing = false } = {}) {
  const missing = missingFixturePaths(
    buildUploadFixturesPayload(specDefinition, page)
  );
  if (missing.length === 0 || allowMissing) return missing;

  throw new UsageError(
    `${missing.length} upload fixture(s) referenced by the QA spec do not exist:\n${missing
      .map(absPath => `  ${absPath}`)
      .join("\n")}`,
    {
      hint: "Create the file(s), fix the `// @qa-fixture: name=path` path (resolved against the project root), or re-run with --allow-missing-fixtures.",
    }
  );
}
