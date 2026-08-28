#!/usr/bin/env node
/**
 * Triage lifecycle for `manual_review` items.
 *
 * A judgment that needs a human decision has nowhere to record that decision:
 * the same item re-alerts every night until someone edits an artifact by hand.
 * An ack is that decision, with an expiry — silence has to run out, or a known
 * issue quietly becomes an unknown one.
 *
 * Usage:
 *   ack --page=dashboard --item="renders invoices" --reason="tracked in ACME-12"
 *   ack --page=dashboard --list
 *   ack --page=dashboard --remove="renders invoices"
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPaths, ensureProjectConfig } from "./page-qa-paths.mjs";
import { readArtifact } from "./artifact-schema.mjs";
import { appendRunEvent } from "./qa-run-ledger.mjs";
import { EXIT_OK, runMain, UsageError } from "./errors.mjs";

export const DEFAULT_ACK_DAYS = 14;

const HELP = `Usage: npx playwright-spec-for-ai-agent ack [options]

  Acknowledge a judged check so the Slack report stops re-alerting on it.

Options:
  --page=<slug>        Page id (required)
  --item=<check>       Exact check title from the latest judgment
  --reason=<text>      Why it is acknowledged (required with --item)
  --by=<name>          Who acknowledged it (default: $USER)
  --until=<YYYY-MM-DD> Expiry (default: ${DEFAULT_ACK_DAYS} days from now)
  --list               Print the current acks for the page
  --remove=<check>     Remove one ack
  --config=<path>      Project config file
  --project-root=<dir> Project root directory
`;

function flagValue(argv, prefix) {
  const arg = argv.find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : "";
}

/** Local so a missing page exits 2 (usage), not 1 (verdict failure). */
function requirePage(argv) {
  const page = flagValue(argv, "--page=");
  if (!page) {
    throw new UsageError("Missing --page= argument.", {
      hint: "Example: ack --page=dashboard --list",
    });
  }
  return page;
}

export function readAckFile(path) {
  if (!existsSync(path)) return { acks: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`Cannot parse ${path}: ${error.message}`, {
      hint: "Delete the file and re-add the acks, or fix the JSON by hand.",
    });
  }
  return { acks: Array.isArray(parsed?.acks) ? parsed.acks : [] };
}

function writeAckFile(paths, acks) {
  mkdirSync(paths.outputDir, { recursive: true });
  writeFileSync(paths.ackJson, `${JSON.stringify({ acks }, null, 2)}\n`);
}

/** Every check title the latest judgment knows about. */
export function judgedItems(paths) {
  if (!existsSync(paths.hermesJudgmentJson)) {
    throw new UsageError(`No judgment for this page yet (${paths.hermesJudgmentJson}).`, {
      hint: "Run `npx playwright-spec-for-ai-agent judge --page=<slug>` first.",
    });
  }
  const judgment = readArtifact(paths.hermesJudgmentJson, { kind: "judgment" });
  const checks = Array.isArray(judgment.checks) ? judgment.checks : [];
  return checks.map(check => String(check?.item ?? "")).filter(Boolean);
}

/**
 * A typo must not silently ack nothing: an ack that matches no check looks
 * identical to a working one until the alert fires again tomorrow night.
 */
function assertKnownItem(item, items) {
  if (items.includes(item)) return;
  throw new UsageError(`"${item}" is not a check in the latest judgment.`, {
    hint: items.length
      ? `Available items:\n${items.map(known => `  - ${known}`).join("\n")}`
      : "The latest judgment recorded no checks at all.",
  });
}

export function expiryFrom(until, now = new Date()) {
  if (!until) {
    return new Date(now.getTime() + DEFAULT_ACK_DAYS * 86_400_000).toISOString();
  }
  const parsed = Date.parse(until);
  if (Number.isNaN(parsed)) {
    throw new UsageError(`Unparseable --until=${until}.`, {
      hint: "Use --until=YYYY-MM-DD.",
    });
  }
  return new Date(parsed).toISOString();
}

/** Re-acking an item replaces it, so a second ack extends rather than duplicates. */
export function upsertAck(acks, ack) {
  return [...acks.filter(existing => existing?.item !== ack.item), ack];
}

function formatAcks(page, acks, now = new Date()) {
  if (!acks.length) return `No acks recorded for ${page}.`;
  return [
    `Acks for ${page}:`,
    ...acks.map(ack => {
      const expired =
        ack.until && Date.parse(ack.until) < now.getTime() ? " (EXPIRED)" : "";
      return `  - ${ack.item}${expired}\n      reason: ${ack.reason ?? "—"}\n      by: ${ack.by ?? "—"}  until: ${ack.until ?? "never"}`;
    }),
  ].join("\n");
}

/**
 * @param {string[]} argv
 * @param {{ now?: Date }} [overrides]
 * @returns {Promise<number>} process exit code
 */
export async function run(argv = process.argv.slice(2), { now = new Date() } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return EXIT_OK;
  }

  await ensureProjectConfig(argv);
  const page = requirePage(argv);
  const paths = artifactPaths(page);
  const file = readAckFile(paths.ackJson);

  if (argv.includes("--list")) {
    console.log(formatAcks(page, file.acks, now));
    return EXIT_OK;
  }

  const removeItem = flagValue(argv, "--remove=");
  if (removeItem) {
    const remaining = file.acks.filter(ack => ack?.item !== removeItem);
    if (remaining.length === file.acks.length) {
      throw new UsageError(`No ack for "${removeItem}" on ${page}.`, {
        hint: file.acks.length
          ? `Current acks:\n${file.acks.map(ack => `  - ${ack.item}`).join("\n")}`
          : "This page has no acks.",
      });
    }
    writeAckFile(paths, remaining);
    appendRunEvent(paths.runsLedger, {
      kind: "ack",
      page,
      action: "remove",
      item: removeItem,
    });
    console.log(`Removed ack for "${removeItem}" on ${page}.`);
    return EXIT_OK;
  }

  const item = flagValue(argv, "--item=");
  if (!item) {
    throw new UsageError("Missing --item=<check title>.", {
      hint: "Pass --item=, or use --list / --remove=. See `ack --help`.",
    });
  }
  const reason = flagValue(argv, "--reason=");
  if (!reason) {
    throw new UsageError("Missing --reason=<text>.", {
      hint: "An ack without a reason is indistinguishable from an ignored alert.",
    });
  }

  assertKnownItem(item, judgedItems(paths));

  const ack = {
    item,
    reason,
    by: flagValue(argv, "--by=") || process.env.USER || "unknown",
    until: expiryFrom(flagValue(argv, "--until="), now),
    at: now.toISOString(),
  };
  writeAckFile(paths, upsertAck(file.acks, ack));
  appendRunEvent(paths.runsLedger, {
    kind: "ack",
    page,
    action: "add",
    item,
    until: ack.until,
  });
  console.log(`Acked "${item}" on ${page} until ${ack.until} (${ack.by}).`);
  return EXIT_OK;
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) runMain(() => run());
