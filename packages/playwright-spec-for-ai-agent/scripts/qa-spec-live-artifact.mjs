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

  const gwt =
    gwtBody?.trim() ??
    renderGwtPlanFromSpec(spec, { alwaysRunScenarioIds }).trim();
  const appendices = renderLiveSpecAppendices({
    uploadFixtures,
    specSourceFiles: {},
  }).trim();

  const parts = [`# ${pageLabel(page)} QA spec (Live)`, "", gwt];
  if (appendices) parts.push("", appendices);
  let doc = `${parts.join("\n")}\n`;

  if (audit?.changes?.length) {
    doc = `${doc.trimEnd()}\n\n${renderAbstractAuditAppendix(audit)}`;
  }

  return doc;
}
