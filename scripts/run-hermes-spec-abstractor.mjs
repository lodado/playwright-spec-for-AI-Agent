#!/usr/bin/env node
/**
 * Hermes AI pass — rewrites expectations for non-deterministic live staging.
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent abstract-ai --page=dashboard
 *   npx playwright-spec-for-ai-agent abstract-ai --page=dashboard --dry-run
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ABSTRACTION_RULES_VERSION } from "./expectation-abstractor.mjs";
import { runHermes } from "./hermes-runner.mjs";
import { normalizeAbstractAiResult } from "./normalize-abstracted-spec.mjs";
import {
  artifactPaths,
  ensureProjectConfig,
  listAnnotatedSpecFiles,
  parsePageArg,
  resolveSpecDir,
} from "./page-qa-paths.mjs";
import { renderQaSpecMarkdown } from "./qa-spec-markdown.mjs";

const HERMES_MAX_TURNS_ABSTRACT = 40;

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function loadSpecSourceFiles(specDir) {
  const files = listAnnotatedSpecFiles(specDir);
  const result = {};
  for (const file of files) {
    result[file] = readFileSync(resolve(specDir, file), "utf8");
  }
  return result;
}

function buildAbstractHermesQuery(payload) {
  return [
    "You are a QA spec abstractor. Do NOT browse the web or log into staging.",
    "",
    "## Your task",
    "Rewrite expectations in specDefinition so they work on non-deterministic live staging data.",
    "Mock-specific numbers, dates, usernames, and order IDs must become semantic intents.",
    "",
    "## Immutable (do not change)",
    "- scenarios[].scenarioId, label, sourceFile, liveSkip, alwaysRun",
    "- tests[].title, checkId, stagingMode, liveRunPolicy, livePolicyAnnotation, fixtures",
    "",
    "## You MAY change",
    "- tests[].expectations[]",
    "- tests[].liveIntent (short sentence)",
    "- tests[].abstractReview (boolean — true when live judgment should prefer manual_review if ambiguous)",
    "",
    "## Rules",
    "1. Replace exact mock literals with semantic intents and constraints.",
    "2. Keep locators (testId, role) unless the locator value is mock-only text.",
    "3. For judgment-mock-api tests: describe user-visible outcome, not API response JSON.",
    "4. If rules already produced regex or semantic expectations, refine intent only — never tighten back to exact literals.",
    "5. confidence low → set abstractReview: true on that test.",
    "6. Never change liveRunPolicy or remove blocked tests.",
    "7. Never remove all expectations from a test that had expectations.",
    "",
    "## Response format",
    "Return ONLY a raw JSON object — no prose, no markdown fences.",
    'Fields: { "spec": <full spec object>, "changes": [ { "checkId", "field", "before", "after", "reason", "confidence": "high"|"medium"|"low" } ] }',
    "",
    "## Payload",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  await ensureProjectConfig(argv);
  const page = parsePageArg(argv);
  const dryRun = hasFlag(argv, "--dry-run");
  const paths = artifactPaths(page);

  mkdirSync(paths.outputDir, { recursive: true });

  const inputPath = existsSync(paths.specAbstractedJson)
    ? paths.specAbstractedJson
    : paths.specJson;

  if (!existsSync(inputPath)) {
    throw new Error(
      `Missing qa spec. Run \`npx playwright-spec-for-ai-agent spec --page=${page}\` first.`
    );
  }

  const inputSpec = JSON.parse(readFileSync(inputPath, "utf8"));
  const specDir = resolveSpecDir(page);
  const specSourceFiles = loadSpecSourceFiles(specDir);

  const payload = {
    task: "abstract-qa-spec",
    page,
    rulesVersion: ABSTRACTION_RULES_VERSION,
    specDefinition: inputSpec,
    specSourceFiles,
  };

  const query = buildAbstractHermesQuery(payload);

  if (dryRun) {
    writeFileSync(paths.hermesAbstractQuery, query);
    console.log(`Dry run — query written: ${paths.hermesAbstractQuery}`);
    return;
  }

  const raw = runHermes(query, HERMES_MAX_TURNS_ABSTRACT, {
    paths: {
      hermesAbstractQuery: paths.hermesAbstractQuery,
      hermesAbstractRawOutput: paths.hermesAbstractRawOutput,
    },
    requiredKeys: ["spec"],
  });

  const normalized = normalizeAbstractAiResult(inputSpec, raw);

  writeFileSync(paths.abstractAuditJson, `${JSON.stringify(normalized.audit ?? { errors: normalized.errors }, null, 2)}\n`);

  if (!normalized.ok) {
    console.error("Hermes abstract-ai validation failed:");
    for (const err of normalized.errors ?? []) console.error(`  - ${err}`);
    writeFileSync(
      paths.specLiveJson,
      `${JSON.stringify(inputSpec, null, 2)}\n`
    );
    console.warn(`Fell back to input spec: ${paths.specLiveJson}`);
    process.exit(1);
  }

  writeFileSync(
    paths.specLiveJson,
    `${JSON.stringify(normalized.spec, null, 2)}\n`
  );
  writeFileSync(
    paths.specLiveMd,
    renderQaSpecMarkdown(normalized.spec, page, { titleSuffix: " (Live)" })
  );

  console.log(`Live spec (AI): ${paths.specLiveJson}`);
  console.log(`Abstract audit: ${paths.abstractAuditJson}`);
  console.log(`Changes: ${normalized.audit?.changeCount ?? 0}`);
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
