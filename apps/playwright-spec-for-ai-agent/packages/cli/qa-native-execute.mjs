import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync, renameSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { compileAbstractPlaywrightArtifact } from "../abstract-playwright/index.mjs";
import { compilePlaywrightSpec, recoverPlaywrightSpecWithAi } from "../adapter-playwright/index.mjs";
import { RUNTIME_OUTCOME_VERSION, canonicalHash, validateContract } from "../contracts/index.mjs";
import { createAdaptiveExecutionInput, createExecutionPlan, DEFAULT_ADAPTIVE_BUDGET } from "../core/index.mjs";
import { writeEvidenceArchive } from "../evidence/index.mjs";
import { createHermesApplicabilitySelector, createHermesExecutionProposer, createHermesSpecAbstractor } from "../provider-hermes/index.mjs";
import { assertPlaywrightAdaptiveExecution, executeWithPlaywright, observeAdaptiveApplicabilityPage, playwrightExecutionCapabilities, runAdaptiveSuiteWithPlaywright } from "../provider-playwright/index.mjs";
import { validateAdaptiveExecutionEvidence } from "./qa-native-adaptive-evidence.mjs";
import { abstractSpecInputs } from "./qa-native-abstract-ai.mjs";
import { writeAuthenticatedRunEnvelope } from "./qa-native-run-envelope.mjs";
import { CliError, createExclusiveQaDirectory, ensurePrivateQaDirectory, readBoundedSpec, readPrivateJson, writePrivateJsonExclusive } from "./qa-native.mjs";

const MAX_AUTH_BOOTSTRAP_BYTES = 64 * 1024;

