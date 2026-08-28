/**
 * Append-only, hash-chained run ledger (one JSONL file per page).
 *
 * Every agent invocation and verdict appends an entry whose hash covers the
 * previous entry's hash, so verdict history is tamper-evident: a re-run cannot
 * silently overwrite last night's fail, and a report can cite a runId instead
 * of restating a verdict word.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { canonicalize } from "./spec-hash.mjs";

export const LEDGER_GENESIS = "sha256:genesis";

export function newRunId() {
  return `run-${randomUUID().slice(0, 8)}`;
}

function entryHash(entry) {
  return `sha256:${createHash("sha256").update(canonicalize(entry), "utf8").digest("hex")}`;
}

/** @returns {Array<object>} every well-formed entry; malformed lines are skipped. */
export function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function lastEntry(ledgerPath) {
  const entries = readLedger(ledgerPath);
  return entries.length ? entries[entries.length - 1] : null;
}

/**
 * Append one event. Returns the stored entry, including its runId and hash, so
 * the caller can cite it.
 *
 * @param {string} ledgerPath
 * @param {object} event — must carry at least { kind }
 * @param {{ now?: string }} [options]
 */
export function appendRunEvent(ledgerPath, event, { now } = {}) {
  const previous = lastEntry(ledgerPath);
  const body = {
    runId: event.runId ?? newRunId(),
    at: now ?? new Date().toISOString(),
    ...event,
    prevHash: previous?.hash ?? LEDGER_GENESIS,
  };
  const entry = { ...body, hash: entryHash(body) };
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
  return entry;
}

/**
 * Verify the chain end to end.
 *
 * @returns {{ ok: boolean, entries: number, brokenAt: number|null, reason: string|null }}
 */
export function verifyLedger(ledgerPath) {
  const entries = readLedger(ledgerPath);
  let expectedPrev = LEDGER_GENESIS;
  for (const [index, entry] of entries.entries()) {
    const { hash, ...body } = entry;
    if (body.prevHash !== expectedPrev) {
      return {
        ok: false,
        entries: entries.length,
        brokenAt: index,
        reason: `entry ${index} (${entry.runId}) expected prevHash ${expectedPrev}`,
      };
    }
    if (entryHash(body) !== hash) {
      return {
        ok: false,
        entries: entries.length,
        brokenAt: index,
        reason: `entry ${index} (${entry.runId}) content does not match its hash`,
      };
    }
    expectedPrev = hash;
  }
  return { ok: true, entries: entries.length, brokenAt: null, reason: null };
}

/** Most recent entry matching a predicate — e.g. the last recorded verdict. */
export function findLast(ledgerPath, predicate) {
  const entries = readLedger(ledgerPath);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index])) return entries[index];
  }
  return null;
}
