import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { finalizeAgentRun, writeAgentQueryArtifact } from "./agent-output.mjs";
import { EnvironmentError } from "./errors.mjs";

/**
 * Offline adapter: canned but shape-correct stage output, no network and no
 * model. It is what makes a `demo` run and deterministic pipeline tests
 * possible. Point QA_FIXTURE_DIR at a directory of <stage>.json files to
 * replay your own recorded responses instead.
 */
export const FIXTURE_STAGES = ["abstract", "judge", "review"];

export function resolveFixtureStage({
  requiredKeys = ["status"],
  requiredKeyGroups = null,
} = {}) {
  const keys = new Set([
    ...(Array.isArray(requiredKeyGroups) ? requiredKeyGroups.flat() : []),
    ...(Array.isArray(requiredKeys) ? requiredKeys : [requiredKeys]),
  ]);
  if (keys.has("livePlan")) return "abstract";
  if (keys.has("criteria") || keys.has("overallReview")) return "review";
  return "judge";
}

/**
 * The judge plan renders one `### <scenario> — <test title>` heading per
 * planned check. Echoing those exact titles is what lets an offline run
 * exercise the real coverage and packet-digest gates instead of tripping them.
 */
export function plannedTitlesFromQuery(query) {
  const titles = [];
  for (const [, heading] of String(query ?? "").matchAll(/^###\s+(.+?)\s*$/gm)) {
    const parts = heading.split(/\s+—\s+/);
    const title = (parts.length > 1 ? parts.slice(1).join(" — ") : heading).trim();
    if (title && !titles.includes(title)) titles.push(title);
  }
  return titles;
}

export function packetDigestFromQuery(query) {
  return String(query ?? "").match(/packetSha256["`:\s]+`?(sha256:[0-9a-f]{64})/)?.[1] ?? null;
}

/** The abstract-ai prompt embeds its payload as JSON under a `## Payload` heading. */
export function specFromQuery(query) {
  const payload = String(query ?? "").split(/^## Payload\s*$/m)[1];
  if (!payload) return null;
  const start = payload.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(payload.slice(start))?.specDefinition ?? null;
  } catch {
    return null;
  }
}

/**
 * A plan that invents test titles is rejected by the abstract stage's validator
 * — correctly. So the offline fixture writes one block per real test it was
 * given, which is what lets `QA_AI_ADAPTER=fixture` drive any project's
 * pipeline and not just the bundled demo.
 */
function fixtureLivePlan(spec) {
  const blocks = [];
  for (const scenario of spec?.scenarios ?? []) {
    for (const test of scenario?.tests ?? []) {
      const readonly = test?.qaLivePolicy === "readonly";
      blocks.push(
        [
          `### ${scenario.scenarioId} — ${test.title}`,
          `Given: the ${scenario.scenarioId} account state on staging${scenario.alwaysRun ? " (always-run)" : ""}`,
          `When: the page is inspected under \`${test.qaLivePolicy ?? "readonly"}\``,
          "Then: the behaviour this test describes is observable to the user",
          `Never: the page shows an error state, or the described behaviour is absent after the page settles${readonly ? "\nmutations: 0" : ""}`,
        ].join("\n")
      );
    }
  }
  if (blocks.length) return blocks.join("\n\n");
  // No parseable payload (a caller exercising the contract, not a real stage):
  // still return the right shape, but name no test so nothing can be invented.
  return [
    "### Fixture — no spec payload in the prompt",
    "Given: the offline fixture adapter is selected (QA_AI_ADAPTER=fixture)",
    "When: the abstract-ai stage runs with no model",
    "Then: a shape-correct plan is returned",
    "Never: this plan is mistaken for a real abstraction of a real spec",
  ].join("\n");
}

function builtinFixture(stage, mode, query = "") {
  if (stage === "abstract") {
    const spec = specFromQuery(query);
    return {
      livePlan: fixtureLivePlan(spec),
      spec: spec ?? { scenarios: [] },
      changes: [],
    };
  }

  if (stage === "review") {
    const packetSha256 = packetDigestFromQuery(query);
    return {
      ...(packetSha256 ? { packetSha256 } : {}),
      overallReview: "flagged",
      summary:
        "Fixture adapter output — no reviewer read this judgment. Not a real review.",
      criteria: [
        {
          id: "sufficient-evidence",
          verdict: "concern",
          detail: "Fixture adapter: no evidence was examined.",
          affectedChecks: [],
        },
        {
          id: "not-overly-pedantic",
          verdict: "concern",
          detail: "Fixture adapter: no judgment was examined.",
          affectedChecks: [],
          pedanticExamples: [],
        },
      ],
      recommendations: [],
    };
  }

  const planned = plannedTitlesFromQuery(query);
  return {
    status: "manual_review",
    cause: "HARNESS_DEFECT",
    summary:
      "Fixture adapter output — nothing was browsed or verified. Not a real verdict.",
    checks: (planned.length ? planned : ["Fixture check"]).map(item => ({
      detail: `Fixture adapter ran in ${mode} mode without a model or browser, so nothing about this check was observed.`,
      item,
      result: "manual_review",
      confidence: "low",
      cause: "HARNESS_DEFECT",
      evidenceRefs: [],
    })),
    evidence: ["No live evidence: the fixture adapter never opened a page."],
    recommendedAction:
      "Set QA_AI_ADAPTER to a real backend (hermes, aside, exec) before trusting a verdict.",
  };
}

function readFixtureFile(stage) {
  const dir = process.env.QA_FIXTURE_DIR?.trim();
  if (!dir) return null;
  const root = resolve(dir);
  if (!existsSync(root)) {
    throw new EnvironmentError(`QA_FIXTURE_DIR does not exist: ${root}.`, {
      hint: "Point it at a directory of <stage>.json files, or unset it to use the built-in fixtures.",
    });
  }
  const path = join(root, `${stage}.json`);
  // Per-stage opt-in: recording one stage's response must not break the other
  // two, or the fixture directory is all-or-nothing and nobody can pin just the
  // judge payload they care about.
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export const FIXTURE_ADAPTER_CAPABILITIES = {
  auth: "credentials-in-prompt",
  supportsMaxTurns: false,
  supportsToolsetDisable: false,
  supportsVideo: false,
};

export function runFixture(
  query,
  _maxTurns,
  {
    paths = null,
    secrets = [],
    requiredKeys = ["status"],
    requiredKeyGroups = null,
    mode = "browse",
  } = {}
) {
  const stage = resolveFixtureStage({ requiredKeys, requiredKeyGroups });
  writeAgentQueryArtifact(paths, query, secrets);

  const stdout =
    readFixtureFile(stage) ??
    `${JSON.stringify(builtinFixture(stage, mode, query), null, 2)}\n`;

  // Same tail as a spawned adapter: raw artifact first, then key/shape checks.
  return finalizeAgentRun(
    { status: 0, stdout, stderr: "", error: undefined },
    {
      adapterLabel: `fixture (${stage})`,
      command: "fixture",
      paths,
      secrets,
      requiredKeys,
      requiredKeyGroups,
    }
  );
}
