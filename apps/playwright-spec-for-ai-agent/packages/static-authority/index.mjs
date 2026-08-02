import { PLAYWRIGHT_STATIC_MANIFEST_VERSION, canonicalHash } from "../contracts/index.mjs";
import { parsePlaywrightSource } from "../../scripts/playwright-spec-parser.mjs";

const POLICY_BY_LIVE_RUN = Object.freeze({
  "executable-readonly": allowedPolicy({ click: "NONE", type: "NONE" }),
  "executable-interaction": allowedPolicy({ click: "SAFE_ONLY", type: "NON_SECRET" }),
  "judgment-mock-api": allowedPolicy({ click: "NONE", type: "NONE" }),
  "judgment-interaction-no-confirm": allowedPolicy({ click: "SAFE_ONLY", type: "NON_SECRET" }),
});

export { PLAYWRIGHT_STATIC_MANIFEST_VERSION };

export function extractStaticAuthority({ source, sourcePath } = {}) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  if (typeof sourcePath !== "string" || sourcePath.length === 0) throw new TypeError("sourcePath must be a non-empty string");
  const parsed = parsePlaywrightSource(sourcePath, source);
  if (!parsed.scenario || parsed.scenario.tests.length !== parsed.blocks.length) throw new TypeError("static authority requires an annotated Playwright scenario");
  const scenario = parsed.scenario;
  return {
    schemaVersion: PLAYWRIGHT_STATIC_MANIFEST_VERSION,
    source: { path: sourcePath, contentHash: canonicalHash(source) },
    scenario: {
      id: scenario.scenarioId,
      label: scenario.label,
      ...(scenario.page ? { page: scenario.page } : {}),
      liveSkip: scenario.liveSkip,
      alwaysRun: scenario.alwaysRun,
    },
    tests: scenario.tests.map((test, index) => ({
      testId: stableId(sourcePath, scenario.scenarioId, index, parsed.blocks[index].index),
      title: test.title,
      checkId: test.checkId,
      range: { start: parsed.blocks[index].index, end: parsed.blocks[index].endIndex },
      livePolicyAnnotation: test.livePolicyAnnotation ?? null,
      liveRunPolicy: test.liveRunPolicy,
      policy: structuredClone(POLICY_BY_LIVE_RUN[test.liveRunPolicy] ?? blockedPolicy()),
      ...(test.modifier ? { modifier: test.modifier } : {}),
      ...(test.fixtures ? { fixtures: structuredClone(test.fixtures) } : {}),
    })),
  };
}

function allowedPolicy(overrides) {
  return Object.freeze({
    navigation: "ALLOWED",
    readDom: true,
    readNetwork: false,
    click: "SAFE_ONLY",
    type: "NON_SECRET",
    upload: false,
    submit: false,
    destructiveMutation: false,
    confirmation: "DENY",
    secrets: "RUNTIME_INJECTED",
    ...overrides,
  });
}

function blockedPolicy() {
  return {
    navigation: "BLOCKED",
    readDom: false,
    readNetwork: false,
    click: "NONE",
    type: "NONE",
    upload: false,
    submit: false,
    destructiveMutation: false,
    confirmation: "DENY",
    secrets: "RUNTIME_INJECTED",
  };
}

function stableId(...parts) {
  const text = parts.join(":");
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "test";
  return `${slug}-${canonicalHash(text).slice("sha256:".length, "sha256:".length + 12)}`;
}
