#!/usr/bin/env node
/**
 * Hermes AI pass — writes Given/When/Then livePlan for the judge.
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent abstract-ai --page=dashboard
 *   npx playwright-spec-for-ai-agent abstract-ai --page=dashboard --dry-run
 *   npx playwright-spec-for-ai-agent abstract-ai --page=dashboard --force
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readArtifact, withSchema } from "./artifact-schema.mjs";
import { runMain, UsageError } from "./errors.mjs";
import { hashSpecDefinition } from "./spec-hash.mjs";
import { ABSTRACTION_RULES_VERSION } from "./expectation-abstractor.mjs";
import { buildGwtPromptSpec } from "./abstract-ai-payload.mjs";
import { prepareAdapter, runAgent } from "./ai-agent-adapter.mjs";
import { normalizeAbstractAiResult } from "./normalize-abstracted-spec.mjs";
import { renderLiveSpecMarkdown } from "./qa-spec-live-artifact.mjs";
import { loadSpecSourceFiles } from "./qa-spec-artifacts.mjs";
import {
  artifactPaths,
  ensureProjectConfig,
  parsePageArg,
  resolveSpecDir,
} from "./page-qa-paths.mjs";

const HERMES_MAX_TURNS_ABSTRACT = 2;

/**
 * Bump whenever {@link buildAbstractHermesQuery} changes what it asks for. It is
 * stamped next to the input hash so a prompt change re-runs the agent even
 * though the specs are untouched.
 */
export const ABSTRACT_PROMPT_REV = "3.0.0";

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

