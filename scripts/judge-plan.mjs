/**
 * Judge plan decisions — Core. What the judge stage decides before it touches a
 * browser or an agent: the auth mode, whether the live plan still descends
 * from the raw spec, and the planned-check list the verdict floor is measured
 * against.
 *
 * Nothing here reads a file or the environment. The shell
 * (`run-hermes-page-judge.mjs`) passes the file-backed and config-backed
 * lookups in as `ports`.
 */
import { UsageError } from "./errors.mjs";
import { isReadOnlyPlan, resolveJudgeTurnBudget } from "./judge-verdict.mjs";
import {
  buildBrowseChecklist,
  listAlwaysRunScenarios,
  selectScenariosForLiveRun,
} from "./spec-annotation-reader.mjs";
import { hashSpecDefinition } from "./spec-hash.mjs";

/** @typedef {"cdp-attach" | "self-prelogin" | "credentials-in-prompt"} AuthCapability */

/**
 * Lookups the shell supplies; each one is the file, config or document-layout
 * access the plan needs.
 *
 * @typedef {object} JudgePlanPorts
 * @property {(paths: any) => any} resolveSpecForJudge the resolved spec and its staleness, or null
 * @property {(config: any) => any} buildStagingLogin
 * @property {(page: string) => Record<string, string>} loadSpecSourceFiles
 * @property {(spec: any, page: string) => any} buildUploadFixturesPayload
 * @property {(uploadFixtures: any) => unknown} inspectUploadFixtures
 * @property {(fixtures: any) => Record<string, string>} resolveFixturePaths
 * @property {(paths: any, scenarioIds: string[]) => string | null} scopeSavedPlan
 * @property {(args: any) => { document: string, planSource: string }} buildJudgeDocument
 * @property {(args: any) => string} buildQuery
 */

/**
 * Session-first: with an operator-authenticated browser the run needs no
 * credentials anywhere, and --credentials-in-prompt forces the legacy flow
 * (plaintext credentials inside the prompt). The matrix reads the adapter's
 * declared auth capability, never its name. A configured storage state IS the
 * session, so nothing needs to type credentials — demanding them anyway blocks
 * exactly the apps this path exists for (no login form to drive at all).
 *
 * @param {{ auth: AuthCapability, credentialsInPrompt: boolean, cloud: boolean,
 *           attachUrl: string | undefined, sessionProfile: boolean, seedable: boolean }} input
 */
export function decideAuthMode({ auth, credentialsInPrompt, cloud, attachUrl, sessionProfile, seedable }) {
  const selfPrelogin = auth === "self-prelogin";
  const cdpAttach = auth === "cdp-attach";
  const attachable = cdpAttach && (cloud || Boolean(attachUrl) || sessionProfile);
  return {
    requireCredentials:
      credentialsInPrompt || (!seedable && selfPrelogin) || (!seedable && !attachable),
    // A session covers login; the run is preauthenticated only when the page
    // also requires login.
    sessionCoversLogin:
      !credentialsInPrompt && (selfPrelogin || attachable || (seedable && cdpAttach)),
  };
}

/**
 * The live-plan stamp decision, then the plan. An actual mismatch between the
 * live plan's source hash and the raw spec comes back as `{ mismatch }` for the
 * shell to refuse with exit 2; a stamp that cannot be established proceeds.
 * Writing the plan document is the shell's job.
 *
 * @param {any} inputs
 * @param {JudgePlanPorts} ports
 */
export function prepareJudgePlan(inputs, ports) {
  const { page, paths } = inputs;
  const resolved = ports.resolveSpecForJudge(paths);
  if (!resolved) {
    throw new UsageError(`Missing qa spec JSON for page "${page}".`, {
      hint: `Run: npx playwright-spec-for-ai-agent spec --page=${page}`,
    });
  }
  if (resolved.staleness && resolved.staleness.ok === false) {
    return {
      mismatch: {
        expected: resolved.staleness.expected,
        actual: resolved.staleness.actual,
      },
    };
  }
  return buildJudgePlan({ ...inputs, resolved }, ports);
}

/**
 * The plan for a resolved, non-stale spec: prompt, turn budget, and the
 * planned-check list the verdict floor is measured against.
 *
 * @param {any} inputs
 * @param {JudgePlanPorts} ports
 */
