import { describeLiveRunPolicy } from "./dashboard-spec-parser.mjs";

const POLICY_WHEN = {
  "executable-readonly": [
    "Inspect the live page (scroll if needed).",
    "Do not click anything that changes billing, subscription, or account data.",
  ],
  "executable-interaction": [
    "Perform the safe UI steps from the Playwright source below (clicks, inputs).",
    "After each step, observe the page.",
    "Close dialogs with Esc if needed — never click destructive Confirm / Submit.",
  ],
  "judgment-interaction-no-confirm": [
    "Open the UI flow only as far as safe on live staging.",
    "Stop before any confirm that would mutate real data.",
    "Dismiss with Esc.",
  ],
  "judgment-mock-api": [
    "View the page as a real user (CI used API mocks — do not call page.route or inject mocks on live).",
    "Compare what you see to the test intent below and in Playwright source.",
  ],
  "blocked-subscription-mutation": [
    "Do not run this test on live — it would change subscription or billing.",
  ],
  "blocked-auth-mock": [
    "Do not run this test on live — it requires a mocked unauthenticated flow.",
  ],
  "blocked-live-skip": ["Do not run this test on live — file has @qa-live-skip."],
  "blocked-unknown": ["Do not run this test on live — unknown policy."],
};

const POLICY_THEN_SKIP = {
  "blocked-subscription-mutation":
    "Record **skip** — would mutate subscription/billing on live.",
  "blocked-auth-mock": "Record **skip** — requires auth mock not available on live.",
  "blocked-live-skip": "Record **skip** — excluded by @qa-live-skip.",
  "blocked-unknown": "Record **skip** — policy not safe for live.",
};

