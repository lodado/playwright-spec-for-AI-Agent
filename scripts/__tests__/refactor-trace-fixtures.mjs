/**
 * Fixtures shared by the refactor-modularity "trace" milestone (rows O4 to O12, O21):
 * temp directories, a node:fs-backed `io` port for the ledger core, byte-level ledger tampering,
 * and offline judge/review stage entries over stamped artifacts. It holds no expected values;
 * those come from the card rows, the model and the individual tests.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { main as judgeMain } from "../run-hermes-page-judge.mjs";
import { run as reviewRun } from "../run-hermes-judge-review.mjs";
import { hashSpecDefinition } from "../spec-hash.mjs";

export const FIXED_NOW = "2026-01-01T00:00:00.000Z";

export function makeTempDir(label) {
  return mkdtempSync(join(tmpdir(), `${label}-`));
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** The port the ledger core receives: `{ readFile, appendFile, exists }` over node:fs. */
export const nodeIo = {
  readFile: (path) => readFileSync(path, "utf8"),
  appendFile: (path, text) => appendFileSync(path, text),
  exists: (path) => existsSync(path),
};

/**
 * A ledger file the harness can damage one logical line at a time. Every line the product appends is
 * remembered as one chunk, so a tamper names a line even after a later append fused into a cut one.
 */
export function makeLedgerFile(dir, page = "demo") {
  const path = join(dir, `${page}-qa-runs.jsonl`);
  rmSync(path, { force: true });
  let chunks = [];
  const flush = () => writeFileSync(path, chunks.join(""));
  return {
    path,
    /** call after the product appended: records the bytes it added as the newest line */
    recordAppend() {
      const text = readFileSync(path, "utf8");
      const known = chunks.join("").length;
      chunks = [...chunks, text.slice(known)];
    },
    editFirst() {
      const entry = JSON.parse(chunks[0]);
      chunks = [`${JSON.stringify({ ...entry, kind: "edited-after-the-fact" })}\n`, ...chunks.slice(1)];
      flush();
    },
    removeFirst() {
      chunks = chunks.slice(1);
      flush();
    },
    /** cuts the newest line part-way, newline included, as a crash mid-write would */
    tearLast() {
      const last = chunks.at(-1);
      chunks = [...chunks.slice(0, -1), last.slice(0, Math.floor(last.length / 2))];
      flush();
    },
    dropLast() {
      chunks = chunks.slice(0, -1);
      flush();
    },
    lineCount: () => chunks.length,
    text: () => readFileSync(path, "utf8"),
  };
}

const SPEC_DEFINITION = {
  scenarios: [
    {
      scenarioId: "ACTIVE",
      label: "Dashboard - ACTIVE",
      sourceFile: "demo.spec.ts",
      alwaysRun: false,
      liveSkip: false,
      tests: [
        {
          title: "shows health score",
          checkId: "shows-health-score",
          liveRunPolicy: "executable-readonly",
          stagingMode: "read-only",
          expectations: [],
        },
      ],
    },
  ],
};

const OTHER_HASH = `sha256:${"0".repeat(64)}`;
const SPEC_HASH = hashSpecDefinition(SPEC_DEFINITION);

