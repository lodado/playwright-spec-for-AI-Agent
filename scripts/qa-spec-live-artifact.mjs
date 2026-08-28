import {
  pageLabelFromSlug,
  renderAbstractAuditAppendix,
  renderGwtPlanFromSpec,
  renderLiveSpecAppendices,
} from "./qa-spec-judge-document.mjs";
import { buildUploadFixturesPayload } from "./qa-spec-artifacts.mjs";

function pageLabel(page) {
  return pageLabelFromSlug(page);
}

/**
 * Front matter carries the same stamps as `qa-spec-live.json`, so a plan pasted
 * into a review or an issue still says which spec revision produced it.
 */
function renderFrontMatter(spec, page) {
  const fields = [
    ["page", page],
    ["sourceHash", spec?.sourceHash],
    ["promptRev", spec?.promptRev],
    ["rulesVersion", spec?.abstraction?.rulesVersion],
    ["generatedAt", spec?.abstraction?.aiAppliedAt],
  ].filter(([, value]) => Boolean(value));

  return ["---", ...fields.map(([key, value]) => `${key}: ${value}`), "---"].join(
    "\n"
  );
}

/**
 * `{page}-qa-spec-live.md` — written only by `abstract-ai` (GWT + optional fixture list).
 * Playwright sources are omitted; judge uses JSON spec + this plan.
 */
export function renderLiveSpecMarkdown({
  spec,
  page,
  audit = null,
  gwtBody = null,
}) {
  const uploadFixtures = buildUploadFixturesPayload(spec, page);
  const alwaysRunScenarioIds = (spec.scenarios ?? [])
    .filter(s => s.alwaysRun)
    .map(s => s.scenarioId);

  const agentPlan = gwtBody?.trim();
  const gwt =
    agentPlan ?? renderGwtPlanFromSpec(spec, { alwaysRunScenarioIds }).trim();
  // The rule-based fallback states only what should happen; without the agent's
  // `Never:` line nothing in it can fail, and the judge must be told so.
  const fallbackWarning = agentPlan
    ? ""
    : "> Rule-based fallback plan: the abstraction agent produced no livePlan, so no scenario below carries a `Never:` clause. Treat every check as manual_review rather than pass.";
  const appendices = renderLiveSpecAppendices({
    uploadFixtures,
    specSourceFiles: {},
  }).trim();

  const parts = [
    renderFrontMatter(spec, page),
    "",
    `# ${pageLabel(page)} QA spec (Live)`,
    "",
    ...(fallbackWarning ? [fallbackWarning, ""] : []),
    gwt,
  ];
  if (appendices) parts.push("", appendices);
  let doc = `${parts.join("\n")}\n`;

  if (audit?.changes?.length) {
    doc = `${doc.trimEnd()}\n\n${renderAbstractAuditAppendix(audit)}`;
  }

  return doc;
}
