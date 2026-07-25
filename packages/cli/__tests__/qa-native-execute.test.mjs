import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_OUTCOME_VERSION, validateContract } from "../../contracts/index.mjs";
import { createInMemoryEvidenceStore, readEvidenceArchive } from "../../evidence/index.mjs";
import { playwrightExecutionCapabilities } from "../../provider-playwright/index.mjs";
import { executeQaNative } from "../qa-native-execute.mjs";
import { runQaNative } from "../qa-native.mjs";

const temporaryDirectories = [];
const integrityKey = Buffer.alloc(32, 0x63);
const source = `// @qa-scenario: DASHBOARD_READONLY
test.describe("dashboard", () => {
  // @qa-live-policy: readonly
  test("shows dashboard", async ({ page }) => {
    await expect(page.getByText("Dashboard")).toBeVisible();
  });
});
`;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function project() {
  const cwd = mkdtempSync(join(tmpdir(), "qa-native-execute-"));
  temporaryDirectories.push(cwd);
  writeFileSync(join(cwd, "dashboard.spec.ts"), source);
  return cwd;
}

async function fixtureExecution({ qaIr, plan, runId }) {
  const store = createInMemoryEvidenceStore({
    providerCapabilities: playwrightExecutionCapabilities(),
    producer: { name: "execute-cli-test", version: "0.1.0" },
  });
  const scenario = qaIr.suites[0].scenarios[0];
  const checkpoint = scenario.steps.find((step) => step.kind === "CHECKPOINT");
  const artifact = store.captureArtifact({ id: "visible-text", type: "VISIBLE_TEXT", contentType: "text/plain", content: "Dashboard" });
  const bundle = store.createBundle({
    runId,
    scenarioId: scenario.id,
    checkpointId: checkpoint.checkpointId,
    capturedAt: "2026-07-25T00:00:00.000Z",
    environment: { targetUrl: "https://example.test/dashboard", browser: "chromium", viewport: { width: 1280, height: 720 } },
    artifacts: [artifact],
    facts: [],
  });
  return {
    outcome: validateContract("RuntimeOutcome", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "execute", type: "COMPLETED" }),
    bundles: [bundle],
    manifest: store.appendCheckpoint(bundle),
    readBlob: store.readBlob,
    plan,
  };
}

describe("qa-native execute persistence", () => {
  it("compiles, plans, executes, and persists an authenticated run", async () => {
    const cwd = project();
    const stderr = vi.fn();
    const status = await runQaNative([
      "execute",
      "--spec=dashboard.spec.ts",
      "--base-url=https://example.test",
      "--run-dir=.qa/runs/run-1",
    ], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
      handlers: { execute: (args) => executeQaNative(args, { execute: fixtureExecution }) },
      stdout: vi.fn(),
      stderr,
    });

    expect(status).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    const runDirectory = join(cwd, ".qa", "runs", "run-1");
    expect(lstatSync(runDirectory).mode & 0o777).toBe(0o700);
    const qaIr = JSON.parse(readFileSync(join(runDirectory, "qa-ir.json"), "utf8"));
    const plan = JSON.parse(readFileSync(join(runDirectory, "execution-plan.json"), "utf8"));
    const outcome = JSON.parse(readFileSync(join(runDirectory, "run.json"), "utf8"));
    expect(validateContract("QaIrDocument", qaIr)).toBe(qaIr);
    expect(validateContract("ExecutionPlan", plan)).toBe(plan);
    expect(validateContract("RuntimeOutcome", outcome).type).toBe("COMPLETED");
    expect(existsSync(join(runDirectory, "execution-outcome.json"))).toBe(false);
    expect(lstatSync(join(runDirectory, "qa-ir.json")).mode & 0o777).toBe(0o600);
    const replay = readEvidenceArchive({ directory: join(runDirectory, "evidence"), integrityKey });
    expect(replay.bundles).toHaveLength(1);
    expect(replay.readBlob(replay.bundles[0].artifacts[0].storageRef).toString("utf8")).toBe("Dashboard");
  });

  it("removes the run directory when persistence fails", async () => {
    const cwd = project();
    const stderr = vi.fn();
    const status = await runQaNative([
      "execute",
      "--spec=dashboard.spec.ts",
      "--base-url=https://example.test",
      "--run-dir=.qa/runs/failed",
    ], {
      cwd,
      env: { QA_NATIVE_INTEGRITY_KEY: integrityKey.toString("base64") },
      handlers: { execute: (args) => executeQaNative(args, { execute: fixtureExecution, writeArchive: () => { throw new Error("archive-secret"); } }) },
      stdout: vi.fn(),
      stderr,
    });

    expect(status).toBe(1);
    expect(existsSync(join(cwd, ".qa", "runs", "failed"))).toBe(false);
    expect(stderr).toHaveBeenCalledWith("qa-native: command failed\n");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("archive-secret");
  });

  it("publishes only the functional execute command", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    expect(packageJson.bin).toMatchObject({ "qa-native": "./bin/qa-native.mjs", "playwright-spec-for-ai-agent": "./bin/playwright-spec-for-ai-agent.mjs" });
    expect(packageJson.exports).toMatchObject({
      "./cli/qa-native": "./packages/cli/qa-native.mjs",
      "./cli/qa-native-execute": "./packages/cli/qa-native-execute.mjs",
    });
    expect(packageJson.files).toEqual(expect.arrayContaining(["packages/cli/qa-native.mjs", "packages/cli/qa-native-execute.mjs"]));
  });
});
