// O13 characterization corpus: fast-check inputs with fixed seeds for every refactored entry point.
// `computeCorpus()` runs the inputs on whatever code is checked out. baseline.json was recorded from
// the unmodified baseline commit 9b2031c by `record.mjs`; the vitest file compares the two.
//
// Fix domains (Q10, Q11, Q15, Q17) are kept out of the inputs, never out of the comparison:
//   Q10  worstExitCode: at most one unrecognised exit code per input.
//   Q11  ledger: no cut line and no removed entry; edit and trailing-drop tampering stay in.
//   Q15  normalizer: the agent claim is pass, fail or manual_review (no skip, missing or other string).
//   Q17  normalizer: the summary is compared only for inputs where no floor can fire (`summaryComparable`).
import { mkdtempSync, appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fc from "fast-check";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const load = (file) => import(pathToFileURL(join(scripts, file)).href);

export const SEEDS = {
  normalizer: 20261008,
  verdictParts: 20261009,
  hash: 20261010,
  ledger: 20261011,
  specReader: 20261012,
  exitFold: 20261013,
  judgeStage: 20261014,
};
export const RUNS = {
  normalizer: 200,
  verdictParts: 100,
  hash: 100,
  ledger: 80,
  specReader: 100,
  exitFold: 150,
  judgeStage: 120,
};

const sample = (arbitrary, entry) => fc.sample(arbitrary, { seed: SEEDS[entry], numRuns: RUNS[entry] });

function attempt(fn) {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: `${error?.constructor?.name}: ${error?.message}` };
  }
}

// ── normalizeBrowseDecision, pairPlannedChecks, buildCoverage, normalizeCause ──────────────────────
const reportArb = fc.record({
  addressed: fc.boolean(),
  result: fc.constantFrom("pass", "fail", "skip", "manual_review", "garbled"),
  confidence: fc.constantFrom(undefined, "low", "medium", "high"),
  cited: fc.boolean(),
  cause: fc.constantFrom(undefined, "NONE", "PRODUCT_DEFECT", "SPEC_GAP", "ENVIRONMENT_DEFECT", "HARNESS_DEFECT", "nonsense"),
  duplicate: fc.boolean(),
});
const mixedNormalizerArb = fc.record({
  planStyle: fc.constantFrom("objects", "strings"),
  planSize: fc.integer({ min: 0, max: 4 }),
  claim: fc.constantFrom("pass", "fail", "manual_review"),
  summary: fc.constantFrom("Looks fine.", "Hermes QA judgment completed.", "Mixed results."),
  declaredCause: fc.constantFrom(undefined, "NONE", "PRODUCT_DEFECT", "SPEC_GAP", "ENVIRONMENT_DEFECT", "HARNESS_DEFECT", "nonsense"),
  reports: fc.array(reportArb, { minLength: 4, maxLength: 4 }),
  extra: fc.boolean(),
  violations: fc.constantFrom("none", "off-origin", "mutation", "unknown-kind"),
});

// A third of the scenarios are the all-clean pass so the Q17-free summary comparison has real inputs.
const cleanReportArb = fc.record({
  addressed: fc.constant(true),
  result: fc.constant("pass"),
  confidence: fc.constantFrom(undefined, "medium", "high"),
  cited: fc.constant(true),
  cause: fc.constantFrom(undefined, "NONE"),
  duplicate: fc.constant(false),
});
const cleanNormalizerArb = fc.record({
  planStyle: fc.constantFrom("objects", "strings"),
  planSize: fc.integer({ min: 1, max: 4 }),
  claim: fc.constantFrom("pass", "fail", "manual_review"),
  summary: fc.constantFrom("Looks fine.", "Hermes QA judgment completed.", "Mixed results."),
  declaredCause: fc.constantFrom(undefined, "NONE", "PRODUCT_DEFECT", "SPEC_GAP", "ENVIRONMENT_DEFECT", "HARNESS_DEFECT", "nonsense"),
  reports: fc.array(cleanReportArb, { minLength: 4, maxLength: 4 }),
  extra: fc.constant(false),
  violations: fc.constant("none"),
});
const normalizerArb = fc.oneof({ weight: 2, arbitrary: mixedNormalizerArb }, { weight: 1, arbitrary: cleanNormalizerArb });