export async function executeQaNative({ specPath, specPaths, baseUrl, runDirectory, integrityKey, cwd, provider = "playwright", mode = "strict", compiler = "ast", page, storageStatePath, authBootstrapPath, allowedOrigins, allowExternalRead, allowPartial = false, pageTargetPath, pageUrl, budgetOverrides = {} }, overrides = {}) {
  if (!["ast", "abstract"].includes(compiler)) throw new TypeError("compiler is invalid");
  const compile = overrides.compile ?? compilePlaywrightSpec;
  const reportDiagnostics = overrides.reportDiagnostics ?? defaultReportDiagnostics;
  const reportSummary = overrides.reportSummary ?? defaultReportSummary;
  const reportScenario = overrides.reportScenario ?? defaultReportScenario;
  const plan = overrides.plan ?? createExecutionPlan;
  const execute = overrides.execute ?? executeWithPlaywright;
  const createAdaptiveInput = overrides.createAdaptiveInput ?? createAdaptiveExecutionInput;
  const createProposer = overrides.createProposer ?? createHermesExecutionProposer;
  const createApplicabilitySelector = overrides.createApplicabilitySelector ?? createHermesApplicabilitySelector;
  const observeApplicability = overrides.observeApplicability ?? observeAdaptiveApplicabilityPage;
  const executeAdaptive = overrides.executeAdaptive ?? runAdaptiveSuiteWithPlaywright;
  const validateEvidence = overrides.validateEvidence ?? validateAdaptiveExecutionEvidence;
  const reportInvalidRun = overrides.reportInvalidRun ?? defaultReportInvalidRun;
  const writeArchive = overrides.writeArchive ?? writeEvidenceArchive;
  const projectRoot = realpathSync(cwd);
  let created = false;
  try {
    createExclusiveQaDirectory(relative(cwd, runDirectory), { cwd });
    created = true;
    const specPathList = specPaths ?? [specPath];
    const authBootstrap = authBootstrapPath === undefined ? undefined : readAuthBootstrap(authBootstrapPath);
    const specInputs = specPathList.map(path => {
      const resolvedPath = realpathSync(path);
      return { source: readBoundedSpec(resolvedPath), sourcePath: relative(projectRoot, resolvedPath) };
    });
    let compiledResults;
    if (compiler === "abstract") {
      const abstractInputs = overrides.abstractInputs ?? abstractSpecInputs;
      const records = await abstractInputs({ sourceInputs: specInputs, page, cwd }, { extract: overrides.extractFull, review: overrides.reviewFull });
      const pairs = records.map((record, index) => ({ record, input: specInputs[index] }));
      const manual = pairs.filter(pair => pair.record.artifact.status !== "APPROVED");
      for (const pair of manual) reportDiagnostics([{ severity: "WARNING", code: "ABSTRACT_SPEC_MANUAL_REVIEW", message: "Skipped spec because its AI abstraction requires manual review.", path: pair.input.sourcePath }]);
      if (manual.length > 0 && !allowPartial) throw new CliError("AI abstraction requires manual review");
      const approved = pairs.filter(pair => pair.record.artifact.status === "APPROVED");
      if (approved.length === 0) throw new CliError("no approved AI abstractions remain after skipping manual-review specs");
      const compileAbstract = overrides.compileAbstract ?? compileAbstractPlaywrightArtifact;
      compiledResults = approved.map(pair => compileAbstract({ artifact: pair.record.artifact, manifest: pair.record.manifest, ...pair.input }));
    } else {
      compiledResults = specInputs.map(input => compile(input));
    }
    if (compiler === "ast" && compiledResults.some(result => (result.qaIr.extensions?.blockedScenarioIds ?? []).length > 0)) {
      const abstractScenario = overrides.abstractScenario ?? createHermesSpecAbstractor();
      const identity = overrides.abstractIdentity ?? abstractScenario.identity ?? { model: "unknown", modelVersion: "unknown" };
      const cache = aiAbstractionCache(cwd);
      compiledResults = await Promise.all(compiledResults.map((result, index) => recoverPlaywrightSpecWithAi({
        compileResult: result,
        source: specInputs[index].source,
        abstractScenario,
        cache,
        promptVersion: overrides.abstractPromptVersion ?? abstractScenario.promptVersion ?? "unknown",
        model: identity.model ?? "unknown",
        modelVersion: identity.modelVersion ?? "unknown",
      })));
    }
    const compileResult = compiledResults.length === 1 ? compiledResults[0] : mergeCompileResults(compiledResults);
    if (compileResult.diagnostics.length > 0) reportDiagnostics(compileResult.diagnostics);
    if (!compileResult.ok && !allowPartial) throw new Error("QA spec compilation failed");
    const compiledQaIr = allowPartial ? withoutBlockedScenarios(compileResult.qaIr) : compileResult.qaIr;
    // Page mode navigates to the config's per-page target (e.g. a locale-prefixed route) instead of
    // the spec's own @qa-page path.
    let qaIr = applyPageTarget(compiledQaIr, { pageTargetPath, pageUrl });
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
      const buildAdaptiveInput = (scenario) => createAdaptiveInput({ qaIr, scenarioId: scenario.id, baseUrl, runId, budget, ...(allowedOrigins === undefined ? {} : { allowedOrigins }), ...(allowExternalRead === true ? { allowExternalRead: true } : {}) });
      // A scenario can compile cleanly yet use an expectation/step kind the adaptive runtime cannot
      // execute (e.g. URL_MATCH). Under --allow-partial, skip those instead of failing the whole run,
      // and drop them from the QA IR so the written IR matches exactly what executed.
      const runnableIds = new Set();
      const builtInputs = [];
      for (const scenario of scenarios) {
        try {
          builtInputs.push(buildAdaptiveInput(scenario));
          runnableIds.add(scenario.id);
        } catch (error) {
          if (!allowPartial) throw error;
          reportDiagnostics([{ severity: "WARNING", code: "SCENARIO_UNRUNNABLE", message: `Skipped adaptive scenario ${scenario.id}: ${error instanceof Error ? error.message : "unsupported by adaptive runtime"}`, path: qaIr.source?.uri ?? "" }]);
        }
      }
      if (builtInputs.length === 0) throw new Error("no adaptive-runnable scenarios remain after skipping unsupported ones");
      // Inputs embed only qaIr.id (stable under narrowing) and their own scenario, so building them
      // against the pre-narrow IR stays consistent after dropping the skipped scenarios.
      if (runnableIds.size < scenarios.length) qaIr = retainScenarios(qaIr, runnableIds);
      agentInputs = builtInputs;
      if (compiler === "abstract") {
        let applicabilityDecisions;
        try {
          const scenarioBySelectorId = new Map();
          const selectorScenarios = qaIr.suites.flatMap((suite) => suite.scenarios).map((scenario, index) => {
            const selectorId = `S${index + 1}`;
            scenarioBySelectorId.set(selectorId, scenario.id);
            return { id: selectorId, applicability: scenario.semantics?.applicability ?? [] };
          });
          const pageObservation = await observeApplicability({ input: builtInputs[0], storageStatePath, authBootstrap, projectRoot });
          applicabilityDecisions = normalizeApplicabilityDecisions(
            selectorScenarios,
            await createApplicabilitySelector()({
              page: pageObservation,
              scenarios: selectorScenarios.map((scenario) => ({
                scenarioId: scenario.id,
                applicability: scenario.applicability,
              })),
            }),
          ).map((decision) => Object.freeze({ ...decision, scenarioId: scenarioBySelectorId.get(decision.scenarioId) }));
        } catch (error) {
          reportDiagnostics([{ severity: "WARNING", code: "APPLICABILITY_PREFLIGHT_FAILED", message: `Applicability preflight failed; preserving legacy execute-all behavior: ${error instanceof Error ? error.message : "unknown failure"}`, path: qaIr.source?.uri ?? "" }]);
          applicabilityDecisions = ambiguousApplicabilityDecisions(qaIr.suites.flatMap((suite) => suite.scenarios), "Applicability preflight failed; scenario retained for compatibility.");
        }
        let selectedIds = new Set(applicabilityDecisions.filter((decision) => decision.status !== "NOT_APPLICABLE").map((decision) => decision.scenarioId));
        if (selectedIds.size === 0) {
          reportDiagnostics([{ severity: "WARNING", code: "APPLICABILITY_PREFLIGHT_EMPTY", message: "Applicability preflight selected no scenarios; preserving legacy execute-all behavior.", path: qaIr.source?.uri ?? "" }]);
          applicabilityDecisions = ambiguousApplicabilityDecisions(qaIr.suites.flatMap((suite) => suite.scenarios), "Empty applicability selection fell back to legacy execution.");
          selectedIds = new Set(applicabilityDecisions.map((decision) => decision.scenarioId));
        }
        qaIr = { ...qaIr, extensions: { ...(qaIr.extensions ?? {}), applicabilityDecisions } };
        agentInputs = builtInputs.filter((input) => selectedIds.has(input.scenarioId));
        for (const decision of applicabilityDecisions.filter((item) => item.status === "NOT_APPLICABLE")) {
          reportDiagnostics([{ severity: "INFO", code: "SCENARIO_NOT_APPLICABLE", message: `Skipped ${decision.scenarioId}: ${decision.rationale}`, path: qaIr.source?.uri ?? "" }]);
        }
      }
      execution = await executeAdaptive({ inputs: agentInputs, proposeAction: createProposer(), storageStatePath, authBootstrap, projectRoot });
      assertPlaywrightAdaptiveExecution(execution);
      try {
        agentOutcomes = execution.executions.map((entry, index) => validateContract("ExecutionAgentOutcome", entry.outcome, { input: agentInputs[index] }));
        if (execution.bundles.length === 0 && execution.manifest === undefined) {
          const first = agentOutcomes.find((outcome) => outcome.type !== "COMPLETED") ?? agentOutcomes[0];
          preserveInvalidRun({ runDirectory, cwd, execution, agentInputs, agentOutcomes, writeArchive, integrityKey, reportInvalidRun });
          created = false;
          throw new CliError(`QA adaptive execution failed before evidence was sealed (scenarioId=${first?.scenarioId ?? "unknown"} type=${first?.type ?? "ERROR"} bundles=0)`);
        }
        execution.executions.forEach((entry, index) => validateEvidence({
          input: agentInputs[index],
          outcome: agentOutcomes[index],
          bundles: execution.bundles.filter((bundle) => entry.bundleIds.includes(bundle.bundleId)),
          manifest: execution.manifest,
          readBlob: execution.readBlob,
        }));
      } catch (error) {
        if (!created) throw error;
        preserveInvalidRun({ runDirectory, cwd, execution, agentInputs, agentOutcomes, writeArchive, integrityKey, reportInvalidRun });
        created = false;
        throw error;
      }
      runtimeOutcome = validateContract("RuntimeOutcome", { schemaVersion: RUNTIME_OUTCOME_VERSION, stage: "execute", type: "COMPLETED" });
    } else if (provider === "playwright" && mode === "strict") {
      const capabilities = playwrightExecutionCapabilities();
      if (allowPartial) {
        const scenarios = qaIr.suites.flatMap((suite) => suite.scenarios);
        const runnableIds = new Set();
        // ponytail: per-scenario planning is O(n²); export a core preflight validator only if page sizes make this measurable.
        for (const scenario of scenarios) {
          try {
            plan({ qaIr: retainScenarios(qaIr, new Set([scenario.id])), providerCapabilities: capabilities });
            runnableIds.add(scenario.id);
          } catch (error) {
            reportDiagnostics([{ severity: "WARNING", code: "SCENARIO_UNRUNNABLE", message: `Skipped strict scenario ${scenario.id}: ${error instanceof Error ? error.message : "unsupported by strict runtime"}`, path: qaIr.source?.uri ?? "" }]);
          }
        }
        if (runnableIds.size === 0) throw new Error("no strict-runnable scenarios remain after skipping unsupported ones");
        if (runnableIds.size < scenarios.length) qaIr = retainScenarios(qaIr, runnableIds);
      }
      executionPlan = plan({ qaIr, providerCapabilities: capabilities });
      execution = await execute({ qaIr, plan: executionPlan, baseUrl, runId: basename(runDirectory), storageStatePath, authBootstrap, projectRoot });
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
    const executed = agentInputs?.length ?? qaIr.suites.reduce((total, suite) => total + suite.scenarios.length, 0);
    const compiled = compileResult.qaIr.suites.reduce((total, suite) => total + suite.scenarios.length, 0);
    const notApplicable = qaIr.extensions?.applicabilityDecisions?.filter((decision) => decision.status === "NOT_APPLICABLE").length ?? 0;
    const nonCompleted = (agentOutcomes ?? []).filter((outcome) => outcome.type !== "COMPLETED");
    for (const outcome of nonCompleted) reportScenario({ scenarioId: outcome.scenarioId, type: outcome.type, reason: outcome.reason });
    reportSummary({ runDirectory: relative(cwd, runDirectory), provider, mode, executed, skipped: compiled - executed, notApplicable, nonCompleted: nonCompleted.length });
    return 0;
  } catch (error) {
    if (created) quarantineRunDirectory({ runDirectory, cwd, reportInvalidRun });
    throw error;
  }
}

