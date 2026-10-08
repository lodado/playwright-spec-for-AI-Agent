// Oracle refactor-modularity, row O21 (P6, Q19 a): doctor over a damaged run ledger, and the nightly stage
// exits over the same ledger. Expected values restate S25 and Q19 a: doctor lists the run ledger check as
// failed with `chain broken at entry N` and exits 3; a stage exit does not reflect the ledger, so nightly
// exits as it would over an intact ledger. The judge stage is covered in refactor-trace-judge-ledger.test.ts.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { appendRunEvent } from "../qa-run-ledger.mjs";
import { collectDoctorReport } from "../run-qa-doctor.mjs";
import { run as runNightly } from "../run-page-qa-nightly.mjs";
import { FIXED_NOW, makeLedgerFile, nodeIo } from "./refactor-trace-fixtures.mjs";

const SPEC = `// @qa-page: demo
// @qa-scenario: ACTIVE

import { test } from "@playwright/test";

// @qa-live-policy: readonly
test("shows the plan name", async () => {});
`;

type Damage = "edit-first" | "remove-first" | "cut-last";

let root = "";
let outputDir = "";
let ledger: ReturnType<typeof makeLedgerFile>;

/** a project whose ledger sits where doctor and nightly read it: <outputDir>/demo-qa-runs.jsonl */
function project() {
  const specDir = join(root, "specs");
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, "demo.spec.ts"), SPEC);
  outputDir = join(root, "__QA__");
  mkdirSync(outputDir, { recursive: true });
  const configPath = join(root, "playwright-spec-for-ai-agent.config.mjs");
  writeFileSync(
    configPath,
    `export default ${JSON.stringify({
      root,
      paths: { specDir, outputDir },
      staging: { authRequired: false },
      pages: { demo: { baseUrl: "https://staging.acme.test", targetPath: "/dashboard" } },
    })};\n`,
  );
  process.env.QA_OUTPUT_DIR = outputDir;
  return [`--config=${configPath}`, `--project-root=${root}`];
}

function writeLedger(entries: number, damage: Damage | null) {
  ledger = makeLedgerFile(outputDir);
  for (let index = 0; index < entries; index += 1) {
    appendRunEvent(ledger.path, { kind: "trace-event", runId: `run-${index + 1}` }, { now: FIXED_NOW, io: nodeIo });
    ledger.recordAppend();
  }
  if (damage === "edit-first") ledger.editFirst();
  if (damage === "remove-first") ledger.removeFirst();
  if (damage === "cut-last") ledger.tearLast();
}

function doctorExit(args: string[]) {
  const result = spawnSync(process.execPath, [resolve(__dirname, "../run-qa-doctor.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, QA_AI_ADAPTER: "fixture" },
  });
  return { status: result.status, stdout: result.stdout };
}

const ledgerCheck = (report: { checks: Array<{ name: string }> }) =>
  report.checks.find(entry => entry.name === "demo · run ledger") as
    | { status: string; detail: string }
    | undefined;

beforeEach(() => {
  resetProjectConfigForTests();
  root = mkdtempSync(join(tmpdir(), "refactor-trace-doctor-"));
  process.env.QA_AI_ADAPTER = "fixture";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProjectConfigForTests();
  delete process.env.QA_OUTPUT_DIR;
  delete process.env.QA_AI_ADAPTER;
  rmSync(root, { recursive: true, force: true });
});

describe("doctor as a run ledger that verifies intact", () => {
  it("to be the run ledger check passed with 3 entries and exit 0", async () => {
    const args = project();
    writeLedger(3, null);

    const report = await collectDoctorReport(args);

    expect(ledgerCheck(report)).toMatchObject({ status: "pass", detail: "3 entries, chain verified" });
    expect(report.ok).toBe(true);
    expect(doctorExit(args).status).toBe(0);
  });
});

describe("doctor as a run ledger that verifies broken under P6", () => {
  it.each([
    [0, "edit-first", 3],
    [0, "remove-first", 3],
    [2, "cut-last", 3],
    [0, "cut-last", 1],
  ] as Array<[number, Damage, number]>)("to be the run ledger check failed at entry %i and exit 3 after %s of %i entries", async (brokenAt, damage, entries) => {
    const args = project();
    writeLedger(entries, damage);

    const report = await collectDoctorReport(args);

    expect(ledgerCheck(report)?.status).toBe("fail");
    expect(ledgerCheck(report)?.detail).toMatch(new RegExp(`^chain broken at entry ${brokenAt}: `));
    expect(report.ok).toBe(false);
    const cli = doctorExit(args);
    expect(cli.status).toBe(3);
    expect(cli.stdout).toContain(`chain broken at entry ${brokenAt}: `);
  });
});

describe("nightly stage as a damaged run ledger", () => {
  const NIGHTLY_ARGS = () => [`--project-root=${root}`, `--output-dir=${outputDir}`, "--page=demo"];

  /** nightly over `damage`, its stages scripted to exit with `codes`; resolves the nightly exit */
  async function nightlyExit(damage: Damage | null, codes: Record<string, number>) {
    resetProjectConfigForTests();
    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "refactor-trace-doctor-"));
    project();
    writeLedger(3, damage);
    return runNightly(NIGHTLY_ARGS(), { spawn: (script: string) => codes[script] ?? 0 });
  }

  it.each([
    [0, "all stages exit 0", {}],
    [3, "judge exits 3", { "run-hermes-page-judge.mjs": 3 }],
    [1, "judge exits 1", { "run-hermes-page-judge.mjs": 1 }],
  ] as Array<[number, string, Record<string, number>]>)("to be exit %i over an intact ledger and over each damaged one when %s", async (want, _situation, codes) => {
    const exits = {
      intact: await nightlyExit(null, codes),
      "edit-first": await nightlyExit("edit-first", codes),
      "remove-first": await nightlyExit("remove-first", codes),
      "cut-last": await nightlyExit("cut-last", codes),
    };

    expect(exits).toEqual({ intact: want, "edit-first": want, "remove-first": want, "cut-last": want });
  });
});
