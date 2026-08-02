import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, renameSync, rmdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { compileAbstractPlaywrightArtifact } from "../abstract-playwright/index.mjs";
import { EVIDENCE_ARCHIVE_LIMITS, canonicalHash, validateContract } from "../contracts/index.mjs";
import { createAdaptiveExecutionInput, DEFAULT_ADAPTIVE_BUDGET } from "../runtime/index.mjs";
import { writeEvidenceArchive } from "../evidence/index.mjs";
import { createHermesExecutionProposer } from "../provider-hermes/index.mjs";
import { assertPlaywrightAdaptiveExecution, runAdaptiveSuiteWithPlaywright } from "../runtime/playwright.mjs";
import { extractStaticAuthority } from "../static-authority/index.mjs";
import { validateAdaptiveExecutionEvidence } from "../runtime/validate-evidence.mjs";
import { abstractSpecInputs } from "./qa-native-abstract.mjs";
import { CliError, createExclusiveQaDirectory, readBoundedSpec, writePrivateJsonExclusive } from "./qa-native.mjs";

const MAX_AUTH_BOOTSTRAP_BYTES = 64 * 1024;

export async function executeQaNative({ specPath, specPaths, baseUrl, runDirectory, integrityKey, cwd, page, storageStatePath, authBootstrapPath, allowedOrigins, pageTargetPath, pageUrl, budgetOverrides = {} }, overrides = {}) {
  const reportDiagnostics = overrides.reportDiagnostics ?? defaultReportDiagnostics;
  const reportSummary = overrides.reportSummary ?? defaultReportSummary;
  const reportScenario = overrides.reportScenario ?? defaultReportScenario;
  const createAdaptiveInput = overrides.createAdaptiveInput ?? createAdaptiveExecutionInput;
  const createProposer = overrides.createProposer ?? createHermesExecutionProposer;
  const executeAdaptive = overrides.executeAdaptive ?? runAdaptiveSuiteWithPlaywright;
  const validateEvidence = overrides.validateEvidence ?? validateAdaptiveExecutionEvidence;
  const reportInvalidRun = overrides.reportInvalidRun ?? defaultReportInvalidRun;
  const writeArchive = overrides.writeArchive ?? writeEvidenceArchive;
  const projectRoot = realpathSync(cwd);
  let created = false;
  let executionStarted = false;
  try {
    createExclusiveQaDirectory(relative(cwd, runDirectory), { cwd });
    created = true;
    const authBootstrap = authBootstrapPath === undefined ? undefined : readAuthBootstrap(authBootstrapPath);
    const sourceInputs = (specPaths ?? [specPath]).map(path => {
      const resolvedPath = realpathSync(path);
      return { source: readBoundedSpec(resolvedPath), sourcePath: relative(projectRoot, resolvedPath) };
    });
    const authorityInputs = sourceInputs.map(input => ({ ...input, manifest: extractStaticAuthority(input) }));
    const runnableInputs = authorityInputs.filter(input => !input.manifest.tests.every(test => test.policy.navigation === "BLOCKED"));
    for (const input of authorityInputs.filter(item => !runnableInputs.includes(item))) {
      reportDiagnostics([{ severity: "INFO", code: "STATIC_POLICY_BLOCKED", message: `Skipped spec because all ${input.manifest.tests.length} test(s) are statically policy-blocked.`, path: input.sourcePath }]);
    }
    if (runnableInputs.length === 0) throw new CliError("no policy-eligible specs remain");

    const abstractInputs = overrides.abstractInputs ?? abstractSpecInputs;
    const records = await abstractInputs({ sourceInputs: runnableInputs, page, cwd }, { extract: overrides.extractFull, review: overrides.reviewFull });
    const manual = records.filter(record => record.artifact.status !== "APPROVED");
    if (manual.length > 0) {
      for (const record of manual) reportDiagnostics([{ severity: "WARNING", code: "BEHAVIOR_MANUAL_REVIEW", message: record.artifact.reason, path: record.manifest.source.path }]);
      throw new CliError("AI behavior review requires manual review");
    }

    const compileAbstract = overrides.compileAbstract ?? compileAbstractPlaywrightArtifact;
    const compiledResults = records.map((record, index) => compileAbstract({ artifact: record.artifact, manifest: record.manifest, ...runnableInputs[index] }));
    const compileResult = compiledResults.length === 1 ? compiledResults[0] : mergeCompileResults(compiledResults);
    if (compileResult.diagnostics.length > 0) reportDiagnostics(compileResult.diagnostics);
    let qaIr = withoutPolicyBlockedScenarios(compileResult.qaIr);
    qaIr = applyPageTarget(qaIr, { pageTargetPath, pageUrl });
    const scenarios = qaIr.suites.flatMap(suite => suite.scenarios);
    if (scenarios.length === 0) throw new CliError("no policy-eligible behavior remains");

    const runId = basename(runDirectory);
    const budget = { ...DEFAULT_ADAPTIVE_BUDGET, ...budgetOverrides };
    const agentInputs = scenarios.map(scenario => createAdaptiveInput({ qaIr, scenarioId: scenario.id, baseUrl, runId, budget, ...(allowedOrigins === undefined ? {} : { allowedOrigins }) }));
    if (agentInputs.reduce((total, input) => total + input.remainingBudget.actions, 0) > EVIDENCE_ARCHIVE_LIMITS.checkpoints) throw new CliError("runtime action budget exceeds the evidence archive limit");

    executionStarted = true;
    const execution = await executeAdaptive({ inputs: agentInputs, proposeAction: createProposer(), storageStatePath, authBootstrap, projectRoot });
    assertPlaywrightAdaptiveExecution(execution);
    let agentOutcomes;
    try {
      agentOutcomes = execution.executions.map((entry, index) => validateContract("ExecutionAgentOutcome", entry.outcome, { input: agentInputs[index] }));
      if (execution.bundles.length === 0 || execution.manifest === undefined) throw new CliError("runtime produced no sealed evidence");
      execution.executions.forEach((entry, index) => validateEvidence({
        input: agentInputs[index],
        outcome: agentOutcomes[index],
        bundles: execution.bundles.filter(bundle => entry.bundleIds.includes(bundle.bundleId)),
        manifest: execution.manifest,
        readBlob: execution.readBlob,
      }));
    } catch (error) {
      preserveInvalidRun({ runDirectory, cwd, execution, writeArchive, integrityKey, reportInvalidRun });
      created = false;
      throw error;
    }

    const target = { ...(pageTargetPath ? { pageTargetPath } : {}), ...(pageUrl ? { pageUrl } : {}) };
    const authorities = records.map(record => Object.keys(target).length === 0 ? record.manifest : { ...record.manifest, target });
    const behaviors = records.map(record => record.artifact);
    const authority = authorities.length === 1 ? authorities[0] : authorities;
    const behavior = behaviors.length === 1 ? behaviors[0] : behaviors;
    const runEvidence = {
      ...execution.manifest,
      bindings: { authorityHash: canonicalHash(authority), behaviorHash: canonicalHash(behavior) },
    };
    writePrivateJsonExclusive(relative(cwd, join(runDirectory, "authority.json")), authority, { cwd });
    writePrivateJsonExclusive(relative(cwd, join(runDirectory, "behavior.json")), behavior, { cwd });
    writeArchive({ directory: join(runDirectory, "evidence"), bundles: execution.bundles, manifest: runEvidence, readBlob: execution.readBlob, integrityKey });

    const nonCompleted = agentOutcomes.filter(outcome => outcome.type !== "COMPLETED");
    for (const outcome of nonCompleted) reportScenario({ scenarioId: outcome.scenarioId, type: outcome.type, reason: outcome.reason });
    reportSummary({ runDirectory: relative(cwd, runDirectory), executed: agentInputs.length, skipped: compileResult.qaIr.suites.flatMap(suite => suite.scenarios).length - agentInputs.length, nonCompleted: nonCompleted.length });
    return 0;
  } catch (error) {
    if (created) {
      if (executionStarted) quarantineRunDirectory({ runDirectory, cwd, reportInvalidRun });
      else {
        try { rmdirSync(runDirectory); } catch { quarantineRunDirectory({ runDirectory, cwd, reportInvalidRun }); }
      }
    }
    throw error;
  }
}

