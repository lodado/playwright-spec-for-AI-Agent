/**
 * Append-only, hash-chained run ledger (one JSONL file per page).
 *
 * Every agent invocation and verdict appends an entry whose hash covers the
 * previous entry's hash, so verdict history is tamper-evident: a re-run cannot
 * silently overwrite last night's fail, and a report can cite a runId instead
 * of restating a verdict word.
 */
import { createHash, randomUUID } from "node:crypto";
import { canonicalize } from "./spec-hash.mjs";

/**
 * @typedef {{ runId: string, at: string, kind: string, prevHash: string, hash: string, [field: string]: unknown }} LedgerEntry
 * @typedef {{ readFile: (path: string) => string,
 *             appendFile: (path: string, data: string) => void,
 *             exists: (path: string) => boolean }} LedgerIo
 */

export const LEDGER_GENESIS = "sha256:genesis";

export function newRunId() {
  return `run-${randomUUID().slice(0, 8)}`;
}

function entryHash(entry) {
  return `sha256:${createHash("sha256").update(canonicalize(entry), "utf8").digest("hex")}`;
}

/**
 * Read the ledger file through `io`. `torn` is the index of the first line that is
 * not a complete entry (unparsable, or the last line missing its newline), so a
 * cut line is detected rather than skipped; `entries` holds the well-formed ones.
 */
function scanLedger(ledgerPath, io) {
  if (!io.exists(ledgerPath)) return { entries: [], torn: null };
  const text = io.readFile(ledgerPath);
  const lines = text.split("\n");
  const unterminated = lines.pop() !== "";
  const entries = [];
  let torn = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      torn ??= entries.length;
    }
    if (torn !== null) break;
  }
  if (torn === null && unterminated) torn = entries.length;
  return { entries, torn };
}

/**
 * @param {string} ledgerPath
 * @param {{ io: LedgerIo }} options
 * @returns {Array<import("type-fest").ReadonlyDeep<LedgerEntry>>} every well-formed entry; malformed lines are skipped.
 */
export function readLedger(ledgerPath, { io }) {
  if (!io.exists(ledgerPath)) return [];
  return io
    .readFile(ledgerPath)
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

/**
 * @param {string} ledgerPath
 * @param {{ io: LedgerIo }} options
 */
export function lastEntry(ledgerPath, { io }) {
  const entries = readLedger(ledgerPath, { io });
  return entries.length ? entries[entries.length - 1] : null;
}

/**
 * Append one event. Returns the stored entry, including its runId and hash, so
 * the caller can cite it.
 *
 * @param {string} ledgerPath
 * @param {object} event — must carry at least { kind }
 * @param {{ now?: string, io: LedgerIo }} options
 */
export function appendRunEvent(ledgerPath, event, { now, io }) {
  // A cut line has no hash to link to; link to a marker no entry carries, so removing the cut line
  // later leaves its successor pointing at nothing and the chain breaks instead of restarting at genesis.
  const { torn } = scanLedger(ledgerPath, io);
  const previous = torn === null ? lastEntry(ledgerPath, { io }) : { hash: `sha256:torn-line-${torn}` };
  const body = {
    runId: event.runId ?? newRunId(),
    at: now ?? new Date().toISOString(),
    ...event,
    prevHash: previous?.hash ?? LEDGER_GENESIS,
  };
  const entry = { ...body, hash: entryHash(body) };
  io.appendFile(ledgerPath, `${JSON.stringify(entry)}\n`);
  return entry;
}

/**
 * Verify the chain end to end.
 *
 * @param {string} ledgerPath
 * @param {{ io: LedgerIo }} options
 * @returns {{ ok: boolean, entries: number, brokenAt: number|null, reason: string|null }}
 */
export function verifyLedger(ledgerPath, { io }) {
  const { entries, torn } = scanLedger(ledgerPath, io);
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
  if (torn !== null) {
    return {
      ok: false,
      entries: entries.length,
      brokenAt: torn,
      reason: `entry ${torn} is a cut or unterminated line`,
    };
  }
  return { ok: true, entries: entries.length, brokenAt: null, reason: null };
}

/**
 * Most recent entry matching a predicate — e.g. the last recorded verdict.
 *
 * @param {string} ledgerPath
 * @param {(entry: import("type-fest").ReadonlyDeep<LedgerEntry>) => boolean} predicate
 * @param {{ io: LedgerIo }} options
 */
export function findLast(ledgerPath, predicate, { io }) {
  const entries = readLedger(ledgerPath, { io });
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index])) return entries[index];
  }
  return null;
}
