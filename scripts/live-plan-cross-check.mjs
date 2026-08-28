/**
 * Cross-check the agent's Given/When/Then plan against what the parser read
 * from the same Playwright source.
 *
 * The two derivations are independent: the parser reads the assertions
 * mechanically, the agent reads the whole body as prose. Neither is trusted
 * over the other. What the disagreement buys is the only automatic signal that
 * one of them is wrong — a plan that never names the element the test asserts
 * on is either describing a different check or describing nothing falsifiable.
 *
 * The check is deliberately weak in one direction: it never fails a plan for
 * saying *more* than the parser read, because the parser's coverage is partial
 * by construction. It only reports what the parser positively read and the
 * plan does not mention.
 */
import { isLiveSkippedTest } from "./spec-live-filter.mjs";

const HEADING_LINE = /^#{1,6}\s+(.+?)\s*$/;

/**
 * Only a `data-testid` is a stable contract between the spec and the page. Every
 * other locator kind identifies an element by its rendered content — visible
 * text, an accessible name, a label, a placeholder — and that content is exactly
 * what the abstraction prompt tells the agent to generalize, because live
 * staging does not serve the mock data the test pins. Demanding those literals
 * back would contradict the instruction this oracle is checking and fire on
 * every well-written plan.
 */
const STABLE_LOCATOR_KINDS = new Set(["testId"]);

/** The observable name a reader would have to write down to check this. */
function locatorNeedle(locator) {
  if (!locator || !STABLE_LOCATOR_KINDS.has(locator.kind)) return null;
  const value = typeof locator.value === "string" ? locator.value.trim() : "";
  return value || null;
}

function planBlocks(livePlan) {
  const blocks = [];
  let current = null;

  for (const line of String(livePlan).split("\n")) {
    const heading = HEADING_LINE.exec(line);
    if (heading) {
      current = { heading: heading[1].trim(), body: [] };
      blocks.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }

  return blocks;
}

function findBlock(blocks, scenarioId, title) {
  return (
    blocks.find(
      block =>
        block.heading.includes(title) &&
        (!scenarioId || block.heading.includes(scenarioId))
    ) ?? blocks.find(block => block.heading.includes(title)) ?? null
  );
}

/**
 * @returns {{ checked: number, disagreements: Array<{
 *   scenarioId: string|null, title: string, checkId: string|null,
 *   kind: "locator-unmentioned", missing: string[] }> }}
 */
export function crossCheckLivePlan(spec, livePlan) {
  const plan = typeof livePlan === "string" ? livePlan.trim() : "";
  if (!plan) return { checked: 0, disagreements: [] };

  const blocks = planBlocks(plan);
  const disagreements = [];
  let checked = 0;

  for (const scenario of spec?.scenarios ?? []) {
    if (scenario.liveSkip) continue;

    for (const test of scenario.tests ?? []) {
      if (isLiveSkippedTest(test)) continue;
      // An incomplete read is not a second opinion: the parser skipped
      // assertions it cannot name, so its silence means nothing.
      if (test.parserIntegrity === "incomplete") continue;

      const needles = [
        ...new Set(
          (test.expectations ?? [])
            .map(expectation => locatorNeedle(expectation.locator))
            .filter(Boolean)
        ),
      ];
      if (needles.length === 0) continue;

      checked += 1;

      const block = findBlock(blocks, scenario.scenarioId, test.title);
      // A missing block is the coverage repair's business, not this check's.
      if (!block) continue;

      const body = block.body.join("\n");
      const missing = needles.filter(needle => !body.includes(needle));
      if (missing.length === 0) continue;

      disagreements.push({
        scenarioId: scenario.scenarioId ?? null,
        title: test.title,
        checkId: test.checkId ?? null,
        kind: "locator-unmentioned",
        missing,
      });
    }
  }

  return { checked, disagreements };
}