// A failed run is itself the debugging record of the failure: seal whatever evidence the provider
// produced, then quarantine the directory as <run-dir>.invalid instead of deleting it. Nothing in
// this path may delete evidence; errors here only degrade to stderr notes (fixed strings — never
// error details, which stay behind QA_NATIVE_DEBUG).
function preserveInvalidRun({ runDirectory, cwd, execution, writeArchive, integrityKey, reportInvalidRun }) {
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
function defaultReportSummary({ runDirectory, executed, skipped, notApplicable = 0, nonCompleted = 0 }) {
  const nonCompletedNote = nonCompleted > 0 ? `, ${nonCompleted} budget-exhausted` : "";
  const blocked = Math.max(0, skipped - notApplicable);
  const skippedNote = [notApplicable > 0 ? `${notApplicable} not-applicable` : "", blocked > 0 ? `${blocked} blocked` : ""].filter(Boolean).join(", ");
  process.stdout.write(`qa-native: executed ${executed} scenario(s)${nonCompletedNote}${skippedNote ? `, skipped ${skippedNote}` : ""} → ${runDirectory}\n`);
}

// Adaptive scenarios that ended ERROR/BLOCKED still sealed evidence; surface each one's outcome and
// consumption (the reason string carries the per-scenario turns/seconds/tokens from budget exhaustion).
function defaultReportScenario({ scenarioId, type, reason }) {
  process.stderr.write(`qa-native: scenario ${scenarioId} ${type} — ${reason}\n`);
}

// Combine per-file compile results (page mode compiles the page's whole spec directory) into one
// QA IR whose suites/scenarios and blocked/semantic side channels are the union across files.
// Scenario and suite ids are stable hashes over source path + content, so they stay unique across
// files and no de-duplication is needed.
export function mergeCompileResults(results) {
  const first = results[0].qaIr;
  const suites = results.flatMap((result) => result.qaIr.suites);
  const blockedScenarioIds = results.flatMap((result) => result.qaIr.extensions?.blockedScenarioIds ?? []);
  const semanticJudgmentScenarioIds = results.flatMap((result) => result.qaIr.extensions?.semanticJudgmentScenarioIds ?? []);
  const abstractScenarios = Object.assign({}, ...results.map(result => result.qaIr.extensions?.abstractScenarios ?? {}));
  const qaIr = {
    ...first,
    id: `qa-ir:${canonicalHash(results.map((result) => result.qaIr.id)).slice("sha256:".length)}`,
    suites,
    extensions: {
      ...first.extensions,
      sourceContentHash: canonicalHash(results.map((result) => result.qaIr.extensions?.sourceContentHash ?? result.qaIr.id)),
      ...(blockedScenarioIds.length > 0 ? { blockedScenarioIds } : {}),
      ...(semanticJudgmentScenarioIds.length > 0 ? { semanticJudgmentScenarioIds } : {}),
      ...(Object.keys(abstractScenarios).length > 0 ? { abstractScenarios } : {}),
    },
  };
  return { schemaVersion: results[0].schemaVersion, ok: results.every((result) => result.ok), qaIr, diagnostics: results.flatMap((result) => result.diagnostics) };
}

// Rewrite each scenario's startup NAVIGATE (the spec's @qa-page PATH) to the config's per-page
// target — a locale-prefixed path (PATH) or a full same-origin URL. No-op when neither is set or a
// scenario has no PATH navigation.
export function applyPageTarget(qaIr, { pageTargetPath, pageUrl } = {}) {
  if (!pageTargetPath && !pageUrl) return qaIr;
  const target = pageUrl ? { type: "URL", value: pageUrl } : { type: "PATH", value: pageTargetPath };
  const rewrite = (steps) => steps.map((step) => (step.kind === "NAVIGATE" && step.target?.type === "PATH" ? { ...step, target } : step));
  return {
    ...qaIr,
    suites: qaIr.suites.map((suite) => ({ ...suite, scenarios: suite.scenarios.map((scenario) => ({ ...scenario, steps: rewrite(scenario.steps) })) })),
  };
}

// Static policy-blocked scenarios never reach the browser or execution AI.
export function withoutPolicyBlockedScenarios(qaIr) {
  const blocked = new Set(qaIr.extensions?.blockedScenarioIds ?? []);
  if (blocked.size === 0) return qaIr;
  const { blockedScenarioIds, ...extensions } = qaIr.extensions;
  return {
    ...qaIr,
    suites: qaIr.suites.map((suite) => ({ ...suite, scenarios: suite.scenarios.filter((scenario) => !blocked.has(scenario.id)) })),
    extensions,
  };
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
