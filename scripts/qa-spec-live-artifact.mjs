import {
  pageLabelFromSlug,
  renderAbstractAuditAppendix,
  renderGwtPlanFromSpec,
  renderLiveSpecAppendices,
} from "./qa-spec-judge-document.mjs";
import {
  buildUploadFixturesPayload,
  loadSpecSourceFiles,
} from "./qa-spec-artifacts.mjs";

function pageLabel(page) {
  return pageLabelFromSlug(page);
}

/**
 * `{page}-qa-spec-live.md` — written only by `abstract-ai`.
 * @param {string|null} gwtBody — Hermes `livePlan` (Given/When/Then); falls back to rule render from spec JSON.
 */
export function renderLiveSpecMarkdown({
  spec,
  page,
  specDir,
  audit = null,
  gwtBody = null,
}) {
  const specSourceFiles = loadSpecSourceFiles(specDir);
  const uploadFixtures = buildUploadFixturesPayload(spec, page);
  const alwaysRunScenarioIds = (spec.scenarios ?? [])
    .filter(s => s.alwaysRun)
    .map(s => s.scenarioId);

  const gwt =
    gwtBody?.trim() ??
    renderGwtPlanFromSpec(spec, { alwaysRunScenarioIds }).trim();
  const appendices = renderLiveSpecAppendices({
    uploadFixtures,
    specSourceFiles,
  }).trim();

  const parts = [`# ${pageLabel(page)} QA spec (Live)`, "", gwt];
  if (appendices) parts.push("", appendices);
  let doc = `${parts.join("\n")}\n`;

  if (audit?.changes?.length) {
    doc = `${doc.trimEnd()}\n\n${renderAbstractAuditAppendix(audit)}`;
  }

  return doc;
}
