// Regression coverage for scripts/node-io.mjs, the one node:fs / process.env port the command shells
// pass to the core modules. Risk: Low (thin adapter over existing, approved behavior); no Oracle card.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envValue, evidenceIo, ledgerIo, readFile, specDirIo } from "../node-io.mjs";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "node-io-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ledgerIo as the run ledger's file port", () => {
  it("to be the utf8 text of the file on readFile", () => {
    const file = join(dir, "ledger.jsonl");
    writeFileSync(file, "한글 line\n", "utf8");

    expect(ledgerIo.readFile(file)).toBe("한글 line\n");
  });

  it("to be the old text followed by the new text after appendFile", () => {
    const file = join(dir, "ledger.jsonl");
    writeFileSync(file, "first\n");

    ledgerIo.appendFile(file, "second\n");

    expect(readFileSync(file, "utf8")).toBe("first\nsecond\n");
  });

  it("to be a new file holding exactly the text when appendFile targets a missing path", () => {
    const file = join(dir, "new.jsonl");

    ledgerIo.appendFile(file, "only\n");

    expect(readFileSync(file, "utf8")).toBe("only\n");
  });

  it("to be true for an existing file and false for a missing one", () => {
    const file = join(dir, "here.jsonl");
    writeFileSync(file, "");

    expect(ledgerIo.exists(file)).toBe(true);
    expect(ledgerIo.exists(join(dir, "gone.jsonl"))).toBe(false);
  });
});

describe("evidenceIo as the evidence file port", () => {
  it("to be the utf8 text of the file on readText", () => {
    const file = join(dir, "aria.txt");
    writeFileSync(file, "- button \"저장\"");

    expect(evidenceIo.readText(file)).toBe('- button "저장"');
  });

  it("to be true for a non-empty readable file", () => {
    const file = join(dir, "shot.png");
    writeFileSync(file, "x");

    expect(evidenceIo.fileExists(file)).toBe(true);
  });

  it("to be false for an empty file", () => {
    const file = join(dir, "empty.png");
    writeFileSync(file, "");

    expect(evidenceIo.fileExists(file)).toBe(false);
  });

  it("to be false for a directory", () => {
    const sub = join(dir, "sub");
    mkdirSync(sub);

    expect(evidenceIo.fileExists(sub)).toBe(false);
  });

  it("to be false for a path that does not exist", () => {
    expect(evidenceIo.fileExists(join(dir, "gone.png"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("to be an EACCES error for a non-empty file without read permission", () => {
    const file = join(dir, "locked.png");
    writeFileSync(file, "x");
    chmodSync(file, 0o000);

    expect(() => evidenceIo.fileExists(file)).toThrow(/EACCES/);
  });
});

describe("specDirIo as the spec directory port", () => {
  it("to be the names of the directory entries on readdir", () => {
    writeFileSync(join(dir, "a.spec.ts"), "");
    writeFileSync(join(dir, "b.spec.ts"), "");

    expect([...specDirIo.readdir(dir)].sort()).toEqual(["a.spec.ts", "b.spec.ts"]);
  });

  it("to be the utf8 text of the file on readFile", () => {
    const file = join(dir, "a.spec.ts");
    writeFileSync(file, "// @qa-scenario: ACTIVE\n");

    expect(specDirIo.readFile(file)).toBe("// @qa-scenario: ACTIVE\n");
  });
});

describe("readFile as the spec hash file port", () => {
  it("to be the utf8 text of the file", () => {
    const file = join(dir, "spec.json");
    writeFileSync(file, '{"a":1}');

    expect(readFile(file)).toBe('{"a":1}');
  });
});

describe("envValue as the environment port", () => {
  const name = `NODE_IO_TEST_${process.pid}_VAR`;
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env[name];
  });
  afterEach(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });

  it("to be the value set in process.env", () => {
    process.env[name] = "from-env";

    expect(envValue(name)).toBe("from-env");
  });

  it("to be undefined when the variable is unset", () => {
    delete process.env[name];

    expect(envValue(name)).toBeUndefined();
  });
});
