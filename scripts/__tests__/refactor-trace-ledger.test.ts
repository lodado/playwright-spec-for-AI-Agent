// Oracle refactor-modularity, row O6 (P6): the run ledger core over a temp file. The core receives its
// file access as `io = { readFile, appendFile, exists }` (card layout, T2); the io here is node:fs over a
// temp dir, so the same assertions hold before and after the injection. Expected values restate S8 and
// Q11 a: a cut line breaks the chain wherever it sits, also after a later append fused into it, while
// dropping whole trailing entries verifies (residual risk).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendRunEvent, LEDGER_GENESIS, verifyLedger } from "../qa-run-ledger.mjs";
import { FIXED_NOW, makeLedgerFile, makeTempDir, nodeIo, removeDir } from "./refactor-trace-fixtures.mjs";

let dir: string;
let ledger: ReturnType<typeof makeLedgerFile>;

function append(times: number) {
  for (let index = 0; index < times; index += 1) {
    appendRunEvent(
      ledger.path,
      { kind: "trace-event", runId: `run-${ledger.lineCount() + 1}` },
      { now: FIXED_NOW, io: nodeIo },
    );
    ledger.recordAppend();
  }
}

const verify = () => verifyLedger(ledger.path, { io: nodeIo });

beforeEach(() => {
  dir = makeTempDir("refactor-trace-ledger-test");
  ledger = makeLedgerFile(dir);
});

afterEach(() => removeDir(dir));

describe("verifyLedger as a ledger built by appends alone", () => {
  it("to be intact with 0 entries for a file that does not exist yet", () => {
    expect(verify()).toEqual({ ok: true, entries: 0, brokenAt: null, reason: null });
  });

  it.each([1, 2, 5])("to be intact with exactly %i entries after that many appends", count => {
    append(count);

    expect(verify()).toEqual({ ok: true, entries: count, brokenAt: null, reason: null });
    expect(ledger.text().split("\n").filter(Boolean)).toHaveLength(count);
  });

  it("to be a first entry that links to sha256:genesis and a second that links to the first hash", () => {
    append(2);

    const [first, second] = ledger.text().split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(first.prevHash).toBe(LEDGER_GENESIS);
    expect(second.prevHash).toBe(first.hash);
  });
});

describe("verifyLedger as a ledger edited after the fact", () => {
  it.each([1, 3])("to be broken at entry 0 after the first of %i entries was edited", count => {
    append(count);
    ledger.editFirst();

    expect(verify()).toMatchObject({ ok: false, entries: count, brokenAt: 0 });
  });

  it.each([2, 3])("to be broken at entry 0 after the first of %i entries was removed (it had a successor)", count => {
    append(count);
    ledger.removeFirst();

    expect(verify()).toMatchObject({ ok: false, entries: count - 1, brokenAt: 0 });
  });
});

describe("verifyLedger as a last line cut part-way (Q11 a)", () => {
  it.each([
    [0, 1],
    [1, 2],
    [2, 3],
  ])("to be broken at entry %i when the last of %i entries is cut", (brokenAt, count) => {
    append(count);
    ledger.tearLast();

    expect(verify()).toMatchObject({ ok: false, brokenAt });
  });

  it.each([
    [0, 1],
    [1, 2],
  ])("to be broken at entry %i when an append fused into the cut last of %i entries", (brokenAt, count) => {
    append(count);
    ledger.tearLast();
    append(1);

    // the append joined the cut line: still `count` physical lines, so no line count reveals it
    expect(ledger.text().split("\n").filter(Boolean)).toHaveLength(count);
    expect(verify()).toMatchObject({ ok: false, brokenAt });
  });
});

describe("verifyLedger as whole trailing entries dropped (residual risk of Q11 a)", () => {
  it("to be intact with 2 entries after the last of 3 was dropped", () => {
    append(3);
    ledger.dropLast();

    expect(verify()).toEqual({ ok: true, entries: 2, brokenAt: null, reason: null });
  });

  it("to be intact with 0 entries after the only entry was dropped", () => {
    append(1);
    ledger.dropLast();

    expect(verify()).toEqual({ ok: true, entries: 0, brokenAt: null, reason: null });
  });
});

describe("appendRunEvent as an append onto a verified chain", () => {
  it.each([
    [2, 1],
    [3, 2],
    [5, 4],
  ])("to be a chain that still verifies with %i entries after one append onto %i", (after, before) => {
    append(before);
    expect(verify().ok).toBe(true);

    append(1);

    expect(verify()).toEqual({ ok: true, entries: after, brokenAt: null, reason: null });
  });
});