export function buildAbstractHermesQuery(payload) {
  return [
    "You are a QA spec writer for live staging. CRITICAL: do not use any tools.",
    "Your final message must be ONLY one raw JSON object — no markdown fences, no prose.",
    "",
    "## Task",
    "Write livePlan as explicit Given/When/Then/Never markdown — one block per test in specDefinition.",
    "Each test includes only `qaLivePolicy` from Playwright `@qa-live-policy`; use that value in When/Then behavior.",
    "Do not explain what policies mean. Just apply them.",
    "",
    "## Source is the authority",
    "Each runnable test carries its Playwright body as `source`. That body is the",
    "authority on what the check asserts — the title only names it. Derive When and",
    "Then from what the code actually does: every assertion in the body must be",
    "represented, and an assertion the body never makes must not appear.",
    "A test with no `source` is not run; state `skip`.",
    "",
    "Scenario/Test options you must apply:",
    "- `alwaysRun: true` -> scenario header must include `always-run`.",
    "- `liveSkip: true` -> scenario should be marked as skipped on live; tests under it should not be executable.",
    "- `qaLivePolicy` values: `readonly`, `safe-interaction`, `safe-interaction-no-confirm`, `mock-judgment`, `subscription-mutation`, `auth-mock`, `skip`.",
    "- For `subscription-mutation` / `auth-mock` / `skip`, Then should state `skip`.",
    "Use semantic intent for non-deterministic live data: generalize literals/counts/labels/dates.",
    "Example: prefer '문서를 확인한다' over exact mock literal like '세금계산서를 확인한다'.",
    "Given must state scenario + context, When must state action/review mode, Then must state pass condition.",
    "Include every test title exactly once, verbatim, in its heading. Never invent a test.",
    "",
    "## Never (mandatory, one per block)",
    "Every block MUST end with a `Never:` line naming the concrete observation that",
    "makes this check FAIL — the falsifiable half. A block that only says what should",
    "happen is confirmable by anything and will be rejected.",
    "Bad: `Never: anything unexpected happens`.",
    "Good: `Never: the score area renders an error state or stays empty after load`.",
    "For `qaLivePolicy: readonly`, the block must also state the literal text",
    "`mutations: 0` — the run must write nothing (no POST/PUT/PATCH/DELETE, no",
    "create/delete/save/purchase action).",
    "",
    "## livePlan format",
    "Plain markdown. Per test, e.g.:",
    "### {scenarioId} — {title}",
    "Given: ...",
    "When: ...",
    "Then: ...",
    "Never: ...",
    "",
    "## Response",
    '{ "livePlan": "<markdown string>" }',
    "",
    "## Payload",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function writeAudit(paths, audit) {
  writeFileSync(paths.abstractAuditJson, `${JSON.stringify(audit, null, 2)}\n`);
}

function readExistingAudit(paths) {
  if (!existsSync(paths.abstractAuditJson)) return {};
  try {
    return readArtifact(paths.abstractAuditJson);
  } catch {
    return {};
  }
}

/** Reuse is only safe when both halves of the plan's provenance still match. */
function reusableLiveSpec(paths, inputHash) {
  if (!existsSync(paths.specLiveJson) || !existsSync(paths.specLiveMd)) {
    return null;
  }
  const existing = readArtifact(paths.specLiveJson, { kind: "qa-spec" });
  if (existing.sourceHash !== inputHash) return null;
  if (existing.promptRev !== ABSTRACT_PROMPT_REV) return null;
  return existing;
}

/**
 * Quoting the source is best-effort: the stage's own input is the spec JSON, so
 * a project whose spec directory has moved since `spec` ran still abstracts —
 * with a thinner prompt, not a crash.
 */
function readSpecSources(page) {
  try {
    return loadSpecSourceFiles(resolveSpecDir(page));
  } catch {
    return {};
  }
}

export async function run(argv) {
  await ensureProjectConfig(argv);
  const page = parsePageArg(argv);
  const dryRun = hasFlag(argv, "--dry-run");
  const force = hasFlag(argv, "--force");
  const paths = artifactPaths(page);

  mkdirSync(paths.outputDir, { recursive: true });

  const inputPath = existsSync(paths.specAbstractedJson)
    ? paths.specAbstractedJson
    : paths.specJson;

  if (!existsSync(inputPath)) {
    throw new UsageError(`Missing QA spec: ${inputPath}`, {
      hint: `Run \`npx playwright-spec-for-ai-agent spec --page=${page}\` first.`,
    });
  }

  const inputSpec = readArtifact(inputPath, { kind: "qa-spec" });
  // Provenance is always measured against the raw `spec` artifact, never
  // against whichever derived artifact happened to feed the agent: `judge`
  // re-derives the same hash from spec.json, and hashing spec-abstracted.json
  // here would make every plan look stale to it.
  const provenanceSpec = existsSync(paths.specJson)
    ? readArtifact(paths.specJson, { kind: "qa-spec" })
    : inputSpec;
  const inputHash = hashSpecDefinition(provenanceSpec);

  if (!dryRun && !force) {
    const reused = reusableLiveSpec(paths, inputHash);
    if (reused) {
      writeAudit(paths, {
        ...readExistingAudit(paths),
        reused: true,
        reusedAt: new Date().toISOString(),
        promptRev: ABSTRACT_PROMPT_REV,
        sourceHash: inputHash,
      });
      console.log(
        `Live spec reused (input unchanged): ${paths.specLiveJson} — no agent call. Use --force to regenerate.`
      );
      return;
    }
  }

  const payload = {
    task: "abstract-qa-spec-gwt",
    page,
    rulesVersion: ABSTRACTION_RULES_VERSION,
    // The spec source, not the parsed expectations: the parser only names the
    // assertions it supports, so a plan written from its output silently
    // describes a narrower check than the test actually makes.
    specDefinition: buildGwtPromptSpec(inputSpec, {
      specSourceFiles: readSpecSources(page),
    }),
  };

  const query = buildAbstractHermesQuery(payload);

  if (dryRun) {
    writeFileSync(paths.hermesAbstractQuery, query);
    console.log(`Dry run — query written: ${paths.hermesAbstractQuery}`);
    console.log(`Query size: ~${Math.round(query.length / 4)} tokens (est.)`);
    return;
  }

  const adapter = await prepareAdapter();

  const raw = runAgent(query, HERMES_MAX_TURNS_ABSTRACT, {
    paths: {
      hermesAbstractQuery: paths.hermesAbstractQuery,
      hermesAbstractRawOutput: paths.hermesAbstractRawOutput,
    },
    requiredKeys: ["livePlan"],
    mode: "text-only",
  });

  const normalized = normalizeAbstractAiResult(inputSpec, raw);

  writeAudit(paths, {
    ...normalized.audit,
    reused: false,
    promptRev: ABSTRACT_PROMPT_REV,
    sourceHash: inputHash,
    adapter: adapter.name,
    agentMeta: raw?.agentMeta ?? null,
  });

  const spec = withSchema(
    {
      ...normalized.spec,
      sourceHash: inputHash,
      promptRev: ABSTRACT_PROMPT_REV,
    },
    "qa-spec"
  );

  writeFileSync(paths.specLiveJson, `${JSON.stringify(spec, null, 2)}\n`);
  writeFileSync(
    paths.specLiveMd,
    renderLiveSpecMarkdown({ spec, page, audit: null, gwtBody: normalized.livePlan })
  );

  console.log(`Live spec: ${paths.specLiveJson}`);
  console.log(`Live plan (GWT): ${paths.specLiveMd}`);
  const { coverage, repairs } = normalized.audit;
  console.log(
    `Coverage: ${coverage.addressed}/${coverage.planned} planned tests addressed`
  );
  for (const repair of repairs) {
    console.warn(`  ! repaired: ${repair.title} — ${repair.detail}`);
  }
  if (!normalized.livePlan) {
    console.warn("No livePlan in response — qa-spec-live.md uses rule-based GWT");
  }
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) runMain(() => run(process.argv.slice(2)));
