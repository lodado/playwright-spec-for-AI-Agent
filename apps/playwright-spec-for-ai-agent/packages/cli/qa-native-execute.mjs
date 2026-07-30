import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, renameSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { compilePlaywrightSpec } from "../adapter-playwright/index.mjs";
import { RUNTIME_OUTCOME_VERSION, validateContract } from "../contracts/index.mjs";
import { createAdaptiveExecutionInput, createExecutionPlan, DEFAULT_ADAPTIVE_BUDGET } from "../core/index.mjs";
import { writeEvidenceArchive } from "../evidence/index.mjs";
import { createHermesExecutionProposer } from "../provider-hermes/index.mjs";
import { assertPlaywrightAdaptiveExecution, executeWithPlaywright, playwrightExecutionCapabilities, runAdaptiveSuiteWithPlaywright } from "../provider-playwright/index.mjs";
import { validateAdaptiveExecutionEvidence } from "./qa-native-adaptive-evidence.mjs";
import { writeAuthenticatedRunEnvelope } from "./qa-native-run-envelope.mjs";
import { CliError, createExclusiveQaDirectory, writePrivateJsonExclusive } from "./qa-native.mjs";

const MAX_SPEC_BYTES = 4 * 1024 * 1024;
const MAX_AUTH_BOOTSTRAP_BYTES = 64 * 1024;

