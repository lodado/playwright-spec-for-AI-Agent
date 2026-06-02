#!/usr/bin/env node
/**
 * Hermes AI pass — refines expectations + compact Given/When/Then livePlan.
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
import { loadSpecSourceFiles } from "./qa-spec-artifacts.mjs";
import { renderLiveSpecMarkdown } from "./qa-spec-live-artifact.mjs";
import {
  artifactPaths,
  ensureProjectConfig,
  parsePageArg,
  resolveSpecDir,
} from "./page-qa-paths.mjs";

const HERMES_MAX_TURNS_ABSTRACT = 6;

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function buildAbstractHermesQuery(payload) {
  return [
    "You are a QA spec abstractor. CRITICAL: do not use any tools (no browser, terminal, files).",
    "Your final message must be ONLY one raw JSON object — no markdown fences, no prose before or after.",
    "",
    "## Your task",
    "1. Rewrite expectations in specDefinition for non-deterministic live staging (semantic intents, not mock literals).",
    "2. Write livePlan: compact Given/When/Then markdown for Hermes judge (one block per test).",
    "",
    "## Immutable (do not change)",
    "- scenarios[].scenarioId, label, sourceFile, liveSkip, alwaysRun",
    "- tests[].title, checkId, stagingMode, liveRunPolicy, livePolicyAnnotation, fixtures",
    "",
    "## You MAY change in spec JSON",
    "- tests[].expectations[]",
    "- tests[].liveIntent (short Given-oriented phrase)",
    "- tests[].abstractReview (boolean)",
    "",
    "## spec JSON rules",
    "1. Replace exact mock literals with semantic intents and constraints.",
    "2. Keep locators (testId, role) unless mock-only text.",
    "3. judgment-mock-api: user-visible outcome, not API JSON.",
    "4. Do not tighten regex/semantic back to exact literals.",
    "5. confidence low → abstractReview: true.",
    "6. Never change liveRunPolicy or remove blocked tests.",
    "7. Never remove all expectations from a test that had expectations.",
    "",
    "## livePlan format (required)",
    "Markdown only. No credentials. No lecture text.",
    "Per scenario: `## {label}` then line `id:\\`{scenarioId}\\` file:\\`{sourceFile}\\`` plus `always-run` if applicable.",
    "Per test: `### N. {exact title}` then:",
    "**Given:**",
    "- bullets: scenario id, file, liveIntent, fixtures if any",
    "**When:**",
    "- one line from liveRunPolicy (e.g. inspect only; safe UI steps; mock-api intent; or skip)",
    "**Then:**",
    "- bullets: what must hold (from refined expectations); blocked → `- skip`",
    "Include every test title from specDefinition exactly once.",
    "",
    "## Response format",
    "Return ONLY a raw JSON object — no prose, no markdown fences.",
    'Fields: { "spec": <full spec object>, "livePlan": "<markdown string>", "changes": [ { "checkId", "field", "before", "after", "reason", "confidence": "high"|"medium"|"low" } ] }',
    "",
    "## Payload",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function writeLiveArtifacts({ paths, spec, page, specDir, audit, gwtBody }) {
  writeFileSync(paths.specLiveJson, `${JSON.stringify(spec, null, 2)}\n`);
  writeFileSync(
    paths.specLiveMd,
    renderLiveSpecMarkdown({
      spec,
      page,
      specDir,
      audit,
      gwtBody,
    })
  );
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
    requiredKeys: ["spec", "livePlan"],
    mode: "text-only",
  });

  const normalized = normalizeAbstractAiResult(inputSpec, raw);

  writeFileSync(
    paths.abstractAuditJson,
    `${JSON.stringify(normalized.audit ?? { errors: normalized.errors }, null, 2)}\n`
  );

  if (!normalized.ok) {
    console.error("Hermes abstract-ai validation failed:");
    for (const err of normalized.errors ?? []) console.error(`  - ${err}`);
    writeLiveArtifacts({
      paths,
      spec: inputSpec,
      page,
      specDir,
      audit: normalized.audit,
      gwtBody: null,
    });
    console.warn(`Fell back to input spec: ${paths.specLiveJson}`);
    console.warn(`Fell back to rule-based GWT: ${paths.specLiveMd}`);
    process.exit(1);
  }

  writeLiveArtifacts({
    paths,
    spec: normalized.spec,
    page,
    specDir,
    audit: normalized.audit,
    gwtBody: normalized.livePlan,
  });

  console.log(`Live spec (AI): ${paths.specLiveJson}`);
  console.log(`Live plan (GWT): ${paths.specLiveMd}`);
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
