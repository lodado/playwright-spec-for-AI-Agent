#!/usr/bin/env node
/**
 * GitHub issue filing — the notifier that turns a verdict into a work item.
 *
 * `slack` alerts a person; this files something a coding agent can pick up. The
 * body is the `handoff` document verbatim, so the agent gets each unsettled
 * check next to its frozen contract, the spec file behind it, and the same
 * guardrails — including the injection markers on judge-authored prose, which
 * matter more here because an issue reaches a reader with write access.
 *
 * Four rules drive the shape of this file:
 *   1. One issue per page, reused. A nightly that files a new issue every night
 *      is a nightly nobody reads, so an unchanged failure set stays silent.
 *   2. A green verdict closes the issue, and only a real re-judgment can produce
 *      one. Merging a fix does not close anything — the next run does.
 *   3. `HARNESS_DEFECT` is ops work, not product work. Filing it against the
 *      application team by default trains them to ignore the label.
 *   4. Staging URLs, page structure, and evidence paths travel in the body, so
 *      a public repository is refused unless the operator opts in.
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent issues --page=dashboard
 *   npx playwright-spec-for-ai-agent issues --all --dry-run
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSensitiveText } from "./agent-output.mjs";
import { readArtifact } from "./artifact-schema.mjs";
import {
  EnvironmentError,
  EXIT_ENVIRONMENT,
  runMain,
  UsageError,
} from "./errors.mjs";
import {
  getGithubIssueConfig,
  listConfiguredPages,
} from "./hermes-qa-project-config.mjs";
import {
  buildHandoffReport,
  renderHandoffReport,
} from "./page-qa-handoff.mjs";
import { artifactPaths, ensureProjectConfig } from "./page-qa-paths.mjs";
import { appendRunEvent } from "./qa-run-ledger.mjs";
import { flakinessReport, readHistory } from "./qa-verdict-history.mjs";
import { activeAcks, selectAlertChecks } from "./slack-page-qa-report.mjs";
import { hashJson } from "./spec-hash.mjs";

const DEFAULT_LABEL = "qa:verdict";
const FLAKY_LABEL = "qa:flaky";
const ISSUE_ON_MODES = ["unsettled", "fail"];
const MAX_TITLE = 120;

const HELP = `Usage: npx playwright-spec-for-ai-agent issues [options]

  File one GitHub issue per page whose verdict still needs someone to act, using
  the handoff document as the body. Reuses an open issue instead of filing a new
  one, and closes it when a later run passes.

Options:
  --page=<slug>        Page id (repeatable via --pages=)
  --pages=<a,b>        These pages instead of one --page
  --all                Every page in the config's \`pages\` block
  --issue-on=<mode>    unsettled (default) | fail
  --include-harness    Also file HARNESS_DEFECT causes and quarantined runs
  --label=<name>       Extra label, repeatable (always adds ${DEFAULT_LABEL})
  --allow-public       Permit filing on a public repository
  --dry-run            Print what would be sent; make no API call
  --config=<path>      Project config file
  --help, -h           Show this help

Environment: GITHUB_TOKEN (issues: write), GITHUB_REPOSITORY (owner/repo).
`;

/** Ties an issue to a page without depending on its title, which people edit. */
export function issueMarker(page) {
  return `<!-- playwright-spec-for-ai-agent: page=${page} -->`;
}

/**
 * Identity of a failure set. Two runs that fail the same checks the same way
 * have nothing new to say, and a comment per night buries the one that did.
 */
export function checksFingerprint(checks) {
  return hashJson(
    [...checks]
      .map(check => `${check.item}|${check.result}|${check.cause ?? ""}`)
      .sort()
  ).slice(0, 19);
}

export function fingerprintMarker(fingerprint) {
  return `<!-- qa-fingerprint: ${fingerprint} -->`;
}

export function readFingerprint(body) {
  return /<!--\s*qa-fingerprint:\s*(\S+)\s*-->/.exec(String(body ?? ""))?.[1] ?? null;
}

/**
 * A harness defect means the check was never really judged, so it is not a
 * product finding. Acks are honoured exactly as the Slack alert honours them.
 */