export async function executeQaNative({ specPath, baseUrl, runDirectory, integrityKey, cwd, provider = "playwright", mode = "strict", storageStatePath, authBootstrapPath, allowedOrigins, allowExternalRead, allowPartial = false, budgetOverrides = {} }, overrides = {}) {
  const compile = overrides.compile ?? compilePlaywrightSpec;
  const reportDiagnostics = overrides.reportDiagnostics ?? defaultReportDiagnostics;
  const reportSummary = overrides.reportSummary ?? defaultReportSummary;
  const reportScenario = overrides.reportScenario ?? defaultReportScenario;
  const plan = overrides.plan ?? createExecutionPlan;
  const execute = overrides.execute ?? executeWithPlaywright;
  const createAdaptiveInput = overrides.createAdaptiveInput ?? createAdaptiveExecutionInput;
  const createProposer = overrides.createProposer ?? createHermesExecutionProposer;
  const executeAdaptive = overrides.executeAdaptive ?? runAdaptiveSuiteWithPlaywright;
  const validateEvidence = overrides.validateEvidence ?? validateAdaptiveExecutionEvidence;
  const reportInvalidRun = overrides.reportInvalidRun ?? defaultReportInvalidRun;
  const writeArchive = overrides.writeArchive ?? writeEvidenceArchive;
  const projectRoot = realpathSync(cwd);
  let created = false;
  try {
    createExclusiveQaDirectory(relative(cwd, runDirectory), { cwd });
    created = true;
    const source = readBoundedSpec(specPath);
    const authBootstrap = authBootstrapPath === undefined ? undefined : readAuthBootstrap(authBootstrapPath);
    const compileResult = compile({ source, sourcePath: relative(projectRoot, specPath) });
    if (compileResult.diagnostics.length > 0) reportDiagnostics(compileResult.diagnostics);
    if (!compileResult.ok && !allowPartial) throw new Error("QA spec compilation failed");
    const qaIr = allowPartial ? withoutBlockedScenarios(compileResult.qaIr) : compileResult.qaIr;
    if (allowPartial && qaIr.suites.every((suite) => suite.scenarios.length === 0)) throw new Error("no statically compilable scenarios remain after skipping blocked ones");
    let execution;
    let executionPlan;
    let agentInputs;
    let agentOutcomes;
    let runtimeOutcome;
    if (provider === "hermes" && mode === "adaptive") {
      const scenarios = qaIr.suites.flatMap((suite) => suite.scenarios);
      if (scenarios.length === 0) throw new Error("adaptive execution requires at least one scenario");
      const runId = basename(runDirectory);
      const budget = { ...DEFAULT_ADAPTIVE_BUDGET, ...budgetOverrides };
      agentInputs = scenarios.map((scenario) => createAdaptiveInput({ qaIr, scenarioId: scenario.id, baseUrl, runId, budget, ...(allowedOrigins === undefined ? {} : { allowedOrigins }), ...(allowExternalRead === true ? { allowExternalRead: true } : {}) }));
      execution = await executeAdaptive({ inputs: agentInputs, proposeAction: createProposer(), storageStatePath, authBootstrap });
      assertPlaywrightAdaptiveExecution(execution);
      try {
        agentOutcomes = execution.executions.map((entry, index) => validateContract("ExecutionAgentOutcome", entry.outcome, { input: agentInputs[index] }));
        execution.executions.forEach((entry, index) => validateEvidence({
          input: agentInputs[index],
          outcome: agentOutcomes[index],
          bundles: execution.bundles.filter((bundle) => entry.bundleIds.includes(bundle.bundleId)),
          manifest: execution.manifest,
          readBlob: execution.readBlob,
        }));
      } catch (error) {
        preserveInvalidRun({ runDirectory, cwd, execution, agentInputs, writeArchive, integrityKey, reportInvalidRun });
        created = false;
        throw error;
      }
      runtimeOutcome = validateContract("RuntimeOutcome", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "execute", type: "COMPLETED" });
    } else if (provider === "playwright" && mode === "strict") {
      executionPlan = plan({ qaIr, providerCapabilities: playwrightExecutionCapabilities() });
      execution = await execute({ qaIr, plan: executionPlan, baseUrl, runId: basename(runDirectory), storageStatePath, authBootstrap });
      runtimeOutcome = validateContract("RuntimeOutcome", execution.outcome);
    } else {
      throw new Error("execution provider and mode combination is unsupported");
    }
    if (runtimeOutcome.stage !== "execute" || runtimeOutcome.type !== "COMPLETED" || execution.bundles.length === 0 || execution.manifest === undefined) {
      preserveInvalidRun({ runDirectory, cwd, execution, agentInputs, writeArchive, integrityKey, reportInvalidRun });
      created = false;
      // The outcome fields are provider-controlled enumerations and redacted messages, and the
      // sealed-bundle count is the primary "how far did it get" debugging signal — safe to print.
      throw new CliError(`QA execution failed (type=${runtimeOutcome.type}${runtimeOutcome.code === undefined ? "" : ` code=${runtimeOutcome.code}`}${runtimeOutcome.message === undefined ? "" : ` message=${runtimeOutcome.message}`} bundles=${execution.bundles.length})`);
    }
    writePrivateJsonExclusive(relative(cwd, join(runDirectory, "qa-ir.json")), qaIr, { cwd });
    if (executionPlan !== undefined) writePrivateJsonExclusive(relative(cwd, join(runDirectory, "execution-plan.json")), executionPlan, { cwd });
    writeArchive({
      directory: join(runDirectory, "evidence"),
      bundles: execution.bundles,
      manifest: execution.manifest,
      readBlob: execution.readBlob,
      integrityKey,
    });
    if (agentInputs !== undefined) {
      writePrivateJsonExclusive(relative(cwd, join(runDirectory, "execution-agent-inputs.json")), agentInputs, { cwd });
      writePrivateJsonExclusive(relative(cwd, join(runDirectory, "execution-agent-outcomes.json")), agentOutcomes, { cwd });
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
      ...(mode === "strict" ? { executionPlan } : { executionAgentInputs: agentInputs, executionAgentOutcomes: agentOutcomes }),
    });
    const executed = qaIr.suites.reduce((total, suite) => total + suite.scenarios.length, 0);
    const compiled = compileResult.qaIr.suites.reduce((total, suite) => total + suite.scenarios.length, 0);
    const nonCompleted = (agentOutcomes ?? []).filter((outcome) => outcome.type !== "COMPLETED");
    for (const outcome of nonCompleted) reportScenario({ scenarioId: outcome.scenarioId, type: outcome.type, reason: outcome.reason });
    reportSummary({ runDirectory: relative(cwd, runDirectory), provider, mode, executed, skipped: compiled - executed, nonCompleted: nonCompleted.length });
    return 0;
  } catch (error) {
    if (created) quarantineRunDirectory({ runDirectory, cwd, reportInvalidRun });
    throw error;
  }
}