function buildNormalizerInput(scenario) {
  const plannedChecks = Array.from({ length: scenario.planSize }, (_, index) =>
    scenario.planStyle === "objects"
      ? { checkId: `C${index}`, item: `Planned check ${index} of the page` }
      : `Planned check ${index} of the page`,
  );
  const checks = [];
  scenario.reports.slice(0, scenario.planSize).forEach((report, index) => {
    if (!report.addressed) return;
    const row = {
      ...(scenario.planStyle === "objects" ? { checkId: `C${index}` } : {}),
      item: `Planned check ${index} of the page`,
      result: report.result,
      detail: `Observed state ${index}`,
      evidenceRefs: report.cited ? [`shot-${index}.png`] : [],
      ...(report.confidence ? { confidence: report.confidence } : {}),
      ...(report.cause ? { cause: report.cause } : {}),
    };
    checks.push(row);
    if (report.duplicate) checks.push({ ...row });
  });
  if (scenario.extra) {
    checks.push({ checkId: "X9", item: "Unplanned extra report row", result: "pass", detail: "Extra", evidenceRefs: ["shot-9.png"] });
  }
  const violationKinds = {
    none: [],
    "off-origin": [{ kind: "off-origin-navigation", detail: "https://elsewhere.test/" }],
    mutation: [{ kind: "unexpected-mutation", detail: "POST /api/x" }],
    "unknown-kind": [{ kind: "something-else", detail: "d" }],
  };
  return {
    raw: {
      status: scenario.claim,
      summary: scenario.summary,
      ...(scenario.declaredCause ? { cause: scenario.declaredCause } : {}),
      checks,
    },
    options: {
      plannedChecks,
      runnerEvidence: { screenshots: [0, 1, 2, 3, 4, 9].map((index) => `shot-${index}.png`) },
      violations: violationKinds[scenario.violations],
    },
  };
}

// Q17: the summary is contracted only where no floor can fire — every planned check reported once,
// passing with verified evidence at a confidence other than low, no extra report and no violation.
function summaryComparable(scenario) {
  if (scenario.planSize < 1 || scenario.extra || scenario.violations !== "none") return false;
  return scenario.reports
    .slice(0, scenario.planSize)
    .every((report) => report.addressed && !report.duplicate && report.result === "pass" && report.cited && report.confidence !== "low");
}

async function normalizerCases() {
  const { normalizeBrowseDecision } = await load("judge-verdict.mjs");
  return sample(normalizerArb, "normalizer").map((scenario) => {
    const { raw, options } = buildNormalizerInput(scenario);
    const output = attempt(() =>
      normalizeBrowseDecision(structuredClone(raw), {
        ...structuredClone(options),
        fileExists: (path) => /^shot-/.test(path),
        readText: () => "",
      }),
    );
    return { input: { raw, options }, summaryComparable: summaryComparable(scenario), output };
  });
}

async function verdictPartCases() {
  const { pairPlannedChecks, buildCoverage, normalizeCause, isReadOnlyPlan, analyzeHarViolations } = await load("judge-verdict.mjs");
  const arb = fc.record({ normalizer: normalizerArb, cause: fc.constantFrom(undefined, "", "product_defect", "SPEC_GAP", "NONE", "x"), result: fc.constantFrom("pass", "skip", "fail", "manual_review"), policies: fc.array(fc.constantFrom("executable-readonly", "executable-interaction", "blocked-auth-mock", undefined), { maxLength: 3 }), harUrl: fc.constantFrom("https://app.test/a", "https://elsewhere.test/b"), harMethod: fc.constantFrom("GET", "POST", "DELETE") });
  return sample(arb, "verdictParts").map((scenario) => {
    const { raw, options } = buildNormalizerInput(scenario.normalizer);
    const har = { log: { entries: [{ request: { method: scenario.harMethod, url: scenario.harUrl } }] } };
    const input = { plannedChecks: options.plannedChecks, checks: raw.checks, cause: scenario.cause, result: scenario.result, policies: scenario.policies, har };
    const pairs = attempt(() => {
      const paired = pairPlannedChecks(options.plannedChecks, raw.checks);
      return { ...paired, pairs: [...paired.pairs.entries()] };
    });
    return {
      input,
      output: {
        pairs,
        coverage: attempt(() => buildCoverage(options.plannedChecks, raw.checks)),
        cause: attempt(() => normalizeCause(scenario.cause, { result: scenario.result })),
        readOnly: attempt(() => isReadOnlyPlan(scenario.policies.map((liveRunPolicy) => ({ liveRunPolicy })))),
        har: attempt(() => analyzeHarViolations(har, { allowedOrigins: ["https://app.test"], readOnly: true })),
      },
    };
  });
}

