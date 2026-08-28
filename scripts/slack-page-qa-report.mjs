#!/usr/bin/env node
/**
 * Slack report — the last pipeline stage, and the only one most humans read.
 *
 * Two rules drive the shape of this file:
 *   1. Silence must mean exactly one thing. A quarantined judge run posts an
 *      ERRORED alert instead of exiting quietly, `--notify=always` posts a
 *      heartbeat, and only `pass` is treated as green.
 *   2. Everything the agent wrote is untrusted text: it is escaped for Slack
 *      mrkdwn and truncated before it reaches a payload.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactPaths,
  ensureProjectConfig,
  parsePageArg,
  parseTargetPathArg,
} from "./page-qa-paths.mjs";
import {
  applyStagingUrlDefaults,
  isPlaceholderBaseUrl,
} from "./hermes-qa-project-config.mjs";
import { readArtifact } from "./artifact-schema.mjs";
import { appendRunEvent } from "./qa-run-ledger.mjs";
import {
  EnvironmentError,
  EXIT_ENVIRONMENT,
  runMain,
  UsageError,
} from "./errors.mjs";

const NOTIFY_MODES = ["failures", "always", "never"];
const MAX_CHECKS = 10;
const MAX_DETAIL = 150;
const MAX_EVIDENCE = 5;

const STATUS_LABELS = {
  pass: "PASS",
  fail: "FAIL",
  manual_review: "MANUAL REVIEW",
  skip: "SKIPPED",
};

/** Slack mrkdwn reserves exactly these three characters. */
export function escapeMrkdwn(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function truncate(text, max = MAX_DETAIL) {
  const value = String(text ?? "").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Any status we do not recognise is treated as needing a human, never as green. */
export function statusLabel(status) {
  return STATUS_LABELS[status] ?? "UNKNOWN";
}

export function parseNotifyMode(argv = []) {
  const arg = argv.find(item => item.startsWith("--notify="));
  if (!arg) return "failures";
  const mode = arg.slice("--notify=".length).trim();
  if (!NOTIFY_MODES.includes(mode)) {
    throw new UsageError(`Unknown --notify=${mode}.`, {
      hint: `Use one of: ${NOTIFY_MODES.map(m => `--notify=${m}`).join(", ")}.`,
    });
  }
  return mode;
}

/**
 * `failures` (the default) posts on everything that is not an explicit pass —
 * a skipped or unrecognised verdict means nothing was verified, which is the
 * outcome most worth seeing.
 */
export function shouldNotify(status, mode = "failures") {
  if (mode === "never") return false;
  if (mode === "always") return true;
  return status !== "pass";
}

/**
 * Same precedence the judge used when it browsed (CLI > env > project config),
 * so the link points at the origin that was actually judged.
 */
export function resolveBaseUrl(argv = []) {
  const cli = argv.find(item => item.startsWith("--base-url="));
  const fromConfig = {};
  applyStagingUrlDefaults(fromConfig, argv);
  return (
    (cli ? cli.slice("--base-url=".length).trim() : "") ||
    process.env.STAGING_QA_BASE_URL ||
    fromConfig.baseUrl ||
    ""
  );
}

/** A placeholder origin is worse than no link, so it degrades to the bare path. */
function targetLink(baseUrl, targetPath) {
  const path = targetPath || "/";
  if (!baseUrl || isPlaceholderBaseUrl(baseUrl)) return escapeMrkdwn(path);
  let url;
  try {
    url = new URL(path, baseUrl).toString();
  } catch {
    return escapeMrkdwn(path);
  }
  return `<${url}|${escapeMrkdwn(url)}>`;
}

function targetField(baseUrl, targetPath) {
  return `*Target:* ${targetLink(baseUrl, targetPath)}`;
}

/** An ack with no `until` never expires; an unparseable one is ignored. */
export function activeAcks(ackFile, now = new Date()) {
  const acks = Array.isArray(ackFile?.acks) ? ackFile.acks : [];
  return acks.filter(ack => {
    if (!ack?.item) return false;
    if (!ack.until) return true;
    const until = Date.parse(ack.until);
    return !Number.isNaN(until) && until >= now.getTime();
  });
}

/** Only checks a human still has to act on reach the alert body. */
export function selectAlertChecks(checks, ackedItems = new Set()) {
  const failing = (Array.isArray(checks) ? checks : []).filter(
    check => check?.result === "fail" || check?.result === "manual_review"
  );
  const visible = failing.filter(check => !ackedItems.has(String(check.item)));
  return { visible, ackedCount: failing.length - visible.length };
}

function section(text) {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function runIdentity(judgment) {
  const parts = [];
  if (judgment?.runId) parts.push(`run \`${escapeMrkdwn(judgment.runId)}\``);
  const meta = judgment?.agentMeta;
  if (meta?.adapter) {
    parts.push(
      `${escapeMrkdwn(meta.adapter)}${meta.model ? ` (${escapeMrkdwn(meta.model)})` : ""}`
    );
  }
  if (judgment?.judgedAt) parts.push(escapeMrkdwn(judgment.judgedAt));
  return parts.join(" • ");
}

function footerContext(page, judgment) {
  const identity = runIdentity(judgment);
  return {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Rerun: \`npx playwright-spec-for-ai-agent judge --page=${page}\``,
      },
      ...(identity ? [{ type: "mrkdwn", text: identity }] : []),
    ],
  };
}

function reviewField(review) {
  const overall = escapeMrkdwn(review?.overallReview ?? "unknown");
  const flagged = (review?.criteria ?? [])
    .filter(
      criterion =>
        criterion?.verdict === "fail" || criterion?.verdict === "concern"
    )
    .map(criterion => escapeMrkdwn(criterion?.title ?? criterion?.id ?? "criterion"));
  return `*Judge review:* ${overall}${
    flagged.length ? ` — flagged: ${flagged.join(", ")}` : ""
  }`;
}

/**
 * @param {{ page: string, targetPath?: string, judgment: object, review?: object|null,
 *           acks?: Array<{item: string}>, baseUrl?: string, runUrl?: string }} input
 */
export function buildPayload({
  page,
  targetPath = "/",
  judgment,
  review = null,
  acks = [],
  baseUrl = "",
  runUrl = "",
}) {
  const status =
    typeof judgment?.status === "string" ? judgment.status : "unknown";
  const label = statusLabel(status);
  const ackedItems = new Set(acks.map(ack => String(ack.item)));
  const { visible, ackedCount } = selectAlertChecks(judgment?.checks, ackedItems);
  const shown = visible.slice(0, MAX_CHECKS);
  const hidden = visible.length - shown.length;
  const evidence = (judgment?.evidence ?? []).slice(0, MAX_EVIDENCE);
  const recommendedAction = String(judgment?.recommendedAction ?? "").trim();
  const headline = `[${label}] Nightly ${page} QA: ${status}${
    ackedCount ? ` (${ackedCount} acked)` : ""
  }`;

  // A green run is only ever posted under --notify=always, where the point is
  // "the cron fired and found nothing" — one line, not a report.
  if (status === "pass") {
    const identity = runIdentity(judgment);
    return {
      username: "Page QA Bot",
      text: headline,
      blocks: [
        section(
          `*${escapeMrkdwn(headline)}* • ${targetLink(baseUrl, targetPath)}${
            identity ? ` • ${identity}` : ""
          }`
        ),
      ],
    };
  }

  return {
    username: "Page QA Bot",
    text: headline,
    blocks: [
      section(
        `*${escapeMrkdwn(headline)}*\n${targetField(baseUrl, targetPath)}`
      ),
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Run:*\n${runUrl ? `<${runUrl}|GitHub Actions>` : "local"}`,
          },
          {
            type: "mrkdwn",
            text: `*Judgment source:*\n${escapeMrkdwn(judgment?.source ?? "unknown")}`,
          },
        ],
      },
      section(`*Summary:*\n${escapeMrkdwn(judgment?.summary ?? status)}`),
      ...(shown.length
        ? [
            section(
              [
                `*Failing checks (${visible.length}):*`,
                ...shown.map(
                  check =>
                    `• ${escapeMrkdwn(check.item)} — ${escapeMrkdwn(truncate(check.detail) || "(no detail)")}`
                ),
                ...(hidden ? [`+${hidden} more`] : []),
              ].join("\n")
            ),
          ]
        : []),
      ...(recommendedAction
        ? [
            section(
              `*Recommended action:*\n${escapeMrkdwn(truncate(recommendedAction, 600))}`
            ),
          ]
        : []),
      ...(review ? [section(reviewField(review))] : []),
      ...(evidence.length
        ? [
            section(
              `*Evidence:*\n${evidence
                .map(item => `- ${escapeMrkdwn(truncate(item))}`)
                .join("\n")}`
            ),
          ]
        : []),
      footerContext(page, judgment),
    ],
  };
}

/** A crashed judge is the quietest outcome there is unless it says so out loud. */
export function buildQuarantinePayload({
  page,
  targetPath = "/",
  marker,
  baseUrl = "",
  runUrl = "",
}) {
  const headline = `[ERRORED] Nightly ${page} QA: judge run quarantined`;
  const reason = escapeMrkdwn(
    truncate(marker?.reason ?? "unknown failure", 600)
  );
  return {
    username: "Page QA Bot",
    text: headline,
    blocks: [
      section(
        `*${escapeMrkdwn(headline)}*\n${targetField(baseUrl, targetPath)}`
      ),
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Run:*\n${runUrl ? `<${runUrl}|GitHub Actions>` : "local"}`,
          },
          {
            type: "mrkdwn",
            text: `*Quarantined at:*\n${escapeMrkdwn(marker?.at ?? "unknown")}`,
          },
        ],
      },
      section(
        `*Reason:*\n${reason}\n\nNo verdict was produced for this page — this is not a pass.`
      ),
      footerContext(page, null),
    ],
  };
}

