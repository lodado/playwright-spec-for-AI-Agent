import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveProjectPath, selectCase } from "../src/index.js";

const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "dc-cfg-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeConfig(dir: string, obj: unknown): string {
  const p = join(dir, "design-convergence.config.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const base = {
  $schema: "./schema.json",
  figma: { fileKey: "k" },
  execution: { allowProjectCode: false },
  cases: [
    {
      id: "pricing-desktop",
      route: "/pricing",
      viewport: { width: 1440, height: 900 },
      figmaRootNodeId: "1:2",
    },
  ],
};

describe("loadConfig", () => {
  it("loads and validates a JSON config, allowing $schema", () => {
    const dir = tmp();
    const loaded = loadConfig(writeConfig(dir, base));
    expect(loaded.config.cases[0]!.id).toBe("pricing-desktop");
    expect(loaded.rootDir).toBe(dir);
  });

  it("throws a configuration error on invalid JSON", () => {
    const dir = tmp();
    const p = join(dir, "design-convergence.config.json");
    writeFileSync(p, "{ not json");
    expect(() => loadConfig(p)).toThrow(/valid JSON/);
  });

  it("throws when the file is missing", () => {
    expect(() => loadConfig(join(tmp(), "nope.json"))).toThrow(/cannot read/);
  });

  it("rejects a prepare path that escapes the project root", () => {
    const dir = tmp();
    const cfg = {
      ...base,
      cases: [{ ...base.cases[0], prepare: "../evil.ts" }],
    };
    expect(() => loadConfig(writeConfig(dir, cfg))).toThrow(/escapes/);
  });

  it("resolves a project-relative prepare path inside root", () => {
    const dir = tmp();
    const cfg = {
      ...base,
      cases: [{ ...base.cases[0], prepare: "cases/prepare.ts" }],
    };
    const loaded = loadConfig(writeConfig(dir, cfg));
    expect(resolveProjectPath(loaded, "cases/prepare.ts")).toBe(
      join(dir, "cases/prepare.ts"),
    );
  });

  it("selectCase returns the matching case or throws naming available ids", () => {
    const loaded = loadConfig(writeConfig(tmp(), base));
    expect(selectCase(loaded, "pricing-desktop").id).toBe("pricing-desktop");
    expect(() => selectCase(loaded, "missing")).toThrow(/unknown case/);
  });
});
