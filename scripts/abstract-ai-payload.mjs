/**
 * Compact Hermes payload for abstract-ai (GWT livePlan + @qa-live-policy only).
 *
 * The agent is given the Playwright source of each runnable test rather than
 * the parsed `expectations`. The parser only names the assertions it happens to
 * support, so a plan derived from its output describes a narrower check than
 * the spec actually makes — silently. The source is the authority; the parsed
 * expectations are kept downstream only as an oracle to cross-check the plan.
 */
import { extractTestBlocks } from "./dashboard-spec-parser.mjs";

const MAX_SOURCE_CHARS = 1200;

function isBlockedPolicy(liveRunPolicy) {
  return liveRunPolicy?.startsWith("blocked-") ?? false;
}

function clip(body) {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_SOURCE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_SOURCE_CHARS).trimEnd()}\n// … excerpt truncated`;
}

export function buildGwtPromptSpec(spec, { specSourceFiles = {} } = {}) {
  const blocksByFile = new Map();
  const blocksFor = fileName => {
    if (!blocksByFile.has(fileName)) {
      const source = specSourceFiles[fileName];
      blocksByFile.set(fileName, source ? extractTestBlocks(source) : []);
    }
    return blocksByFile.get(fileName);
  };

  return {
    scenarios: (spec?.scenarios ?? []).map(scenario => ({
      scenarioId: scenario.scenarioId,
      label: scenario.label,
      sourceFile: scenario.sourceFile,
      ...(scenario.alwaysRun ? { alwaysRun: true } : {}),
      ...(scenario.liveSkip ? { liveSkip: true } : {}),
      tests: (scenario.tests ?? []).map(test => {
        const block =
          scenario.liveSkip || isBlockedPolicy(test.liveRunPolicy)
            ? null
            : blocksFor(scenario.sourceFile).find(
                candidate => candidate.title === test.title
              );

        return {
          title: test.title,
          checkId: test.checkId,
          qaLivePolicy: test.livePolicyAnnotation ?? null,
          ...(block ? { source: clip(block.body) } : {}),
        };
      }),
    })),
  };
}
