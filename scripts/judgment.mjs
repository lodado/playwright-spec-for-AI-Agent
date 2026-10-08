/**
 * Judgment decisions — Core. How an agent's answer becomes the judgment the
 * pipeline stores, how that renders, which exit code it earns, and how a failed
 * attempt is retried.
 *
 * The agent attempt, the evidence file access and the judge-retry ledger line
 * arrive as arguments; the shell (`run-hermes-page-judge.mjs`) supplies them.
 */
import {
  AgentOutputError,
  EnvironmentError,
  EXIT_OK,
  EXIT_VERDICT_FAIL,
} from "./errors.mjs";
import { normalizeBrowseDecision } from "./judge-verdict.mjs";

export function renderMarkdown(judgment) {
  const checkRows = judgment.checks?.length
    ? judgment.checks.map(check => {
        const demoted = check.demotedFrom ? ` (was ${check.demotedFrom})` : "";
        return `| ${check.result}${demoted} | ${check.cause ?? ""} | ${check.item} | ${(check.detail ?? "").replace(/\|/g, "\\|")} |`;
      })
    : [];

  return [
    `# Hermes QA Judgment — ${judgment.page}`,
    "",
    `- Status: **${judgment.status}**`,
    `- Cause: \`${judgment.cause}\``,
    `- Run: \`${judgment.runId}\` at ${judgment.judgedAt}`,
    `- Mode: \`browse\``,
    `- Page: \`${judgment.targetPath}\``,
    `- Plan source: ${judgment.planSource}`,
    `- Coverage: ${judgment.coverage.addressed}/${judgment.coverage.planned} planned checks addressed`,
    `- Source: ${judgment.source}`,
    ...(judgment.agentMeta
      ? [
          `- Adapter: ${judgment.agentMeta.adapter}${judgment.agentMeta.model ? ` (${judgment.agentMeta.model})` : ""}, ${Math.round(judgment.agentMeta.durationMs / 1000)}s`,
        ]
      : []),
    "",
    "## Summary",
    "",
    judgment.summary,
    "",
    ...(judgment.coverage.missing.length
      ? [
          "## Unaddressed planned checks",
          "",
          ...judgment.coverage.missing.map(item => `- ${item}`),
          "",
        ]
      : []),
    ...(checkRows.length
      ? [
          "## Checks",
          "",
          "| Result | Cause | Item | Detail |",
          "|--------|-------|------|--------|",
          ...checkRows,
          "",
        ]
      : []),
    "## Evidence",
    "",
    ...(judgment.evidence?.length
      ? judgment.evidence.map(item => `- ${item}`)
      : ["- none"]),
    ...(judgment.runnerEvidence
      ? [
          "",
          "## Runner-captured evidence",
          "",
          ...(judgment.runnerEvidence.browserProvider?.name === "browserbase"
            ? [`- Browserbase session: [${judgment.runnerEvidence.browserProvider.sessionId}](https://www.browserbase.com/sessions/${encodeURIComponent(judgment.runnerEvidence.browserProvider.sessionId)})`]
            : []),
          ...[
            judgment.runnerEvidence.tracePath &&
              `- trace: \`${judgment.runnerEvidence.tracePath}\``,
            judgment.runnerEvidence.harPath &&
              `- har: \`${judgment.runnerEvidence.harPath}\``,
            judgment.runnerEvidence.videoPath &&
              `- video: \`${judgment.runnerEvidence.videoPath}\``,
            `- screenshots: ${judgment.runnerEvidence.screenshots?.length ?? 0}`,
            `- aria snapshots: ${judgment.runnerEvidence.ariaSnapshots?.length ?? 0}`,
            ...(judgment.runnerEvidence.violations ?? []).map(
              violation => `- violation: ${violation.kind} — ${violation.detail}`
            ),
          ].filter(Boolean),
        ]
      : []),
    "",
    "## Recommended action",
    "",
    judgment.recommendedAction || "none",
    "",
  ].join("\n");
}

export function verdictExitCode(status, failOn) {
  if (failOn === "never") return EXIT_OK;
  if (status === "fail") return EXIT_VERDICT_FAIL;
  if (status === "manual_review" && failOn === "manual_review") {
    return EXIT_VERDICT_FAIL;
  }
  return EXIT_OK;
}

function summarizeAccountState(accountState) {
  if (!accountState) return null;
  return {
    state: accountState.state,
    expected: accountState.expected ?? null,
    mismatch: Boolean(accountState.mismatch),
    source: accountState.source,
    evidence: accountState.evidence || null,
  };
}

/**
 * The judgment record, before the shell stamps its schema. `io` is the
 * evidence file access (`evidenceIo` of node-io.mjs).
 *
 * @param {{ run: any, plan: any, result: any, accountState: any, judgedAt: string }} inputs
 * @param {{ io: { fileExists: (path: string) => boolean, readText: (path: string) => string } }} ports
 */
export function buildJudgment({ run, plan, result, accountState, judgedAt }, { io }) {
  const decision = normalizeBrowseDecision(result.raw, {
    ...io,
    plannedChecks: plan.plannedChecks,
    runnerEvidence: result.runnerEvidence,
    // A page judged in a state nobody asked for was not the test anyone
    // planned, so the run does not get to be green — but the reading still
    // stands, so this lowers the verdict instead of quarantining the run.
    violations: accountState?.mismatch
      ? [...result.violations, { kind: "account-state-mismatch", detail: accountState.note }]
      : result.violations,
  });

  return {
    runId: run.runId,
    page: run.page,
    judgedAt,
    targetUrl: run.targetUrl,
    targetPath: run.targetPath,
    planSource: plan.planSource,
    specHash: plan.specHash,
    accountState: summarizeAccountState(accountState),
    notApplicable: plan.notApplicable,
    status: decision.status,
    cause: decision.cause,
    summary: decision.summary,
    recommendedAction: decision.recommendedAction,
    source: decision.source,
    ...(decision.agentMeta ? { agentMeta: decision.agentMeta } : {}),
    checks: decision.checks,
    coverage: decision.coverage,
    evidence: decision.evidence,
    runnerEvidence: result.runnerEvidence ?? null,
  };
}

/**
 * Bounded retries with cause routing. A flapping login or an unparseable answer
 * is worth one more attempt; scenario checks are never silently re-judged, so a
 * completed judgment is returned as-is however bad it is.
 *
 * `attempt` runs one judge attempt; `onRetry` receives the judge-retry entry
 * (attempt number, reason, error) for the shell to append to the ledger.
 *
 * @template T
 * @param {() => Promise<T> | T} attempt
 * @param {{ onRetry: (entry: { attempt: number, reason: string, error: string }) => void }} hooks
 * @returns {Promise<T>}
 */
export async function executeWithRetries(attempt, { onRetry }) {
  const budget = { environment: 2, agentOutput: 1 };
  for (let number = 1; ; number += 1) {
    try {
      return await attempt();
    } catch (error) {
      const kind =
        error instanceof EnvironmentError
          ? "environment"
          : error instanceof AgentOutputError
            ? "agentOutput"
            : null;
      // On exhaustion the last real failure is what propagates — never a
      // synthesised "final attempt" verdict.
      if (!kind || budget[kind] <= 0) throw error;
      budget[kind] -= 1;
      onRetry({ attempt: number, reason: kind, error: error.message });
    }
  }
}