function aiAbstractionCache(cwd) {
  const directory = ".qa/abstract-cache";
  return {
    read(cacheKey) {
      assertCacheKey(cacheKey);
      ensurePrivateQaDirectory(directory, { cwd });
      const path = `${directory}/${cacheKey}.json`;
      return existsSync(join(cwd, path)) ? readPrivateJson(path, { cwd }) : undefined;
    },
    write(cacheKey, artifact) {
      assertCacheKey(cacheKey);
      ensurePrivateQaDirectory(directory, { cwd });
      const path = `${directory}/${cacheKey}.json`;
      try {
        writePrivateJsonExclusive(path, artifact, { cwd });
      } catch (error) {
        if (!(error instanceof CliError) || error.message !== "output already exists") throw error;
      }
    },
  };
}

function assertCacheKey(value) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new CliError("AI abstraction cache key is invalid");
}

// A failed run is itself the debugging record of the failure: seal whatever evidence the provider
// produced, then quarantine the directory as <run-dir>.invalid instead of deleting it. Nothing in
// this path may delete evidence; errors here only degrade to stderr notes (fixed strings — never
// error details, which stay behind QA_NATIVE_DEBUG).
function preserveInvalidRun({ runDirectory, cwd, execution, agentInputs, agentOutcomes, writeArchive, integrityKey, reportInvalidRun }) {
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
  try {
    if (agentInputs !== undefined) writePrivateJsonExclusive(relative(cwd, join(runDirectory, "execution-agent-inputs.json")), agentInputs, { cwd });
    if (agentOutcomes !== undefined) writePrivateJsonExclusive(relative(cwd, join(runDirectory, "execution-agent-outcomes.json")), agentOutcomes, { cwd });
  } catch {
    process.stderr.write("qa-native: failed to preserve invalid metadata\n");
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

export function normalizeApplicabilityDecisions(scenarios, value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.scenarios)) throw new Error("applicability decision is invalid");
  const expected = new Set(scenarios.map((scenario) => scenario.id));
  if (value.scenarios.length !== expected.size) throw new Error("applicability decision coverage is incomplete");
  const seen = new Set();
  return value.scenarios.map((decision) => {
    if (!decision || typeof decision !== "object" || Array.isArray(decision) || Object.keys(decision).some((key) => !["scenarioId", "status", "confidence", "rationale"].includes(key))) throw new Error("applicability decision is invalid");
    if (!expected.has(decision.scenarioId) || seen.has(decision.scenarioId)) throw new Error("applicability decision scenario is invalid");
    if (!["APPLICABLE", "NOT_APPLICABLE", "AMBIGUOUS"].includes(decision.status) || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1 || typeof decision.rationale !== "string" || decision.rationale.length === 0 || decision.rationale.length > 2_000) throw new Error("applicability decision is invalid");
    seen.add(decision.scenarioId);
    return Object.freeze({
      scenarioId: decision.scenarioId,
      status: decision.status === "NOT_APPLICABLE" && decision.confidence < 0.8 ? "AMBIGUOUS" : decision.status,
      confidence: decision.confidence,
      rationale: decision.rationale,
    });
  });
}

