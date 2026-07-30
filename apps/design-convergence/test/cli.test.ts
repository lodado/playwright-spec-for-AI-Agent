import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main.js";

const dirs: string[] = [];

function tmpConfig(obj: unknown): string {
  const d = mkdtempSync(join(tmpdir(), "dc-cli-"));
  dirs.push(d);
  const p = join(d, "design-convergence.config.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
  };
}

const validConfig = {
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

describe("main", () => {
  it("prints help and exits 2 with no command", async () => {
    const c = capture();
    expect(await main([], c.io)).toBe(2);
    expect(c.out.join("\n")).toContain("design-convergence <command>");
  });

  it("rejects an unknown command with exit 2", async () => {
    const c = capture();
    expect(await main(["bogus"], c.io)).toBe(2);
    expect(c.err.join("\n")).toContain("unknown command");
  });

  it("rejects an unknown option with exit 2", async () => {
    const c = capture();
    expect(await main(["run", "--nope"], c.io)).toBe(2);
  });

  it("requires --case for run", async () => {
    const c = capture();
    expect(await main(["run", "--config", tmpConfig(validConfig)], c.io)).toBe(
      2,
    );
    expect(c.err.join("\n")).toContain("--case");
  });

  it("selects a valid case and exits 0 without starting a runtime", async () => {
    const c = capture();
    const code = await main(
      ["run", "--case", "pricing-desktop", "--config", tmpConfig(validConfig)],
      c.io,
    );
    expect(code).toBe(0);
    expect(c.out.join("\n")).toContain("selected case pricing-desktop");
    expect(c.out.join("\n")).toContain("no app or browser started");
  });

  it("exits 2 for an unknown case id, listing available ids in JSON", async () => {
    const c = capture();
    const code = await main(
      [
        "run",
        "--case",
        "missing",
        "--config",
        tmpConfig(validConfig),
        "--json",
      ],
      c.io,
    );
    expect(code).toBe(2);
    const line = c.err.find((l) => l.includes("unknown case"))!;
    const parsed = JSON.parse(line) as { available: string[] };
    expect(parsed.available).toEqual(["pricing-desktop"]);
  });

  it("exits 2 for an invalid config", async () => {
    const c = capture();
    const bad = { ...validConfig, cases: [] };
    expect(
      await main(["run", "--case", "x", "--config", tmpConfig(bad)], c.io),
    ).toBe(2);
  });
});
