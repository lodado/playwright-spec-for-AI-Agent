#!/usr/bin/env node
/**
 * Hermes AI pass — writes Given/When/Then livePlan for the judge.
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent abstract-ai --page=dashboard
 *   npx playwright-spec-for-ai-agent abstract-ai --page=dashboard --dry-run
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ABSTRACTION_RULES_VERSION } from "./expectation-abstractor.mjs";
import { buildGwtPromptSpec } from "./abstract-ai-payload.mjs";
import { runHermes } from "./hermes-runner.mjs";
import { normalizeAbstractAiResult } from "./normalize-abstracted-spec.mjs";
import { renderLiveSpecMarkdown } from "./qa-spec-live-artifact.mjs";
import {
  artifactPaths,
  ensureProjectConfig,
  parsePageArg,
} from "./page-qa-paths.mjs";

const HERMES_MAX_TURNS_ABSTRACT = 2;

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function buildAbstractHermesQuery(payload) {
  return [
    "You are a QA spec writer for live staging. CRITICAL: do not use any tools.",
    "Your final message must be ONLY one raw JSON object — no markdown fences, no prose.",
    "",
    "## Task",
    "Write livePlan: Given/When/Then markdown for Hermes judge — one block per test in specDefinition.",
    "Each test includes testAnnotations (Playwright @qa-live-policy and derived liveRunPolicy). Use them in **When** (how to run on live) and **Then** (what counts as pass).",
    "Use semantic intents (not mock literals like dev-user, 42,835, exact Korean copy from mocks).",
    "mock-judgment / judgment-mock-api: judge intent only, no exact mock API replay.",
    "blocked-* / qaLiveSkip: Then should say skip on live.",
    "safe-interaction*: describe safe UI steps; never confirm destructive actions on live.",
    "fileAnnotations.qaAlwaysRun: include scenario even if account state differs.",
    "Include every test title exactly once.",
    "",
    "## livePlan format",
    "Plain markdown. Per test, e.g.:",
    "### {scenarioId} — {title}",
    "Given ...",
    "When ...",
    "Then ...",
    "",
    "## Response",
    '{ "livePlan": "<markdown string>" }',
    "",
    "## Payload",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function writeLiveArtifacts({ paths, spec, page, gwtBody }) {
  writeFileSync(paths.specLiveJson, `${JSON.stringify(spec, null, 2)}\n`);
  writeFileSync(
    paths.specLiveMd,
    renderLiveSpecMarkdown({
      spec,
      page,
      audit: null,
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

  const payload = {
    task: "abstract-qa-spec-gwt",
    page,
    rulesVersion: ABSTRACTION_RULES_VERSION,
    specDefinition: buildGwtPromptSpec(inputSpec),
  };

  const query = buildAbstractHermesQuery(payload);

  if (dryRun) {
    writeFileSync(paths.hermesAbstractQuery, query);
    console.log(`Dry run — query written: ${paths.hermesAbstractQuery}`);
    console.log(`Query size: ~${Math.round(query.length / 4)} tokens (est.)`);
    return;
  }

  const raw = runHermes(query, HERMES_MAX_TURNS_ABSTRACT, {
    paths: {
      hermesAbstractQuery: paths.hermesAbstractQuery,
      hermesAbstractRawOutput: paths.hermesAbstractRawOutput,
    },
    requiredKeys: ["livePlan"],
    mode: "text-only",
  });

  const normalized = normalizeAbstractAiResult(inputSpec, raw);

  writeFileSync(
    paths.abstractAuditJson,
    `${JSON.stringify(normalized.audit, null, 2)}\n`
  );

  writeLiveArtifacts({
    paths,
    spec: normalized.spec,
    page,
    gwtBody: normalized.livePlan,
  });

  console.log(`Live spec: ${paths.specLiveJson}`);
  console.log(`Live plan (GWT): ${paths.specLiveMd}`);
  if (normalized.livePlan) {
    console.log(`GWT length: ${normalized.livePlan.length} chars`);
  } else {
    console.warn("No livePlan in response — qa-spec-live.md uses rule-based GWT");
  }
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