function ambiguousApplicabilityDecisions(scenarios, rationale) {
  return scenarios.map((scenario) => Object.freeze({ scenarioId: scenario.id, status: "AMBIGUOUS", confidence: 0, rationale }));
}

// A successful run was previously silent (exit 0, no output), leaving CI and operators unable to
// tell what ran. Emit a one-line summary of executed vs. skipped scenarios and the artifact path.
function defaultReportSummary({ runDirectory, provider, mode, executed, skipped, notApplicable = 0, nonCompleted = 0 }) {
  const nonCompletedNote = nonCompleted > 0 ? `, ${nonCompleted} budget-exhausted` : "";
  const blocked = Math.max(0, skipped - notApplicable);
  const skippedNote = [notApplicable > 0 ? `${notApplicable} not-applicable` : "", blocked > 0 ? `${blocked} blocked` : ""].filter(Boolean).join(", ");
  process.stdout.write(`qa-native: ${provider}/${mode} executed ${executed} scenario(s)${nonCompletedNote}${skippedNote ? `, skipped ${skippedNote}` : ""} → ${runDirectory}\n`);
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

// Narrow a QA IR to a set of scenario ids, preserving qaIr.id and every other field. Used when
// adaptive input construction rejects a compile-valid scenario (an unsupported expectation/step
// kind) so the written IR matches the scenarios that actually executed.
export function retainScenarios(qaIr, keepIds) {
  return {
    ...qaIr,
    suites: qaIr.suites.map((suite) => ({ ...suite, scenarios: suite.scenarios.filter((scenario) => keepIds.has(scenario.id)) })),
  };
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
