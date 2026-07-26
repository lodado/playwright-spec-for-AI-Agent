import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { compilePlaywrightSpec } from "../adapter-playwright/index.mjs";
import { RUNTIME_OUTCOME_VERSION, validateContract } from "../contracts/index.mjs";
import { createAdaptiveExecutionInput, createExecutionPlan } from "../core/index.mjs";
import { writeEvidenceArchive } from "../evidence/index.mjs";
import { createHermesExecutionProposer } from "../provider-hermes/index.mjs";
import { assertPlaywrightAdaptiveExecution, executeWithPlaywright, playwrightExecutionCapabilities, runAdaptiveWithPlaywright } from "../provider-playwright/index.mjs";
import { validateAdaptiveExecutionEvidence } from "./qa-native-adaptive-evidence.mjs";
import { writeAuthenticatedRunEnvelope } from "./qa-native-run-envelope.mjs";
import { createExclusiveQaDirectory, writePrivateJsonExclusive } from "./qa-native.mjs";

const MAX_SPEC_BYTES = 4 * 1024 * 1024;

export async function executeQaNative({ specPath, baseUrl, runDirectory, integrityKey, cwd, provider = "playwright", mode = "strict" }, overrides = {}) {
  const compile = overrides.compile ?? compilePlaywrightSpec;
  const plan = overrides.plan ?? createExecutionPlan;
  const execute = overrides.execute ?? executeWithPlaywright;
  const createAdaptiveInput = overrides.createAdaptiveInput ?? createAdaptiveExecutionInput;
  const createProposer = overrides.createProposer ?? createHermesExecutionProposer;
  const executeAdaptive = overrides.executeAdaptive ?? runAdaptiveWithPlaywright;
  const writeArchive = overrides.writeArchive ?? writeEvidenceArchive;
  const projectRoot = realpathSync(cwd);
  let created = false;
  try {
    createExclusiveQaDirectory(relative(cwd, runDirectory), { cwd });
    created = true;
    const source = readBoundedSpec(specPath);
    const compileResult = compile({ source, sourcePath: relative(projectRoot, specPath) });
    if (!compileResult.ok) throw new Error("QA spec compilation failed");
    const qaIr = compileResult.qaIr;
    let execution;
    let executionPlan;
    let agentInput;
    let agentOutcome;
    let runtimeOutcome;
    if (provider === "hermes" && mode === "adaptive") {
      const scenarios = qaIr.suites.flatMap((suite) => suite.scenarios);
      if (scenarios.length !== 1) throw new Error("adaptive execution currently requires exactly one scenario");
      agentInput = createAdaptiveInput({ qaIr, scenarioId: scenarios[0].id, baseUrl, runId: basename(runDirectory) });
      execution = await executeAdaptive({ input: agentInput, proposeAction: createProposer() });
      assertPlaywrightAdaptiveExecution(execution);
      agentOutcome = validateContract("ExecutionAgentOutcome", execution.outcome, { input: agentInput });
      if (agentOutcome.type !== "COMPLETED") throw new Error("adaptive execution failed");
      validateAdaptiveExecutionEvidence({ input: agentInput, ...execution, outcome: agentOutcome });
      runtimeOutcome = validateContract("RuntimeOutcome", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "execute", type: "COMPLETED" });
    } else if (provider === "playwright" && mode === "strict") {
      executionPlan = plan({ qaIr, providerCapabilities: playwrightExecutionCapabilities() });
      execution = await execute({ qaIr, plan: executionPlan, baseUrl, runId: basename(runDirectory) });
      runtimeOutcome = validateContract("RuntimeOutcome", execution.outcome);
    } else {
      throw new Error("execution provider and mode combination is unsupported");
    }
    if (runtimeOutcome.stage !== "execute" || runtimeOutcome.type !== "COMPLETED" || execution.bundles.length === 0 || execution.manifest === undefined) throw new Error("QA execution failed");
    writePrivateJsonExclusive(relative(cwd, join(runDirectory, "qa-ir.json")), qaIr, { cwd });
    if (executionPlan !== undefined) writePrivateJsonExclusive(relative(cwd, join(runDirectory, "execution-plan.json")), executionPlan, { cwd });
    writeArchive({
      directory: join(runDirectory, "evidence"),
      bundles: execution.bundles,
      manifest: execution.manifest,
      readBlob: execution.readBlob,
      integrityKey,
    });
    if (agentInput !== undefined) {
      writePrivateJsonExclusive(relative(cwd, join(runDirectory, "execution-agent-input.json")), agentInput, { cwd });
      writePrivateJsonExclusive(relative(cwd, join(runDirectory, "execution-agent-outcome.json")), agentOutcome, { cwd });
    }
    writePrivateJsonExclusive(relative(cwd, join(runDirectory, "run.json")), runtimeOutcome, { cwd });
    writeAuthenticatedRunEnvelope({
      runDirectory,
      cwd,
      integrityKey,
      runId: basename(runDirectory),
      mode,
      qaIr,
      runtimeOutcome,
      evidenceManifest: execution.manifest,
      ...(mode === "strict" ? { executionPlan } : { executionAgentInput: agentInput, executionAgentOutcome: agentOutcome }),
    });
    return 0;
  } catch (error) {
    if (created) rmSync(runDirectory, { recursive: true, force: true });
    throw error;
  }
}

function readBoundedSpec(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_SPEC_BYTES) throw new Error("QA spec input is invalid");
    const buffer = Buffer.alloc(MAX_SPEC_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SPEC_BYTES) throw new Error("QA spec input is invalid");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    closeSync(descriptor);
  }
}