export function selectIssueChecks(
  checks,
  { ackedItems = new Set(), includeHarness = false, issueOn = "unsettled" } = {}
) {
  const { visible, ackedCount } = selectAlertChecks(checks, ackedItems);
  const byMode =
    issueOn === "fail" ? visible.filter(check => check.result === "fail") : visible;
  const harness = byMode.filter(check => check.cause === "HARNESS_DEFECT");
  return {
    visible: includeHarness
      ? byMode
      : byMode.filter(check => check.cause !== "HARNESS_DEFECT"),
    ackedCount,
    harnessCount: harness.length,
  };
}

export function issueTitle(page, status, checks) {
  const causes = [
    ...new Set(checks.map(check => check.cause).filter(cause => cause && cause !== "NONE")),
  ];
  const cause = causes.length === 1 ? ` (${causes[0]})` : "";
  const title = `[QA] ${page} — ${status}${cause}, ${checks.length} check${checks.length === 1 ? "" : "s"}`;
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title;
}

/**
 * The body is the handoff document plus routing markers. Nothing the judge
 * wrote is lifted out of it: the quoting and injection markers that make the
 * document safe to hand to an agent only hold while it stays intact.
 */
export function buildIssueBody(page, handoff, fingerprint, footer = "") {
  return [
    issueMarker(page),
    fingerprintMarker(fingerprint),
    "",
    handoff,
    ...(footer ? ["", "---", "", footer] : []),
  ].join("\n");
}

function labelsFor(extra, flaky) {
  return [...new Set([DEFAULT_LABEL, ...extra, ...(flaky ? [FLAKY_LABEL] : [])])];
}

/** Minimal REST client; `fetchImpl` is injected so tests never touch a network. */
export function createGithubClient({ token, repository, fetchImpl = fetch }) {
  const base = `https://api.github.com/repos/${repository}`;
  async function call(path, { method = "GET", body } = {}) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response?.ok) {
      const detail = typeof response?.text === "function" ? await response.text() : "";
      throw new EnvironmentError(
        `GitHub API ${method} ${path} failed: ${response?.status ?? "no status"} ${response?.statusText ?? ""}\n${detail}`,
        {
          hint: "Check that GITHUB_TOKEN is set, unexpired, and carries `issues: write` for this repository.",
        }
      );
    }
    return response.json();
  }
  return {
    repo: () => call(""),
    listIssues: labels =>
      call(`/issues?state=all&per_page=100&labels=${encodeURIComponent(labels)}`),
    create: body => call("/issues", { method: "POST", body }),
    update: (number, body) => call(`/issues/${number}`, { method: "PATCH", body }),
    comment: (number, body) =>
      call(`/issues/${number}/comments`, { method: "POST", body: { body } }),
  };
}

/** Pull requests come back on the issues endpoint; they are not our issues. */
export function findExistingIssue(issues, page) {
  const marker = issueMarker(page);
  return (
    (Array.isArray(issues) ? issues : []).find(
      issue => !issue?.pull_request && String(issue?.body ?? "").includes(marker)
    ) ?? null
  );
}

function readOptional(path, kind) {
  if (!existsSync(path)) return null;
  try {
    return readArtifact(path, kind ? { kind } : {});
  } catch {
    return null;
  }
}

function readQuarantineMarker(paths) {
  if (!existsSync(paths.runInvalidMarker)) return null;
  try {
    return JSON.parse(readFileSync(paths.runInvalidMarker, "utf8"));
  } catch {
    return { reason: "unreadable quarantine marker", at: "unknown" };
  }
}

function runUrl() {
  return process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "";
}

/**
 * Decide what this page's verdict should do to its issue, without performing
 * it — every branch here is a policy the tests pin, and none of them needs a
 * network to be true.
 */