// A failed run is itself the debugging record of the failure: seal whatever evidence the provider
// produced, then quarantine the directory as <run-dir>.invalid instead of deleting it. Nothing in
// this path may delete evidence; errors here only degrade to stderr notes (fixed strings — never
// error details, which stay behind QA_NATIVE_DEBUG).
function preserveInvalidRun({ runDirectory, cwd, execution, agentInputs, writeArchive, integrityKey, reportInvalidRun }) {
  try {
    if (execution.bundles.length > 0 && execution.manifest !== undefined) {
      writeArchive({
        directory: join(runDirectory, "evidence"),
        bundles: execution.bundles,
        manifest: execution.manifest,
        readBlob: execution.readBlob,
        integrityKey,
      });
    }
    if (agentInputs !== undefined) writePrivateJsonExclusive(relative(cwd, join(runDirectory, "execution-agent-inputs.json")), agentInputs, { cwd });
  } catch {
    process.stderr.write("qa-native: failed to seal invalid evidence\n");
  }
  quarantineRunDirectory({ runDirectory, cwd, reportInvalidRun });
}

// Rename rather than delete — evidence is never deleted (AGENTS.md invariant 2). The fallback
// suffix keeps repeated failures of the same run id from blocking each other.
function quarantineRunDirectory({ runDirectory, cwd, reportInvalidRun }) {
  let preservedAt = runDirectory;
  for (const target of [`${runDirectory}.invalid`, `${runDirectory}.invalid-${Date.now()}`]) {
    try {
      renameSync(runDirectory, target);
      preservedAt = target;
      break;
    } catch {
      // Try the next quarantine target; never delete.
    }
  }
  if (preservedAt === runDirectory) process.stderr.write("qa-native: failed to quarantine invalid run directory\n");
  reportInvalidRun({ preservedAt: relative(cwd, preservedAt) });
}

// The quarantined path is the operator's entry point for debugging a rejected run.
function defaultReportInvalidRun({ preservedAt }) {
  process.stderr.write(`qa-native: invalid run evidence preserved at ${preservedAt}\n`);
}

function defaultReportDiagnostics(diagnostics) {
  for (const item of diagnostics) {
    process.stderr.write(`[${item.severity}] ${item.code}: ${item.message}\n`);
  }
}

// A successful run was previously silent (exit 0, no output), leaving CI and operators unable to
// tell what ran. Emit a one-line summary of executed vs. skipped scenarios and the artifact path.
function defaultReportSummary({ runDirectory, provider, mode, executed, skipped, nonCompleted = 0 }) {
  const nonCompletedNote = nonCompleted > 0 ? `, ${nonCompleted} budget-exhausted` : "";
  const skippedNote = skipped > 0 ? `, skipped ${skipped} blocked` : "";
  process.stdout.write(`qa-native: ${provider}/${mode} executed ${executed} scenario(s)${nonCompletedNote}${skippedNote} → ${runDirectory}\n`);
}

// Adaptive scenarios that ended ERROR/BLOCKED still sealed evidence; surface each one's outcome and
// consumption (the reason string carries the per-scenario turns/seconds/tokens from budget exhaustion).
function defaultReportScenario({ scenarioId, type, reason }) {
  process.stderr.write(`qa-native: scenario ${scenarioId} ${type} — ${reason}\n`);
}

// Return a QA IR without the scenarios the adapter marked as statically un-runnable, so
// `--allow-partial` executes the compilable subset instead of the whole file failing closed.
export function withoutBlockedScenarios(qaIr) {
  const blocked = new Set(qaIr.extensions?.blockedScenarioIds ?? []);
  if (blocked.size === 0) return qaIr;
  const { blockedScenarioIds, ...extensions } = qaIr.extensions;
  return {
    ...qaIr,
    suites: qaIr.suites.map((suite) => ({ ...suite, scenarios: suite.scenarios.filter((scenario) => !blocked.has(scenario.id)) })),
    extensions,
  };
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

function readAuthBootstrap(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_AUTH_BOOTSTRAP_BYTES) throw new Error("auth bootstrap input is invalid");
    const buffer = Buffer.alloc(MAX_AUTH_BOOTSTRAP_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_AUTH_BOOTSTRAP_BYTES) throw new Error("auth bootstrap input is invalid");
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new Error("auth bootstrap input is invalid");
    }
  } finally {
    closeSync(descriptor);
  }
}