function pageLabel(page) {
  return page
    .split("/")
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function formatLocator(locator) {
  if (!locator) return "the target element";

  if (locator.kind === "testId") {
    return `the element with data-testid="${locator.value}"`;
  }

  if (locator.kind === "text") {
    if (typeof locator.value === "object" && locator.value?.kind === "regex") {
      return `text matching /${locator.value.pattern}/`;
    }
    return `text "${locator.value}"`;
  }

  return "the target element";
}

function formatConstraint(constraint) {
  if (constraint.type === "numeric") {
    const role =
      constraint.role === "score"
        ? "a score (number with optional unit)"
        : constraint.role === "percent"
          ? "a percentage"
          : constraint.role === "currency"
            ? "a money or credit amount"
            : "a number";
    return role;
  }
  if (constraint.type === "format" && constraint.pattern === "iso-date") {
    return "a date (format may differ from CI mock)";
  }
  if (constraint.type === "presence") {
    return constraint.polarity === "must-not"
      ? "must not appear"
      : "must be present";
  }
  return null;
}

function formatExpectationThen(expectation) {
  const target = formatLocator(expectation.locator);

  if (expectation.type === "visible") {
    return `${target} is visible.`;
  }

  if (expectation.type === "notVisible") {
    return `${target} is not visible.`;
  }

  if (expectation.type === "containText" && expectation.expected) {
    const { expected } = expectation;

    if (expected.kind === "semantic") {
      const constraints = (expected.constraints ?? [])
        .map(formatConstraint)
        .filter(Boolean);
      const constraintText = constraints.length
        ? ` (${constraints.join("; ")})`
        : "";
      const mockNote = expectation.provenance?.originalLiteral
        ? ` CI used mock "${expectation.provenance.originalLiteral}" — any live value that matches the intent is OK.`
        : "";
      return `${target} shows: ${expected.intent ?? "the described intent"}${constraintText}.${mockNote}`.trim();
    }

    if (expected.kind === "literal") {
      return `${target} contains "${expected.value}".`;
    }

    if (expected.kind === "regex") {
      return `${target} matches /${expected.pattern}/ (live formatting may differ).`;
    }
  }

  return "The live page matches the intent in the Playwright source.";
}

function isBlockedPolicy(liveRunPolicy) {
  return (
    liveRunPolicy?.startsWith("blocked-") ?? false
  );
}

function buildGivenWhenThen(test, scenario) {
  const given = [
    "The tester is logged in and on the target page.",
    `Scenario context: **${scenario.label}** (\`${scenario.scenarioId}\`).`,
    `Playwright source: \`${scenario.sourceFile}\`.`,
  ];

  if (test.liveIntent) {
    given.push(`Intent: ${test.liveIntent}`);
  }

  if (test.fixtures && Object.keys(test.fixtures).length > 0) {
    const fixtureList = Object.entries(test.fixtures)
      .map(([name, path]) => `${name}=\`${path}\``)
      .join(", ");
    given.push(`Upload fixtures available: ${fixtureList}.`);
  }

  if (test.liveRunPolicy === "judgment-mock-api") {
    given.push("CI ran with mocked APIs; live staging uses real data.");
  }

  const when =
    POLICY_WHEN[test.liveRunPolicy] ??
    [
      describeLiveRunPolicy(test.liveRunPolicy) ??
        `Follow policy: ${test.liveRunPolicy}.`,
    ];

  const then = [];

  if (isBlockedPolicy(test.liveRunPolicy)) {
    then.push(
      POLICY_THEN_SKIP[test.liveRunPolicy] ??
        "Record **skip** with a short reason."
    );
    return { given, when, then };
  }

  if (test.expectations?.length > 0) {
    for (const expectation of test.expectations) {
      then.push(formatExpectationThen(expectation));
      if (expectation.liveNote) {
        then.push(`_Note:_ ${expectation.liveNote}`);
      }
    }
  } else if (test.liveRunPolicy === "executable-interaction") {
    then.push(
      "After the When steps, the page matches the assertions in the Playwright source below."
    );
  } else if (
    test.liveRunPolicy === "judgment-mock-api" ||
    test.liveRunPolicy === "judgment-interaction-no-confirm"
  ) {
    then.push(
      "The live UI matches the user-visible intent from the Playwright source (not necessarily the mocked CI values)."
    );
  }

  if (test.abstractReview) {
    then.push(
      "Verdict: **pass** if Then holds, **fail** if clearly broken, **manual_review** if ambiguous (prefer manual_review over fail)."
    );
  } else {
    then.push(
      "Verdict: **pass** if Then holds, **fail** if clearly broken, **manual_review** if ambiguous."
    );
  }

  return { given, when, then };
}

function renderGwtSection(label, items) {
  const lines = [`**${label}:**`, ""];
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  return lines;
}

function renderTestBlock(test, index, scenario) {
  const { given, when, then } = buildGivenWhenThen(test, scenario);

  const lines = [
    `### ${index}. ${test.title}`,
    "",
    `Verdict \`checks[].item\` must be exactly: \`${test.title}\``,
    "",
    ...renderGwtSection("Given", given),
    ...renderGwtSection("When", when),
    ...renderGwtSection("Then", then),
  ];

  return lines;
}

function renderScenarioBlock(scenario, { alwaysRun }) {
  const lines = [
    `## Scenario: ${scenario.label}`,
    "",
    `**Scenario ID:** \`${scenario.scenarioId}\` · **File:** \`${scenario.sourceFile}\``,
    "",
  ];

  const scenarioGiven = [
    alwaysRun
      ? "This scenario runs on **every** live judge pass (always-run), regardless of plan/status."
      : "Use this scenario when the live account matches this plan/subscription state.",
  ];

  lines.push(...renderGwtSection("Given (scenario)", scenarioGiven));

  if (scenario.liveSkip) {
    lines.push(
      "**When / Then:** skipped — entire file has @qa-live-skip.",
      ""
    );
    return lines;
  }

  let index = 1;
  for (const test of scenario.tests ?? []) {
    lines.push(...renderTestBlock(test, index, scenario));
    index += 1;
  }

  return lines;
}

function renderUploadFixtures(uploadFixtures) {
  if (!uploadFixtures) return [];

  const lines = ["## Upload files (for file-input tests)", ""];

  const defaults = uploadFixtures.defaults ?? {};
  if (Object.keys(defaults).length > 0) {
    lines.push("**Given — default uploads:**");
    for (const [name, absPath] of Object.entries(defaults)) {
      lines.push(`- ${name} → \`${absPath}\``);
    }
    lines.push("");
  }

  const byCheckId = uploadFixtures.byCheckId ?? {};
  if (Object.keys(byCheckId).length > 0) {
    lines.push("**Given — per-test uploads:**");
    for (const [checkId, files] of Object.entries(byCheckId)) {
      lines.push(`- \`${checkId}\`:`);
      for (const [name, absPath] of Object.entries(files)) {
        lines.push(`  - ${name} → \`${absPath}\``);
      }
    }
    lines.push("");
  }

  lines.push(
    "**Then:** if a file path is missing on disk, skip the upload and explain in the check detail.",
    ""
  );

  return lines;
}

function renderPlaywrightSources(specSourceFiles) {
  if (!specSourceFiles || Object.keys(specSourceFiles).length === 0) {
    return [];
  }

  const lines = [
    "## Playwright source (When steps & mock context)",
    "",
    "Use these for **When** on interaction tests and to understand CI mocks.",
    "",
  ];

  for (const [fileName, content] of Object.entries(specSourceFiles).sort()) {
    lines.push(`### ${fileName}`, "", "```typescript", content.trimEnd(), "```", "");
  }

  return lines;
}

/**
 * Human-readable QA plan for Hermes judge (Given / When / Then, no JSON spec).
 */
export function renderJudgeHermesDocument({
  page,
  spec,
  stagingLogin = null,
  accountContext = {},
  alwaysRunScenarioIds = [],
  uploadFixtures = null,
  specSourceFiles = {},
  title = null,
  includeSession = true,
  preamble = null,
}) {
  const label = pageLabel(page);
  const alwaysRunSet = new Set(alwaysRunScenarioIds);

  const lines = [
    `# ${title ?? `QA test plan — ${label} (live staging)`}`,
    "",
    preamble ??
      "Each test is written as **Given → When → Then**. Follow that order on live staging.",
    "",
  ];

  if (includeSession && stagingLogin) {
    lines.push(
      "## Session setup",
      "",
      "**Given:**",
      "",
      `- Login URL: ${stagingLogin.loginUrl}`,
      `- Signed in as: ${stagingLogin.email}`,
      `- Target page: ${stagingLogin.targetUrl}`,
      ""
    );
  }

  if (
    accountContext.expectedPlan ||
    accountContext.expectedSubscriptionStatus ||
    accountContext.accountNotes
  ) {
    lines.push("**Given (account hints, optional):**", "");
    if (accountContext.expectedPlan) {
      lines.push(`- Expected plan: **${accountContext.expectedPlan}**`);
    }
    if (accountContext.expectedSubscriptionStatus) {
      lines.push(
        `- Expected subscription status: **${accountContext.expectedSubscriptionStatus}**`
      );
    }
    if (accountContext.accountNotes) {
      lines.push(`- Notes: ${accountContext.accountNotes}`);
    }
    lines.push("");
  }

  lines.push(
    "## How to use this plan",
    "",
    "**Given:** preconditions (account, page, fixtures).",
    "**When:** what you do on live (or “do not run” for blocked tests).",
    "**Then:** what must be true — or record skip / manual_review / fail in your JSON verdict.",
    "",
    "1. Pick **one** scenario that matches the live account.",
    "2. Run every test in that scenario (each G/W/T block).",
    "3. Also run scenarios marked **always-run**.",
    "4. On **Then**: semantic expectations match **intent**, not exact CI mock numbers.",
    ""
  );

  if (alwaysRunScenarioIds.length > 0) {
    lines.push(
      "## Always-run scenario IDs",
      "",
      ...alwaysRunScenarioIds.map(id => `- \`${id}\``),
      ""
    );
  }

  if (spec.abstraction?.stage) {
    lines.push(
      `_Live abstraction: ${spec.abstraction.stage} (rules ${spec.abstraction.rulesVersion ?? "n/a"})._`,
      ""
    );
  }

  lines.push("---", "", "## Scenarios & tests", "");

  for (const scenario of spec.scenarios ?? []) {
    lines.push(
      ...renderScenarioBlock(scenario, {
        alwaysRun: alwaysRunSet.has(scenario.scenarioId),
      })
    );
  }

  lines.push(...renderUploadFixtures(uploadFixtures));
  lines.push(...renderPlaywrightSources(specSourceFiles));

  return `${lines.join("\n")}\n`;
}

/**
 * Friendlier markdown for saved spec artifacts (spec / spec-live .md files).
 */
export function renderFriendlyQaSpecMarkdown(spec, page, { titleSuffix = "" } = {}) {
  return renderJudgeHermesDocument({
    page,
    spec,
    includeSession: false,
    title: `${pageLabel(page)} QA spec${titleSuffix}`,
    preamble: [
      `Generated at: ${spec.generatedAt}`,
      "",
      "Given / When / Then format from Playwright specs. `judge` sends the same structure to Hermes (not raw JSON).",
    ].join("\n"),
    alwaysRunScenarioIds: (spec.scenarios ?? [])
      .filter(s => s.alwaysRun)
      .map(s => s.scenarioId),
    uploadFixtures: null,
    specSourceFiles: {},
  });
}
