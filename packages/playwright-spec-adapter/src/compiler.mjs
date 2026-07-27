import {
  STUDY_SPEC_VERSION,
  stableId,
  validateStudySpec,
} from "@persona-runtime/contracts";
import { parseSpecDirectory } from "./legacy/parser.mjs";

const DEFAULT_PERSONAS = [
  "impatient_new_user",
  "careful_business_buyer",
  "low_domain_knowledge_user",
];

export function parsePlaywrightSpecs({ specDir, page } = {}) {
  if (typeof specDir !== "string" || specDir.length === 0) {
    throw new TypeError("specDir must be a non-empty string");
  }
  const parsed = parseSpecDirectory(specDir);
  return {
    schemaVersion: "qa-ir/0.1",
    sourceDirectory: parsed.sourceDirectory ?? specDir,
    scenarios: page
      ? parsed.scenarios.filter(scenario => scenario.page === page || scenario.scenarioId === page)
      : parsed.scenarios,
    provenance: { parser: "typescript-ast", parserVersion: "0.2.0" },
  };
}

export function compilePlaywrightIRToStudy(ir, options = {}) {
  return compilePlaywrightIRToStudyResult(ir, options).studySpec;
}

export function compilePlaywrightIRToStudyResult(ir, {
  baseUrl,
  studyId = stableId("study", [ir?.sourceDirectory ?? "playwright-import"]),
  studyName = "Imported Playwright study",
  productDescription = "Product under behavioral evaluation",
  defaultViewport = { width: 1280, height: 720 },
  defaultPersonas = DEFAULT_PERSONAS,
  includeBlockedAsManualReview = true,
} = {}) {
  if (!ir || !Array.isArray(ir.scenarios)) throw new TypeError("ir.scenarios must be an array");
  if (typeof baseUrl !== "string" || baseUrl.length === 0) throw new TypeError("baseUrl is required");
  const warnings = [];
  const tasks = [];

  for (const scenario of ir.scenarios) {
    for (const test of scenario.tests ?? []) {
      const blocked = String(test.liveRunPolicy ?? "").startsWith("blocked-");
      if (blocked && !includeBlockedAsManualReview) continue;
      const oracles = (test.expectations ?? []).map((expectation, index) =>
        expectationToOracle(expectation, stableId("oracle", [scenario.scenarioId, test.checkId, index])),
      );
      if (oracles.length === 0) {
        warnings.push(warning("MOCK_ONLY_EXPECTATION", `${scenario.sourceFile}:${test.title}`, "No deterministic expectation was extracted."));
        oracles.push({ id: stableId("oracle", [scenario.scenarioId, test.checkId, "manual"]), type: "custom", evaluatorId: "manual-review" });
      }
      if (blocked) warnings.push(warning("BLOCKED_MUTATION", `${scenario.sourceFile}:${test.title}`, `Imported policy ${test.liveRunPolicy} requires review.`));

      tasks.push({
        id: stableId("task", [scenario.sourceFile, scenario.scenarioId, test.checkId]),
        name: test.title,
        goal: scenario.label || test.title,
        ...(scenario.page ? { startPath: scenario.page } : {}),
        successOracles: oracles,
        safetyPolicy: safetyPolicy(test.liveRunPolicy),
        maxActions: 20,
        maxDurationMs: 120_000,
        maxConsecutiveNoProgressActions: 4,
        abandonmentAllowed: !blocked,
        ...(blocked ? { humanValidation: { required: true, reason: test.liveRunPolicy } } : {}),
      });
    }
  }
  if (tasks.length === 0) throw new Error("no runnable or reviewable tasks were compiled");

  const studySpec = validateStudySpec({
    schemaVersion: STUDY_SPEC_VERSION,
    study: { id: studyId, name: studyName },
    product: { description: productDescription },
    environment: {
      baseUrl,
      allowedOrigins: [new URL(baseUrl).origin],
      viewport: defaultViewport,
    },
    tasks,
    personas: defaultPersonas.map(preset => ({ preset })),
    runtime: { seeds: [101], concurrency: 1, modelRoles: { action: "default", evaluator: "default" } },
    evidence: { screenshot: "every_action", trace: true, video: "on_failure", semanticSnapshot: "every_action" },
    evaluation: { minimumRecurrenceForFinding: 2, validityReport: true },
    provenance: { source: "playwright-spec", sourceRefs: ir.scenarios.map(scenario => scenario.sourceFile) },
  });
  return { studySpec, warnings };
}

function expectationToOracle(expectation, id) {
  if (expectation.type === "visible" || expectation.type === "notVisible") {
    return {
      id,
      type: "element",
      ...(expectation.locator?.role ? { role: expectation.locator.role } : {}),
      ...(expectation.locator?.name || expectation.locator?.value
        ? { name: expectation.locator.name ?? expectation.locator.value }
        : {}),
      state: expectation.type === "visible" ? "visible" : "hidden",
    };
  }
  const expected = expectation.expected ?? {};
  return {
    id,
    type: "visible_text",
    operation: expected.kind === "regex" ? "matches" : "contains",
    value: String(expected.pattern ?? expected.value ?? ""),
  };
}

function safetyPolicy(liveRunPolicy) {
  const interactive = liveRunPolicy === "executable-interaction" || liveRunPolicy === "judgment-interaction-no-confirm";
  const blocked = String(liveRunPolicy ?? "").startsWith("blocked-");
  return {
    allowRead: true,
    allowNavigation: !blocked,
    allowClick: interactive && !blocked,
    allowTyping: interactive && !blocked,
    allowFileUpload: interactive && !blocked,
    allowStateMutation: interactive && !blocked,
    allowExternalOrigin: false,
    forbiddenActions: ["payment", "subscription_change", "account_delete", "data_delete", "send_message", "confirm_destructive"],
    stopBeforeConfirmation: true,
  };
}

function warning(code, sourceRef, message) {
  return { code, sourceRef, message, suggestedResolution: "Review the generated StudySpec before execution." };
}