// ── spec-hash ────────────────────────────────────────────────────────────────────────────────────
async function hashCases() {
  const hash = await load("spec-hash.mjs");
  const arb = fc.record({
    value: fc.jsonValue(),
    text: fc.string({ maxLength: 40 }),
    stamped: fc.boolean(),
    expected: fc.constantFrom(null, "sha256:aaa", "sha256:bbb"),
    actual: fc.constantFrom("sha256:aaa", "sha256:ccc"),
    producer: fc.constantFrom("abstract-ai", "judge"),
    consumer: fc.constantFrom("judge", "review"),
    fileText: fc.string({ maxLength: 40 }),
  });
  const dir = mkdtempSync(join(tmpdir(), "characterize-hash-"));
  try {
    return sample(arb, "hash").map((scenario, index) => {
      const definition = scenario.stamped
        ? { scenarios: [scenario.value], sourceHash: "sha256:stamp", generatedAt: "t", schemaVersion: 3, agentMeta: { m: 1 }, inputHash: "i" }
        : { scenarios: [scenario.value] };
      const file = join(dir, `file-${index}.txt`);
      writeFileSync(file, scenario.fileText);
      return {
        input: { ...scenario, definition },
        output: {
          canonical: attempt(() => hash.canonicalize(scenario.value)),
          json: attempt(() => hash.hashJson(scenario.value)),
          text: attempt(() => hash.hashText(scenario.text)),
          definition: attempt(() => hash.hashSpecDefinition(definition)),
          verify: attempt(() => hash.verifySourceHash({ sourceHash: scenario.expected }, scenario.actual)),
          mismatch: attempt(() => hash.describeHashMismatch(scenario)),
          // hashFile gains an injected `{ readFile }` in the refactor; the extra argument is ignored at baseline.
          file: attempt(() => hash.hashFile(file, { readFile: (path) => readFileSync(path, "utf8") })),
        },
      };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── qa-run-ledger ────────────────────────────────────────────────────────────────────────────────
async function ledgerCases() {
  const ledger = await load("qa-run-ledger.mjs");
  const arb = fc.record({
    events: fc.array(fc.record({ kind: fc.constantFrom("judge-start", "judge-retry", "judge-verdict"), n: fc.integer({ min: 0, max: 9 }) }), { maxLength: 4 }),
    tamper: fc.constantFrom("none", "edit-first", "edit-last", "drop-last"),
  });
  const dir = mkdtempSync(join(tmpdir(), "characterize-ledger-"));
  // The refactor injects `io`; the extra arguments are ignored at baseline.
  const io = {
    readFile: (path) => readFileSync(path, "utf8"),
    appendFile: (path, data) => appendFileSync(path, data),
    exists: (path) => existsSync(path),
  };
  try {
    return sample(arb, "ledger").map((scenario, index) => {
      const path = join(dir, `ledger-${index}.jsonl`);
      const appended = scenario.events.map((event, position) =>
        attempt(() => ledger.appendRunEvent(path, { runId: `run-${position}`, ...event }, { now: `2026-01-01T00:00:0${position}.000Z`, io })),
      );
      if (existsSync(path)) {
        const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
        if (scenario.tamper === "edit-first") lines[0] = lines[0].replace('"runId":"run-0"', '"runId":"run-X"');
        if (scenario.tamper === "edit-last") lines[lines.length - 1] = lines.at(-1).replace(`"runId":"run-${lines.length - 1}"`, '"runId":"run-X"');
        if (scenario.tamper === "drop-last") lines.pop();
        writeFileSync(path, lines.length ? `${lines.join("\n")}\n` : "");
      }
      return {
        input: scenario,
        output: {
          appended,
          verify: attempt(() => ledger.verifyLedger(path, { io })),
          read: attempt(() => ledger.readLedger(path, { io })),
          last: attempt(() => ledger.lastEntry(path, { io })),
          retry: attempt(() => ledger.findLast(path, (entry) => entry.kind === "judge-retry", { io })),
        },
      };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── spec-annotation-reader ───────────────────────────────────────────────────────────────────────
async function specReaderCases() {
  const reader = await load("spec-annotation-reader.mjs");
  const testArb = fc.record({
    title: fc.constantFrom("renders the header", "to be: shows total", "submits the form"),
    policy: fc.constantFrom(undefined, "readonly", "safe-interaction", "safe-interaction-no-confirm", "mock-judgment", "subscription-mutation", "auth-mock", "skip", "unknown-policy"),
    fixture: fc.boolean(),
  });
  const arb = fc.record({
    page: fc.constantFrom(undefined, "dashboard", "pricing"),
    scenario: fc.constantFrom(undefined, "ACTIVE", "TRIAL"),
    liveSkip: fc.boolean(),
    alwaysRun: fc.boolean(),
    describe: fc.constantFrom(undefined, "Billing page"),
    tests: fc.array(testArb, { minLength: 1, maxLength: 3 }),
  });
  return sample(arb, "specReader").map((scenario) => {
    const header = [
      scenario.page && `// @qa-page: ${scenario.page}`,
      scenario.scenario && `// @qa-scenario: ${scenario.scenario}`,
      scenario.liveSkip && "// @qa-live-skip: true",
      scenario.alwaysRun && "// @qa-always-run: true",
    ].filter(Boolean);
    const tests = scenario.tests.map((spec) =>
      [
        spec.policy && `  // @qa-live-policy: ${spec.policy}`,
        spec.fixture && "  // @qa-fixture: avatar=tests/fixtures/avatar.png",
        `  test("${spec.title}", async ({ page }) => {`,
        "    await page.goto('/');",
        "  });",
      ].filter(Boolean).join("\n"),
    );
    const source = scenario.describe
      ? `${header.join("\n")}\ntest.describe("${scenario.describe}", () => {\n${tests.join("\n")}\n});\n`
      : `${header.join("\n")}\n${tests.join("\n")}\n`;
    const annotations = attempt(() => reader.parseAnnotations(source));
    // parseSpecFile gains `{ livePolicyOverrides }` in the refactor; the extra argument is ignored at baseline.
    const parsed = attempt(() => reader.parseSpecFile("a.spec.ts", source, { livePolicyOverrides: {} }));
    const spec = parsed.value ?? null;
    return {
      input: { source },
      output: {
        annotations,
        parsed,
        checklist: spec ? attempt(() => reader.buildBrowseChecklist(spec)) : null,
        selected: spec ? attempt(() => reader.selectScenariosForLiveRun({ scenarios: [spec] }, scenario.scenario ?? "ACTIVE")) : null,
        summary: spec ? attempt(() => reader.formatScenarioCoverageSummary(spec, spec.scenarioId)) : null,
      },
    };
  });
}

// ── nightly exit fold ────────────────────────────────────────────────────────────────────────────
async function exitFoldCases() {
  const { worstExitCode } = await load("run-page-qa-nightly.mjs");
  // Q10: at most one unrecognised code per input, so the fold's order dependence stays outside the corpus.
  const arb = fc.record({
    known: fc.array(fc.constantFrom(0, 1, 2, 3, 4), { maxLength: 6 }),
    oddity: fc.constantFrom(undefined, 5, 6, 137, 255),
    position: fc.integer({ min: 0, max: 6 }),
  });
  return sample(arb, "exitFold").map((scenario) => {
    const codes = [...scenario.known];
    if (scenario.oddity !== undefined) codes.splice(Math.min(scenario.position, codes.length), 0, scenario.oddity);
    return { input: { codes }, output: attempt(() => worstExitCode(codes)) };
  });
}

// ── judge stage pure decisions (not exported at baseline; moved to judge-plan.mjs / judgment.mjs) ─────
async function judgeStageFunction(modules, name) {
  for (const file of modules) {
    const exported = (await load(file).catch(() => ({})))[name];
    if (typeof exported === "function") return exported;
  }
  // Baseline: the function is module-private in run-hermes-page-judge.mjs. Evaluate its own source text.
  const source = readFileSync(join(scripts, "run-hermes-page-judge.mjs"), "utf8");
  const match = source.match(new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, "m"));
  if (!match) throw new Error(`${name} is neither exported by ${modules.join(", ")} nor present in run-hermes-page-judge.mjs`);
  const errors = await load("errors.mjs");
  return new Function("EXIT_OK", "EXIT_VERDICT_FAIL", `${match[0]}\nreturn ${name};`)(errors.EXIT_OK, errors.EXIT_VERDICT_FAIL);
}

async function judgeStageCases() {
  const decideAuthMode = await judgeStageFunction(["judge-plan.mjs"], "decideAuthMode");
  const verdictExitCode = await judgeStageFunction(["judgment.mjs"], "verdictExitCode");
  const arb = fc.record({
    auth: fc.constantFrom("cdp-attach", "self-prelogin", "credentials-in-prompt"),
    credentialsInPrompt: fc.boolean(),
    cloud: fc.boolean(),
    attachUrl: fc.constantFrom(undefined, "", "http://127.0.0.1:9222"),
    sessionProfile: fc.boolean(),
    seedable: fc.boolean(),
    status: fc.constantFrom("pass", "manual_review", "fail"),
    failOn: fc.constantFrom("fail", "manual_review", "never"),
  });
  return sample(arb, "judgeStage").map((scenario) => ({
    input: scenario,
    output: {
      auth: attempt(() => decideAuthMode(scenario)),
      exit: attempt(() => verdictExitCode(scenario.status, scenario.failOn)),
    },
  }));
}

export async function computeCorpus() {
  const cases = {
    normalizer: await normalizerCases(),
    verdictParts: await verdictPartCases(),
    hash: await hashCases(),
    ledger: await ledgerCases(),
    specReader: await specReaderCases(),
    exitFold: await exitFoldCases(),
    judgeStage: await judgeStageCases(),
  };
  // Round-trip through JSON so -0, undefined and Map conversions compare the way the fixture stores them.
  return JSON.parse(JSON.stringify({ seeds: SEEDS, runs: RUNS, cases }));
}
