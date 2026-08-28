/** True when a test must not appear in live QA JSON artifacts. */
export function isLiveSkippedTest(test) {
  if (test.stagingMode === "live-skip") return true;
  return test.liveRunPolicy?.startsWith("blocked-") ?? false;
}

/** Human-readable skip reason for terminal reporting. */
export function liveSkipReason(scenario, test) {
  if (scenario.liveSkip) return "@qa-live-skip";
  if (test.livePolicyAnnotation) {
    return `@qa-live-policy: ${test.livePolicyAnnotation}`;
  }
  if (test.liveRunPolicy === "blocked-live-skip") {
    return "@qa-live-policy: skip";
  }
  return test.liveRunPolicy ?? "skip";
}

/**
 * Flat list of skipped tests (including whole-file @qa-live-skip scenarios).
 * This is what the `spec` artifact persists as `excluded`: a test dropped from
 * live QA and recorded nowhere is indistinguishable from a test that passed.
 */
export function collectLiveSkippedEntries(spec) {
  const entries = [];

  for (const scenario of spec?.scenarios ?? []) {
    for (const test of scenario.tests ?? []) {
      if (!scenario.liveSkip && !isLiveSkippedTest(test)) continue;
      entries.push({
        sourceFile: scenario.sourceFile,
        scenarioId: scenario.scenarioId,
        title: test.title,
        reason: liveSkipReason(scenario, test),
        policy: test.livePolicyAnnotation ?? test.liveRunPolicy ?? null,
      });
    }
  }

  return entries;
}

/** Test declarations the parser could not read, summed across scenarios. */
export function countUnparsedSpecTests(spec) {
  return (spec?.scenarios ?? []).reduce(
    (total, scenario) => total + (scenario.unparsedTestCount ?? 0),
    0
  );
}

/** Drop live-skipped scenarios/tests before writing qa-spec JSON. */
export function filterSpecForLiveJson(spec) {
  const scenarios = [];

  for (const scenario of spec?.scenarios ?? []) {
    if (scenario.liveSkip) continue;

    const tests = (scenario.tests ?? []).filter(test => !isLiveSkippedTest(test));
    if (tests.length === 0) continue;

    scenarios.push({ ...scenario, tests });
  }

  return {
    ...spec,
    scenarios,
  };
}

export function countLiveSpecTests(spec) {
  return (spec?.scenarios ?? []).reduce(
    (total, scenario) => total + (scenario.tests?.length ?? 0),
    0
  );
}

/** Print skipped tests as a terminal table (console.table). */
export function printLiveSkippedTable(entries) {
  if (entries.length === 0) return;

  console.log("");
  console.log(`Skipped from live QA JSON (${entries.length} test(s)):`);
  console.table(
    entries.map(entry => ({
      file: entry.sourceFile,
      scenario: entry.scenarioId,
      reason: entry.reason,
      title:
        entry.title.length > 72
          ? `${entry.title.slice(0, 69)}...`
          : entry.title,
    }))
  );
}