export function buildJudgePlan(
  {
    page,
    targetUrl,
    paths,
    config,
    adapter,
    preauthenticated,
    accountState = null,
    resolved,
    turnBudgetOverride,
  },
  ports
) {
  const specDefinition = resolved.definition;
  // Provenance, not identity: record the hash of the raw `spec` artifact this
  // plan descends from (what `resolveSpecForJudge` compares against), so
  // `show`/`report`/`review` can re-derive it. Hashing the resolved plan
  // instead would make every later staleness check read as a mismatch.
  const specHash =
    resolved.staleness.actual ?? hashSpecDefinition(specDefinition);

  const stagingLogin = ports.buildStagingLogin(config);
  if (preauthenticated) {
    // The agent browses a pre-authenticated browser over CDP; credentials and
    // even the account email stay out of the prompt and the judge plan.
    stagingLogin.email = "";
    stagingLogin.password = "";
  }
  stagingLogin.targetUrl = targetUrl;

  // One live account is in one state. Judging the other states' scenarios costs
  // a prompt that grows with every state the product has, and reports them as
  // `skip` for "wrong account" — noise measured against a denominator that was
  // never applicable. With a state settled, the run carries that state plus the
  // always-run scenarios and nothing else.
  const scopedScenarios = accountState
    ? selectScenariosForLiveRun(specDefinition, accountState)
    : null;
  const notApplicable = scopedScenarios
    ? (specDefinition.scenarios ?? [])
        .map(scenario => scenario.scenarioId)
        .filter(id => !scopedScenarios.some(scenario => scenario.scenarioId === id))
    : [];
  const scopedSpec = scopedScenarios
    ? { ...specDefinition, scenarios: scopedScenarios }
    : specDefinition;

  const specSourceFiles = ports.loadSpecSourceFiles(page);
  const uploadFixtures = ports.buildUploadFixturesPayload(scopedSpec, page);
  ports.inspectUploadFixtures(uploadFixtures);
  const hasScenarios = Array.isArray(scopedSpec?.scenarios);
  const alwaysRunScenarioIds = hasScenarios
    ? listAlwaysRunScenarios(scopedSpec).map(scenario => scenario.scenarioId)
    : [];
  const checklist = hasScenarios ? buildBrowseChecklist(scopedSpec) : [];
  // One planned entry per plan block, duplicates included: the same title is
  // planned once per scenario and the agent reports one check per block, so
  // deduplicating here made `coverage.planned` disagree with the very document
  // the agent was handed — which the review stage then flags, correctly.
  const plannedChecks = checklist.map(({ checkId, title, scenarioId, sourceFile, fixtures, requiredUploadFixtures, liveRunPolicy }) => ({
    checkId, item: title, scenarioId, sourceFile, liveRunPolicy,
    // Only executable-interaction may attach a file (qa_upload_fixture refuses
    // the rest), so no other check is offered one.
    uploadFixtures: liveRunPolicy === "executable-interaction"
      ? { ...uploadFixtures.defaults, ...ports.resolveFixturePaths(fixtures) }
      : {},
    requiredUploadFixtures: liveRunPolicy === "executable-interaction" ? ports.resolveFixturePaths(requiredUploadFixtures) : {},
  }));

  const savedPlanMarkdown = ports.scopeSavedPlan(
    paths,
    scopedScenarios?.map(scenario => scenario.scenarioId) ?? []
  );

  const { document: judgeDocument, planSource } = ports.buildJudgeDocument({
    page,
    spec: scopedSpec,
    plannedChecks,
    specLiveMarkdown: savedPlanMarkdown,
    planSource: savedPlanMarkdown ? "spec-live.md" : null,
    stagingLogin: {
      loginUrl: stagingLogin.loginUrl,
      email: stagingLogin.email,
      targetUrl: stagingLogin.targetUrl,
    },
    alwaysRunScenarioIds,
    uploadFixtures,
    specSourceFiles,
  });

  return {
    plan: {
      query: ports.buildQuery({
        judgeDocument,
        stagingLogin,
        preauthenticated,
      }),
      uploadFixtures,
      secrets: [config.email, config.password].filter(Boolean),
      stagingLogin,
      specPath: resolved.path,
      specHash,
      planSource,
      plannedChecks,
      notApplicable,
      readOnly: isReadOnlyPlan(checklist),
      // An adapter that cannot cap its turns ignores the budget entirely.
      maxTurns: adapter.capabilities.supportsMaxTurns
        ? resolveJudgeTurnBudget(plannedChecks.length, turnBudgetOverride)
        : null,
    },
    // `review` re-checks this stamp against the judgment's `specHash` before it
    // critiques anything. Stamping the value the judgment will carry is what
    // makes that check real: the plan's own front matter records `sourceHash`
    // (a different key, absent entirely when abstract-ai never ran), so the
    // reviewer found nothing to compare and silently reviewed any revision.
    planMarkdown: `<!-- specHash: ${specHash} -->\n${judgeDocument}`,
  };
}
