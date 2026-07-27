const POLICY_WHEN = {
  "executable-readonly": "Inspect page (no mutating clicks).",
  "executable-interaction": "Safe UI steps per Playwright source; Esc for dialogs.",
  "judgment-interaction-no-confirm": "Open flow; stop before confirm; Esc.",
  "judgment-mock-api": "View page; judge by intent (mock-api).",
  "blocked-subscription-mutation": "Skip on live.",
  "blocked-auth-mock": "Skip on live.",
  "blocked-live-skip": "Skip on live.",
  "blocked-unknown": "Skip on live.",
};

export function pageLabelFromSlug(page) {
  return page
    .split("/")
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function pageLabel(page) {
  return pageLabelFromSlug(page);
}

function formatLocator(locator) {
  if (!locator) return "target";

  if (locator.kind === "testId") {
    return `[data-testid="${locator.value}"]`;
  }

  if (locator.kind === "text") {
    if (typeof locator.value === "object" && locator.value?.kind === "regex") {
      return `text:/${locator.value.pattern}/`;
    }
    return `text:"${locator.value}"`;
  }

  if (locator.kind === "role") {
    return `role:${locator.role}${locator.name ? `[name=${JSON.stringify(locator.name)}]` : ""}`;
  }

  if (locator.kind === "chain") {
    const operations = (locator.operations ?? []).map(operation => operation.method).join(" → ");
    return `${formatLocator(locator.root)}${operations ? ` → ${operations}` : ""}`;
  }

  if (locator.value !== undefined) return `${locator.kind}:${JSON.stringify(locator.value)}`;

  return "target";
}

function formatConstraint(constraint) {
  if (constraint.type === "numeric") {
    if (constraint.role === "score") return "score";
    if (constraint.role === "percent") return "percent";
    if (constraint.role === "currency") return "amount";
    return "number";
  }
  if (constraint.type === "format" && constraint.pattern === "iso-date") {
    return "date";
  }
  if (constraint.type === "presence") {
    return constraint.polarity === "must-not" ? "absent" : "present";
  }
  return null;
}

function formatExpectationThen(expectation) {
  const target = formatLocator(expectation.locator);

  if (expectation.type === "visible") {
    return `${target} visible`;
  }

  if (expectation.type === "notVisible") {
    return `${target} hidden`;
  }

  if (expectation.type === "containText" && expectation.expected) {
    const { expected } = expectation;
    const mock =
      expectation.provenance?.originalLiteral != null
        ? `; mock:${JSON.stringify(expectation.provenance.originalLiteral)}`
        : "";

    if (expected.kind === "semantic") {
      const constraints = (expected.constraints ?? [])
        .map(formatConstraint)
        .filter(Boolean);
      const c = constraints.length ? ` [${constraints.join(",")}]` : "";
      return `${target}: ${expected.intent ?? "intent"}${c}${mock}`;
    }

    if (expected.kind === "literal") {
      return `${target}: "${expected.value}"`;
    }

    if (expected.kind === "regex") {
      return `${target}: /${expected.pattern}/`;
    }
  }

  if (expectation.expected) {
    if (expectation.expected.kind === "literal") {
      return `${target} ${expectation.type}: ${JSON.stringify(expectation.expected.value)}`;
    }
    if (expectation.expected.kind === "regex") {
      return `${target} ${expectation.type}: /${expectation.expected.pattern}/${expectation.expected.flags ?? ""}`;
    }
    if (expectation.expected.kind === "array") {
      return `${target} ${expectation.type}: ${expectation.expected.value.map(value => value.kind === "regex" ? `/${value.pattern}/${value.flags ?? ""}` : JSON.stringify(value.value)).join(", ")}`;
    }
  }

  if (expectation.type) return `${target} ${expectation.type}`;

  return "Matches Playwright assertions";
}

function formatActionWhen(action) {
  const args = (action.arguments ?? []).map(argument => {
    if (argument.kind === "literal") return JSON.stringify(argument.value);
    if (argument.kind === "regex") return `/${argument.pattern}/${argument.flags ?? ""}`;
    return argument.source ?? argument.kind;
  });
  return `${action.type} ${formatLocator(action.target)}${args.length ? ` with ${args.join(", ")}` : ""}`;
}

function isBlockedPolicy(liveRunPolicy) {
  return liveRunPolicy?.startsWith("blocked-") ?? false;
}

function buildGivenWhenThen(test, scenario) {
  const given = [
    `\`${scenario.scenarioId}\` · \`${scenario.sourceFile}\``,
  ];

  if (test.liveIntent) {
    given.push(test.liveIntent);
  }

  if (test.fixtures && Object.keys(test.fixtures).length > 0) {
    given.push(
      Object.entries(test.fixtures)
        .map(([name, path]) => `${name}=${path}`)
        .join(", ")
    );
  }

  if (test.abstractReview) {
    given.push("abstractReview");
  }

  const when = [POLICY_WHEN[test.liveRunPolicy] ?? test.liveRunPolicy];

  if (isBlockedPolicy(test.liveRunPolicy)) {
    return { given, when, then: ["skip"] };
  }


  for (const action of test.actions ?? []) {
    when.push(formatActionWhen(action));
  }

  const then = [];

  if (test.expectations?.length > 0) {
    for (const expectation of test.expectations) {
      then.push(formatExpectationThen(expectation));
    }
  } else if (test.liveRunPolicy === "executable-interaction") {
    then.push("Matches Playwright assertions");
  } else if (test.liveRunPolicy === "judgment-interaction-no-confirm") {
    then.push("UI matches intent up to safe point");
  } else if (test.liveRunPolicy === "judgment-mock-api") {
    then.push("UI matches intent");
  }

  return { given, when, then };
}

function renderGwtSection(label, items) {
  const lines = [`**${label}:**`];
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  return lines;
}

function renderTestBlock(test, index, scenario) {
  const { given, when, then } = buildGivenWhenThen(test, scenario);

  return [
    `### ${index}. ${test.title}`,
    "",
    ...renderGwtSection("Given", given),
    ...renderGwtSection("When", when),
    ...renderGwtSection("Then", then),
  ];
}

function renderScenarioBlock(scenario, { alwaysRun }) {
  const lines = [
    `## ${scenario.label}`,
    "",
    `id:\`${scenario.scenarioId}\` file:\`${scenario.sourceFile}\`${alwaysRun ? " always-run" : ""}`,
    "",
  ];

  if (scenario.liveSkip) {
    lines.push("skip (@qa-live-skip)", "");
    return lines;
  }

  let index = 1;
  for (const test of scenario.tests ?? []) {
    lines.push(...renderTestBlock(test, index, scenario));
    index += 1;
  }

  return lines;
}

/** Dedupe fixture paths for markdown (defaults first, then byCheckId). */
export function collectUniqueUploadFixtures(uploadFixtures) {
  if (!uploadFixtures) return [];

  const seenPaths = new Set();
  const unique = [];

  const addEntry = (name, absPath) => {
    if (!absPath || seenPaths.has(absPath)) return;
    seenPaths.add(absPath);
    unique.push({ name, absPath });
  };

  for (const [name, absPath] of Object.entries(uploadFixtures.defaults ?? {})) {
    addEntry(name, absPath);
  }

  for (const files of Object.values(uploadFixtures.byCheckId ?? {})) {
    for (const [name, absPath] of Object.entries(files)) {
      addEntry(name, absPath);
    }
  }

  return unique;
}

function renderUploadFixtures(uploadFixtures) {
  const unique = collectUniqueUploadFixtures(uploadFixtures);
  if (unique.length === 0) return [];

  const lines = ["## Uploads", ""];
  for (const { name, absPath } of unique) {
    lines.push(`- ${name}: \`${absPath}\``);
  }
  lines.push("");
  return lines;
}

function renderPlaywrightSources(specSourceFiles) {
  if (!specSourceFiles || Object.keys(specSourceFiles).length === 0) {
    return [];
  }

  const lines = ["## Playwright", ""];

  for (const [fileName, content] of Object.entries(specSourceFiles).sort()) {
    lines.push(`### ${fileName}`, "", "```typescript", content.trimEnd(), "```", "");
  }

  return lines;
}

/**
 * Minimal session block for judge (credentials appended separately in Hermes query).
 */
export function renderJudgeSessionHeader({
  page,
  stagingLogin = null,
  alwaysRunScenarioIds = [],
  title = null,
}) {
  const label = pageLabel(page);
  const lines = [`# ${title ?? `QA — ${label}`}`, ""];

  if (stagingLogin) {
    lines.push(
      `- login: ${stagingLogin.loginUrl}`,
      `- user: ${stagingLogin.email}`,
      `- page: ${stagingLogin.targetUrl}`,
      ""
    );
  }

  if (alwaysRunScenarioIds.length > 0) {
    lines.push(
      `always-run: ${alwaysRunScenarioIds.map(id => `\`${id}\``).join(", ")}`,
      ""
    );
  }

  return `${lines.join("\n")}\n`;
}

/** GWT scenario/test blocks only (no uploads or Playwright sources). */
export function renderGwtPlanFromSpec(
  spec,
  { alwaysRunScenarioIds = [] } = {}
) {
  const alwaysRunSet = new Set(alwaysRunScenarioIds);
  const lines = [];

  for (const scenario of spec.scenarios ?? []) {
    lines.push(
      ...renderScenarioBlock(scenario, {
        alwaysRun: alwaysRunSet.has(scenario.scenarioId),
      })
    );
  }

  return `${lines.join("\n")}\n`;
}

export function renderLiveSpecAppendices({
  uploadFixtures = null,
  specSourceFiles = {},
} = {}) {
  return [
    ...renderUploadFixtures(uploadFixtures),
    ...renderPlaywrightSources(specSourceFiles),
  ].join("");
}

function renderJudgeScenarioBody(
  spec,
  { alwaysRunScenarioIds = [], uploadFixtures = null, specSourceFiles = {} } = {}
) {
  return `${renderGwtPlanFromSpec(spec, { alwaysRunScenarioIds })}${renderLiveSpecAppendices({ uploadFixtures, specSourceFiles })}`;
}

export function renderAbstractAuditAppendix(audit) {
  const changes = audit?.changes ?? [];
  if (changes.length === 0) return "";

  const lines = ["## abstract-ai changes", ""];

  for (const change of changes) {
    lines.push(
      `- \`${change.checkId}\` ${change.field}: ${change.reason ?? ""} (${change.confidence ?? ""})`
    );
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

/**
 * Human-readable QA plan (compact GWT for Hermes).
 */
export function renderJudgeHermesDocument({
  page,
  spec,
  stagingLogin = null,
  alwaysRunScenarioIds = [],
  uploadFixtures = null,
  specSourceFiles = {},
  title = null,
  includeSession = true,
}) {
  const label = pageLabel(page);
  const parts = [];

  if (includeSession && stagingLogin) {
    parts.push(
      renderJudgeSessionHeader({
        page,
        stagingLogin,
        alwaysRunScenarioIds,
        title: title ?? `QA — ${label}`,
      }).trimEnd()
    );
  } else {
    parts.push(`# ${title ?? `${label} QA spec`}`, "");
  }

  parts.push(renderJudgeScenarioBody(spec, {
    alwaysRunScenarioIds,
    uploadFixtures,
    specSourceFiles,
  }).trimEnd());

  return `${parts.join("\n\n")}\n`;
}

/**
 * Saved `{page}-qa-spec-live.md` (no credentials).
 */
export function renderFriendlyQaSpecMarkdown(
  spec,
  page,
  {
    titleSuffix = "",
    specSourceFiles = {},
    uploadFixtures = null,
    alwaysRunScenarioIds = null,
    audit = null,
  } = {}
) {
  const alwaysRun =
    alwaysRunScenarioIds ??
    (spec.scenarios ?? []).filter(s => s.alwaysRun).map(s => s.scenarioId);

  let doc = renderJudgeHermesDocument({
    page,
    spec,
    includeSession: false,
    title: `${pageLabel(page)} QA spec${titleSuffix}`,
    alwaysRunScenarioIds: alwaysRun,
    uploadFixtures,
    specSourceFiles,
  });

  if (audit?.changes?.length) {
    doc = `${doc.trimEnd()}\n\n${renderAbstractAuditAppendix(audit)}`;
  }

  return doc;
}

export function buildJudgeBrowseDocument({
  page,
  spec,
  specLiveMarkdown = null,
  planSource = null,
  stagingLogin = null,
  alwaysRunScenarioIds = [],
  uploadFixtures = null,
  specSourceFiles = {},
}) {
  if (specLiveMarkdown?.trim()) {
    const sessionHeader = renderJudgeSessionHeader({
      page,
      stagingLogin,
      alwaysRunScenarioIds,
    });
    return {
      document: `${sessionHeader.trimEnd()}\n\n---\n\n${specLiveMarkdown.trim()}\n`,
      planSource: planSource ?? "spec-live.md",
    };
  }

  return {
    document: renderJudgeHermesDocument({
      page,
      spec,
      stagingLogin,
      alwaysRunScenarioIds,
      uploadFixtures,
      specSourceFiles,
      includeSession: true,
    }),
    planSource: "generated-from-json",
  };
}