function readQuarantineMarker(paths) {
  if (!existsSync(paths.runInvalidMarker)) return null;
  try {
    return JSON.parse(readFileSync(paths.runInvalidMarker, "utf8"));
  } catch {
    return { reason: "unreadable quarantine marker", at: "unknown" };
  }
}

function readAcks(paths, now = new Date()) {
  if (!existsSync(paths.ackJson)) return [];
  try {
    return activeAcks(JSON.parse(readFileSync(paths.ackJson, "utf8")), now);
  } catch {
    return [];
  }
}

async function postToSlack(payload) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    throw new EnvironmentError("Missing SLACK_WEBHOOK_URL.", {
      hint: "Export SLACK_WEBHOOK_URL=<Slack incoming webhook URL>, or pass --notify=never to skip reporting.",
    });
  }
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new EnvironmentError(
      `Slack webhook rejected the report: ${response.status} ${response.statusText}\n${await response.text()}`,
      { hint: "Check that SLACK_WEBHOOK_URL is current and its channel still exists." }
    );
  }
}

function recordSlackEvent(paths, page, status, notified, runId) {
  appendRunEvent(paths.runsLedger, {
    kind: "slack",
    page,
    status,
    notified,
    ...(runId ? { runId } : {}),
  });
}

async function main() {
  const argv = process.argv.slice(2);
  await ensureProjectConfig(argv);
  const page = parsePageArg(argv);
  const targetPath = parseTargetPathArg(argv, page);
  const paths = artifactPaths(page);
  const notifyMode = parseNotifyMode(argv);
  const baseUrl = resolveBaseUrl(argv);
  const runUrl = process.env.GITHUB_SERVER_URL
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "";

  const marker = readQuarantineMarker(paths);
  if (marker) {
    const notify = notifyMode !== "never";
    if (notify) {
      await postToSlack(
        buildQuarantinePayload({ page, targetPath, marker, baseUrl, runUrl })
      );
    }
    recordSlackEvent(paths, page, "errored", notify, null);
    console.log(
      `${page} QA judge run is quarantined (${marker.reason}); ${
        notify ? "ERRORED Slack notification sent" : "--notify=never, nothing sent"
      }.`
    );
    return EXIT_ENVIRONMENT;
  }

  if (!existsSync(paths.hermesJudgmentJson)) {
    throw new UsageError(
      `Missing ${paths.slug}-hermes-judgment.json.`,
      {
        hint: `Run \`npx playwright-spec-for-ai-agent judge --page=${page}\` first.`,
      }
    );
  }
  const judgment = readArtifact(paths.hermesJudgmentJson, { kind: "judgment" });
  const review = existsSync(paths.hermesReviewJson)
    ? readArtifact(paths.hermesReviewJson, { kind: "review" })
    : null;

  const status =
    typeof judgment.status === "string" ? judgment.status : "unknown";
  const notify = shouldNotify(status, notifyMode);

  if (notify) {
    await postToSlack(
      buildPayload({
        page,
        targetPath,
        judgment,
        review,
        acks: readAcks(paths),
        baseUrl,
        runUrl,
      })
    );
  }

  recordSlackEvent(paths, page, status, notify, judgment.runId);
  console.log(
    notify
      ? `${page} QA ${status} (${statusLabel(status)}); Slack notification sent.`
      : `${page} QA ${status} (${statusLabel(status)}); no Slack notification sent (--notify=${notifyMode}).`
  );
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) runMain(main);
