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
import { SPEC_READER_VERSION } from "./spec-annotation-reader.mjs";
import { buildGwtPromptSpec } from "./abstract-ai-payload.mjs";
import { prepareAdapter, runAgent } from "./ai-agent-adapter.mjs";
import { normalizeAbstractAiResult } from "./normalize-abstracted-spec.mjs";
import { renderLiveSpecMarkdown } from "./qa-spec-live-artifact.mjs";
import {
  artifactPaths,
  ensureProjectConfig,
  parsePageArg,
} from "./page-qa-paths.mjs";

const HERMES_MAX_TURNS_ABSTRACT = 2;

/**
 * Bump whenever {@link buildAbstractHermesQuery} changes what it asks for. It is
 * stamped next to the input hash so a prompt change re-runs the agent even
 * though the specs are untouched.
 */
export const ABSTRACT_PROMPT_REV = "4.1.0";

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
    "## Write from the title, not from implementation",
    "You are given each test's title and its live policy — not its code. The title",
    "is a claim about user-visible behaviour: state the outcome a user could see on",
    "a working page, in the terms the title uses. Do not invent selectors, test ids,",
    "element counts, or exact copy — you have not seen them, and a plan that guesses",
    "at implementation detail fails a correct page.",
    "Stay at the level the title supports: if a title names one observable outcome,",
    "the block asserts that one outcome.",
    "A test whose scenario is `liveSkip`, or whose policy is blocked, is not run; state `skip`.",
    "",
    "Scenario/Test options you must apply:",
    "- `alwaysRun: true` -> scenario header must include `always-run`.",
    "- `liveSkip: true` -> scenario should be marked as skipped on live; tests under it should not be executable.",
    "- `fixtures` -> the check uploads those named files; say so in Given.",
    "- `qaLivePolicy` values: `readonly`, `safe-interaction`, `safe-interaction-no-confirm`, `mock-judgment`, `subscription-mutation`, `auth-mock`, `skip`.",
    "- `safe-interaction-no-confirm` means the confirm/submit action is UNSAFE on live. When must open the flow and stop before it; Then may only assert what is observable up to that point, and must never instruct clicking confirm/OK/submit. Dismiss with Esc.",
    "- For `subscription-mutation` / `auth-mock` / `skip`, Then should state `skip`.",
    "Use semantic intent for non-deterministic live data: generalize literals/counts/labels/dates.",
    "Example: prefer '문서를 확인한다' over exact mock literal like '세금계산서를 확인한다'.",
    "Given must state scenario + context, When must state action/review mode, Then must state pass condition.",
    "Given describes only what is already true when the page loads. Every check starts from a freshly loaded page, so any step needed to reach the state under test (opening a dialog, entering a flow) is an action and belongs in When. A Given that assumes a dialog is 'already open' leaves nobody to open it.",
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

export async function run(argv) {
  await ensureProjectConfig(argv);
  const page = parsePageArg(argv);
  const dryRun = hasFlag(argv, "--dry-run");
  const force = hasFlag(argv, "--force");
  const paths = artifactPaths(page);

  mkdirSync(paths.outputDir, { recursive: true });

  const inputPath = paths.specJson;

  if (!existsSync(inputPath)) {
    throw new UsageError(`Missing QA spec: ${inputPath}`, {
      hint: `Run \`npx playwright-spec-for-ai-agent spec --page=${page}\` first.`,
    });
  }

  const inputSpec = readArtifact(inputPath, { kind: "qa-spec" });
  const inputHash = hashSpecDefinition(inputSpec);

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
    rulesVersion: SPEC_READER_VERSION,
    specDefinition: buildGwtPromptSpec(inputSpec),
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