export function makeProject() {
  const root = makeTempDir("refactor-trace-project");
  const outputDir = join(root, "__QA__");
  const specDir = join(root, "specs");
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(specDir, { recursive: true });
  writeFileSync(
    join(specDir, "demo.spec.ts"),
    '// @qa-page: demo\n// @qa-scenario: ACTIVE\n\nimport { test } from "@playwright/test";\n\n// @qa-live-policy: readonly\ntest("shows health score", async () => {});\n',
  );
  const config = join(root, "playwright-spec-for-ai-agent.config.mjs");
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      root,
      paths: { specDir, outputDir },
      staging: { authRequired: false, baseUrl: "https://staging.acme.test" },
      pages: { demo: { baseUrl: "https://staging.acme.test", targetPath: "/dashboard" } },
    })};\n`,
  );
  return { root, outputDir, config, argv: [`--config=${config}`, `--project-root=${root}`, "--page=demo"] };
}

/** Writes the raw spec and the live plan; `stamp` is what the live plan's sourceHash says. */
function writeJudgeInputs(project, stamp) {
  writeFileSync(join(project.outputDir, "demo-qa-spec-live.md"), "## Plan\n\n### 1. shows health score\n");
  if (stamp === "missing-raw-spec") {
    writeFileSync(
      join(project.outputDir, "demo-qa-spec-live.json"),
      JSON.stringify({ ...SPEC_DEFINITION, sourceHash: OTHER_HASH }),
    );
    return;
  }
  writeFileSync(join(project.outputDir, "demo-qa-spec.json"), JSON.stringify(SPEC_DEFINITION));
  const live = { ...SPEC_DEFINITION };
  if (stamp === "matches") live.sourceHash = SPEC_HASH;
  if (stamp === "differs") live.sourceHash = OTHER_HASH;
  writeFileSync(join(project.outputDir, "demo-qa-spec-live.json"), JSON.stringify(live));
}

/** Writes the judgment (specHash SPEC_HASH) and the judge plan whose first line carries `stamp`. */
function writeReviewInputs(project, stamp) {
  mkdirSync(join(project.outputDir, "evidence"), { recursive: true });
  writeFileSync(join(project.outputDir, "evidence", "judge-1.yaml"), '- heading "Dashboard"\n');
  writeFileSync(
    join(project.outputDir, "demo-hermes-judgment.json"),
    JSON.stringify({
      schemaVersion: 1,
      artifactKind: "judgment",
      runId: "run-abc12345",
      page: "demo",
      status: "pass",
      specHash: SPEC_HASH,
      summary: "ok",
      checks: [],
      coverage: { planned: 0, addressed: 0, missing: [] },
      evidence: [],
      runnerEvidence: {
        tracePath: null,
        harPath: null,
        videoPath: null,
        screenshots: [],
        ariaSnapshots: [],
        violations: [],
      },
    }),
  );
  const header =
    stamp === "matches"
      ? `- **Spec hash:** \`${SPEC_HASH}\`\n\n`
      : stamp === "differs"
        ? `- **Spec hash:** \`${OTHER_HASH}\`\n\n`
        : "";
  writeFileSync(join(project.outputDir, "demo-qa-judge-plan.md"), `${header}### 1. shows health score\n`);
}

async function enterStage(stage, stamp, { dryRun = true } = {}) {
  const project = makeProject();
  const saved = {
    output: process.env.QA_OUTPUT_DIR,
    adapter: process.env.QA_AI_ADAPTER,
    log: console.log,
    warn: console.warn,
  };
  process.env.QA_OUTPUT_DIR = project.outputDir;
  process.env.QA_AI_ADAPTER = "fixture";
  console.log = () => {};
  console.warn = () => {};
  resetProjectConfigForTests();
  try {
    if (stage === "judge") {
      writeJudgeInputs(project, stamp);
      await judgeMain(dryRun ? [...project.argv, "--dry-run"] : project.argv);
    } else {
      writeReviewInputs(project, stamp);
      await reviewRun(dryRun ? [...project.argv, "--dry-run"] : project.argv);
    }
    return { entered: true };
  } catch (error) {
    return {
      entered: false,
      exitCode: error.exitCode,
      message: String(error.message),
      hint: String(error.hint ?? ""),
    };
  } finally {
    console.log = saved.log;
    console.warn = saved.warn;
    if (saved.output === undefined) delete process.env.QA_OUTPUT_DIR;
    else process.env.QA_OUTPUT_DIR = saved.output;
    if (saved.adapter === undefined) delete process.env.QA_AI_ADAPTER;
    else process.env.QA_AI_ADAPTER = saved.adapter;
    resetProjectConfigForTests();
    removeDir(project.root);
  }
}

/**
 * Starts the judge stage (dry run, no agent, no network) over a live plan stamped `stamp`:
 * "matches", "differs", "absent" (written before stamps existed) or "missing-raw-spec".
 * Resolves `{ entered: true }`, or the refusal `{ entered: false, exitCode, message, hint }`. A stage that
 * is not a dry run goes on to its agent once the stamp check lets it.
 */
export const enterJudgeStage = (stamp, options) => enterStage("judge", stamp, options);

/** Starts the review stage (dry run) over a judge plan stamped `stamp`: "matches", "differs" or "absent". */
export const enterReviewStage = (stamp, options) => enterStage("review", stamp, options);