export function planIssueAction(page, options = {}) {
  const paths = artifactPaths(page);
  const judgment = readOptional(paths.hermesJudgmentJson, "judgment");
  const quarantine = readQuarantineMarker(paths);
  const ackFile = readOptional(paths.ackJson);
  const ackedItems = new Set(
    activeAcks(ackFile).map(ack => String(ack.item))
  );

  if (quarantine && !options.includeHarness) {
    return {
      page,
      action: "none",
      reason: `run quarantined (${quarantine.reason ?? "unknown"}) — a harness failure, not a product finding (--include-harness to file it)`,
    };
  }
  if (!judgment) {
    return { page, action: "none", reason: "no judgment artifact" };
  }

  const { visible, ackedCount, harnessCount } = selectIssueChecks(judgment.checks, {
    ackedItems,
    includeHarness: options.includeHarness,
    issueOn: options.issueOn,
  });

  if (visible.length === 0) {
    const reason =
      harnessCount > 0
        ? `${harnessCount} unsettled check(s) are HARNESS_DEFECT — ops work (--include-harness to file)`
        : ackedCount > 0
          ? `every unsettled check is acknowledged (${ackedCount})`
          : `verdict ${judgment.status} leaves nothing to act on`;
    return {
      page,
      action: "close",
      reason,
      status: String(judgment.status ?? "unknown"),
      runId: judgment.runId ? String(judgment.runId) : "",
    };
  }

  const flakiness = flakinessReport(readHistory(paths.verdictHistoryJson));
  const flakyItems = new Set(flakiness.summary.flakyItems);
  const fingerprint = checksFingerprint(visible);
  const handoff = renderHandoffReport(buildHandoffReport(page));

  return {
    page,
    action: "file",
    status: String(judgment.status ?? "unknown"),
    runId: judgment.runId ? String(judgment.runId) : "",
    checks: visible,
    ackedCount,
    harnessCount,
    flaky: visible.some(check => flakyItems.has(check.item)),
    fingerprint,
    title: issueTitle(page, String(judgment.status ?? "unknown"), visible),
    body: buildIssueBody(page, handoff, fingerprint, options.footer),
  };
}

function commentForNewRun(plan) {
  const link = runUrl();
  return [
    `Still unsettled as of \`${plan.runId || "an unrecorded run"}\`: ${plan.checks.length} check(s), and the failure set changed since the last comment.`,
    "",
    plan.body.split("\n").slice(2).join("\n"),
    ...(link ? ["", `Run: ${link}`] : []),
  ].join("\n");
}

function closingComment(plan) {
  const link = runUrl();
  return [
    `Closed by \`${plan.runId || "a later run"}\`: ${plan.reason}.`,
    "",
    "This was closed by a re-judgment against staging, not by a merge — the fix is confirmed against the deployed page.",
    ...(link ? ["", `Run: ${link}`] : []),
  ].join("\n");
}

export async function applyPlan(plan, client, options, paths) {
  const existing = findExistingIssue(
    await client.listIssues(DEFAULT_LABEL),
    plan.page
  );

  if (plan.action === "close") {
    if (!existing || existing.state === "closed") {
      console.log(`[issues] ${plan.page}: nothing open — ${plan.reason}`);
      return { acted: false };
    }
    await client.comment(existing.number, closingComment(plan));
    await client.update(existing.number, { state: "closed" });
    console.log(`[issues] ${plan.page}: closed #${existing.number} — ${plan.reason}`);
    appendRunEvent(paths.runsLedger, {
      kind: "issue",
      page: plan.page,
      action: "closed",
      number: existing.number,
      ...(plan.runId ? { runId: plan.runId } : {}),
    });
    return { acted: true, number: existing.number };
  }

  const labels = labelsFor(options.labels, plan.flaky);

  if (!existing) {
    const created = await client.create({
      title: plan.title,
      body: plan.body,
      labels,
    });
    console.log(`[issues] ${plan.page}: filed #${created.number} — ${plan.title}`);
    appendRunEvent(paths.runsLedger, {
      kind: "issue",
      page: plan.page,
      action: "created",
      number: created.number,
      fingerprint: plan.fingerprint,
      ...(plan.runId ? { runId: plan.runId } : {}),
    });
    return { acted: true, number: created.number };
  }

  const unchanged =
    existing.state === "open" &&
    readFingerprint(existing.body) === plan.fingerprint;
  if (unchanged) {
    console.log(
      `[issues] ${plan.page}: #${existing.number} already reports this failure set — no comment`
    );
    return { acted: false, number: existing.number };
  }

  // A recurrence reopens the original thread: a second issue for the same page
  // loses the history of what was already tried.
  await client.update(existing.number, {
    state: "open",
    title: plan.title,
    body: plan.body,
    labels,
  });
  await client.comment(existing.number, commentForNewRun(plan));
  console.log(
    `[issues] ${plan.page}: updated #${existing.number} — failure set changed`
  );
  appendRunEvent(paths.runsLedger, {
    kind: "issue",
    page: plan.page,
    action: existing.state === "closed" ? "reopened" : "updated",
    number: existing.number,
    fingerprint: plan.fingerprint,
    ...(plan.runId ? { runId: plan.runId } : {}),
  });
  return { acted: true, number: existing.number };
}

