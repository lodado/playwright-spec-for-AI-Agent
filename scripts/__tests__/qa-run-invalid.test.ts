import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRunNotInvalid,
  clearRunInvalid,
  markRunInvalid,
} from "../qa-run-invalid.mjs";

const dirs: string[] = [];

function makePaths() {
  const dir = mkdtempSync(join(tmpdir(), "qa-run-invalid-"));
  dirs.push(dir);
  return { runInvalidMarker: join(dir, "dashboard-qa-run.invalid") };
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("failed-run quarantine", () => {
  it("marks a run invalid with reason and timestamp", () => {
    const paths = makePaths();
    markRunInvalid(paths, "hermes crashed");

    const body = JSON.parse(readFileSync(paths.runInvalidMarker, "utf8"));
    expect(body.reason).toBe("hermes crashed");
    expect(body.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses downstream commands while the marker exists", () => {
    const paths = makePaths();
    markRunInvalid(paths, "boom");

    expect(() => assertRunNotInvalid(paths, "review")).toThrow(/quarantined/);
    expect(() => assertRunNotInvalid(paths, "review")).toThrow(
      /Re-run `judge`/,
    );
  });

  it("allows downstream commands after the marker is cleared", () => {
    const paths = makePaths();
    markRunInvalid(paths, "boom");
    clearRunInvalid(paths);

    expect(existsSync(paths.runInvalidMarker)).toBe(false);
    expect(() => assertRunNotInvalid(paths, "review")).not.toThrow();
  });

  it("is a no-op to clear when no marker exists", () => {
    const paths = makePaths();
    expect(() => clearRunInvalid(paths)).not.toThrow();
  });
});
