import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentOutputError,
  EnvironmentError,
  EXIT_AGENT_OUTPUT,
  EXIT_ENVIRONMENT,
  EXIT_USAGE,
  UsageError,
  formatQaError,
  runMain,
} from "../errors.mjs";
import {
  canonicalize,
  describeHashMismatch,
  hashJson,
  hashSpecDefinition,
  hashText,
  verifySourceHash,
} from "../spec-hash.mjs";
import {
  ARTIFACT_SCHEMA_VERSION,
  assertJudgmentShape,
  assertQaSpecShape,
  readArtifact,
  withSchema,
} from "../artifact-schema.mjs";
import {
  appendRunEvent,
  findLast,
  lastEntry,
  readLedger,
  verifyLedger,
} from "../qa-run-ledger.mjs";

const dirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "qa-foundations-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("error taxonomy", () => {
  it("assigns a distinct exit code per failure class", () => {
    expect(new UsageError("x").exitCode).toBe(EXIT_USAGE);
    expect(new EnvironmentError("x").exitCode).toBe(EXIT_ENVIRONMENT);
    expect(new AgentOutputError("x").exitCode).toBe(EXIT_AGENT_OUTPUT);
  });

  it("prints message plus hint for expected failures, stack for bugs", () => {
    const expected = new UsageError("Missing --page=", {
      hint: "Try --page=dashboard",
    });
    expect(formatQaError(expected)).toBe(
      "Missing --page=\n\nTry --page=dashboard",
    );
    expect(formatQaError(new TypeError("boom"))).toMatch(/TypeError: boom/);
  });

  it("runMain maps a thrown QaError to its exit code", async () => {
    await runMain(async () => {
      throw new EnvironmentError("hermes-agent not found");
    });
    expect(process.exitCode).toBe(EXIT_ENVIRONMENT);
  });

  it("runMain propagates a returned non-zero exit code", async () => {
    await runMain(async () => 1);
    expect(process.exitCode).toBe(1);
  });
});

describe("content hashing", () => {
  it("is stable across key order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(hashJson({ b: [1, { d: 4, c: 3 }] })).toBe(
      hashJson({ b: [1, { c: 3, d: 4 }] }),
    );
  });

  it("changes when content changes", () => {
    expect(hashText("a")).not.toBe(hashText("b"));
  });

  it("ignores stage stamps so an unchanged spec keeps its hash", () => {
    const base = { scenarios: [{ scenarioId: "ACTIVE" }] };
    expect(
      hashSpecDefinition({ ...base, generatedAt: "2026-01-01", sourceHash: "x" }),
    ).toBe(hashSpecDefinition(base));
  });

  it("detects a stale downstream artifact", () => {
    const fresh = verifySourceHash({ sourceHash: "sha256:aaa" }, "sha256:aaa");
    const stale = verifySourceHash({ sourceHash: "sha256:aaa" }, "sha256:bbb");
    expect(fresh.ok).toBe(true);
    expect(stale.ok).toBe(false);
    expect(
      describeHashMismatch({ ...stale, producer: "spec", consumer: "judge" }),
    ).toMatch(/stale/);
  });

  it("treats an unstamped artifact as unverifiable, not mismatched", () => {
    expect(verifySourceHash({}, "sha256:aaa").ok).toBe(true);
  });
});

describe("artifact shape contract", () => {
  it("stamps schemaVersion and kind", () => {
    expect(withSchema({ status: "pass" }, "judgment")).toMatchObject({
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      artifactKind: "judgment",
      status: "pass",
    });
  });

  it("rejects a malformed spec with an actionable message", () => {
    expect(() => assertQaSpecShape({ scenarios: "nope" }, "/tmp/x.json")).toThrow(
      /`scenarios` must be an array/,
    );
    expect(() => assertQaSpecShape(null, "/tmp/x.json")).toThrow(UsageError);
  });

  it("classifies malformed agent output as an agent-output failure", () => {
    expect(() => assertJudgmentShape({ status: 5 }, "/tmp/j.json")).toThrow(
      AgentOutputError,
    );
  });

  it("refuses an artifact written by a newer schema version", () => {
    const dir = tempDir();
    const path = join(dir, "j.json");
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION + 1, status: "pass" }),
    );
    expect(() => readArtifact(path, { kind: "judgment" })).toThrow(
      /newer version/,
    );
  });

  it("reports invalid JSON with the file path", () => {
    const dir = tempDir();
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json");
    expect(() => readArtifact(path)).toThrow(/invalid JSON/);
  });
});

describe("hash-chained run ledger", () => {
  it("chains entries and verifies clean", () => {
    const ledger = join(tempDir(), "runs.jsonl");
    const first = appendRunEvent(ledger, { kind: "judge", status: "pass" });
    const second = appendRunEvent(ledger, { kind: "review", status: "flagged" });

    expect(second.prevHash).toBe(first.hash);
    expect(readLedger(ledger)).toHaveLength(2);
    expect(verifyLedger(ledger)).toMatchObject({ ok: true, entries: 2 });
  });

  it("detects tampering with a recorded verdict", () => {
    const ledger = join(tempDir(), "runs.jsonl");
    const kept = appendRunEvent(ledger, { kind: "judge", status: "fail" });
    appendRunEvent(ledger, { kind: "judge", status: "fail" });

    const entries = readLedger(ledger);
    entries[0] = { ...entries[0], status: "pass" };
    writeFileSync(
      ledger,
      `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`,
    );

    const result = verifyLedger(ledger);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(0);
    expect(kept.status).toBe("fail");
  });

  it("finds the last matching entry and tolerates an empty ledger", () => {
    const ledger = join(tempDir(), "runs.jsonl");
    expect(readLedger(ledger)).toEqual([]);
    expect(lastEntry(ledger)).toBeNull();
    expect(verifyLedger(ledger).ok).toBe(true);

    appendRunEvent(ledger, { kind: "judge", status: "pass" });
    appendRunEvent(ledger, { kind: "slack", status: "sent" });
    expect(findLast(ledger, entry => entry.kind === "judge")).toMatchObject({
      status: "pass",
    });
  });
});