export function parseOptions(argv = []) {
  const issueOnArg = argv.find(item => item.startsWith("--issue-on="));
  const issueOn = issueOnArg ? issueOnArg.slice("--issue-on=".length).trim() : "unsettled";
  if (!ISSUE_ON_MODES.includes(issueOn)) {
    throw new UsageError(`Unknown --issue-on=${issueOn}.`, {
      hint: `Use one of: ${ISSUE_ON_MODES.map(mode => `--issue-on=${mode}`).join(", ")}.`,
    });
  }
  return {
    issueOn,
    includeHarness: argv.includes("--include-harness"),
    allowPublic: argv.includes("--allow-public"),
    dryRun: argv.includes("--dry-run"),
    labels: argv
      .filter(item => item.startsWith("--label="))
      .map(item => item.slice("--label=".length).trim())
      .filter(Boolean),
    footer: getGithubIssueConfig().footer,
  };
}

export function selectPages(argv = []) {
  const pagesArg = argv.find(item => item.startsWith("--pages="));
  const pageArg = argv.find(item => item.startsWith("--page="));
  const pages = pagesArg
    ? pagesArg
        .slice("--pages=".length)
        .split(",")
        .map(item => item.trim())
        .filter(Boolean)
    : pageArg
      ? [pageArg.slice("--page=".length).trim()]
      : listConfiguredPages();
  if (!pages.length) {
    throw new UsageError("No pages to file issues for.", {
      hint: "Pass --page=<slug>, --pages=<a,b>, or add a `pages` block to your config.",
    });
  }
  return pages;
}

function resolveRepository() {
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  if (!repository || !repository.includes("/")) {
    throw new EnvironmentError(
      "Missing GITHUB_REPOSITORY (owner/repo).",
      { hint: "GitHub Actions sets it. Outside Actions, export it yourself." }
    );
  }
  return repository;
}

function resolveToken() {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new EnvironmentError("Missing GITHUB_TOKEN.", {
      hint: "Grant the workflow `permissions: issues: write` and pass GITHUB_TOKEN, or run with --dry-run.",
    });
  }
  return token;
}

/**
 * The handoff body carries the staging URL, the page's structure, and evidence
 * filenames. On a public repository that is a disclosure, so it takes an
 * explicit opt-in rather than a default.
 */
export async function assertPrivateRepository(client, options) {
  if (options.allowPublic) return;
  const repo = await client.repo();
  if (repo?.private === false) {
    throw new EnvironmentError(
      "Refusing to file QA issues on a public repository.",
      {
        hint: "The issue body carries the staging URL, page structure, and evidence paths. Pass --allow-public if that is intended.",
      }
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  await ensureProjectConfig(argv);
  const options = parseOptions(argv);
  const pages = selectPages(argv);
  const plans = pages.map(page => planIssueAction(page, options));

  if (options.dryRun) {
    for (const plan of plans) {
      console.log(`--- ${plan.page}: ${plan.action}${plan.reason ? ` (${plan.reason})` : ""}`);
      if (plan.action === "file") {
        console.log(`title: ${plan.title}`);
        console.log(redactSensitiveText(plan.body, [process.env.STAGING_QA_PASSWORD]));
      }
    }
    return;
  }

  const client = createGithubClient({
    token: resolveToken(),
    repository: resolveRepository(),
  });
  await assertPrivateRepository(client, options);

  let failures = 0;
  for (const plan of plans) {
    if (plan.action === "none") {
      console.log(`[issues] ${plan.page}: skipped — ${plan.reason}`);
      continue;
    }
    try {
      await applyPlan(plan, client, options, artifactPaths(plan.page));
    } catch (error) {
      // One page's API failure must not hide the others' findings.
      failures += 1;
      console.error(`[issues] ${plan.page}: ${error.message}`);
    }
  }
  if (failures > 0) {
    process.exitCode = EXIT_ENVIRONMENT;
  }
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) runMain(main);
