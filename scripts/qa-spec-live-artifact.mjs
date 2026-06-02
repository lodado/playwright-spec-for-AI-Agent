import { renderFriendlyQaSpecMarkdown } from "./qa-spec-judge-document.mjs";
import {
  buildUploadFixturesPayload,
  loadSpecSourceFiles,
} from "./qa-spec-artifacts.mjs";

/**
 * Write-ready markdown for `{page}-qa-spec-live.md` (fixtures, Playwright sources, audit).
 */
export function renderLiveSpecMarkdown({
  spec,
  page,
  specDir,
  titleSuffix = " (Live)",
  audit = null,
}) {
  const specSourceFiles = loadSpecSourceFiles(specDir);
  const uploadFixtures = buildUploadFixturesPayload(spec, page);
  const alwaysRunScenarioIds = (spec.scenarios ?? [])
    .filter(s => s.alwaysRun)
    .map(s => s.scenarioId);

  return renderFriendlyQaSpecMarkdown(spec, page, {
    titleSuffix,
    specSourceFiles,
    uploadFixtures,
    alwaysRunScenarioIds,
    audit,
  });
}
