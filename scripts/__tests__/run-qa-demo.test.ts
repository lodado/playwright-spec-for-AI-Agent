import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSpecDirectory } from "../spec-annotation-reader.mjs";
import {
  loadProjectConfig,
  resetProjectConfigForTests,
} from "../hermes-qa-project-config.mjs";
import { parseDemoArgs, startDemoServer } from "../run-qa-demo.mjs";

const DEMO_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
  "demo-app"
);

beforeEach(async () => {
  resetProjectConfigForTests();
  await loadProjectConfig([`--project-root=${DEMO_DIR}`]);
});

afterEach(() => {
  resetProjectConfigForTests();
});

describe("demo app", () => {
  it("ships an HTML page with the widgets the spec checks", () => {
    const html = readFileSync(join(DEMO_DIR, "index.html"), "utf8");

    for (const testId of ["plan-name", "health-score", "plan-details-btn", "login-form"]) {
      expect(html).toContain(`data-testid="${testId}"`);
    }
  });

  it("parses into a QA spec with the annotated policies", () => {
    const spec = parseSpecDirectory(DEMO_DIR);

    expect(spec.scenarios).toHaveLength(1);
    const [scenario] = spec.scenarios;
    expect(scenario.scenarioId).toBe("ACTIVE");
    expect(scenario.page).toBe("demo");
    expect(scenario.tests.map((test: any) => test.liveRunPolicy)).toEqual([
      "executable-readonly",
      "executable-readonly",
      "executable-interaction",
      "blocked-auth-mock",
    ]);
  });

  it("ships an abstract-ai fixture whose plan names every live test", () => {
    const { livePlan } = JSON.parse(
      readFileSync(join(DEMO_DIR, "fixtures", "abstract.json"), "utf8")
    );
    const spec = parseSpecDirectory(DEMO_DIR);

    for (const test of spec.scenarios[0].tests) {
      if (test.liveRunPolicy === "blocked-auth-mock") continue;
      expect(livePlan).toContain(test.title);
    }
    // Every readonly block must carry the `mutations: 0` clause the
    // abstraction validator requires, or `demo` fails at abstract-ai.
    expect(livePlan.match(/mutations: 0/g)).toHaveLength(2);
  });

  it("serves the page on an ephemeral port and closes cleanly", async () => {
    const server = await startDemoServer();
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(`${server.url}/dashboard`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('data-testid="plan-name"');
    } finally {
      await server.close();
    }
    await expect(fetch(`${server.url}/dashboard`)).rejects.toThrow();
  });
});

describe("parseDemoArgs", () => {
  it("keeps the output directory whenever the caller named one", () => {
    expect(parseDemoArgs([]).keep).toBe(false);
    expect(parseDemoArgs(["--keep"]).keep).toBe(true);
    const parsed = parseDemoArgs(["--out=./demo-out"]);
    expect(parsed.keep).toBe(true);
    expect(existsSync(dirname(parsed.out))).toBe(true);
  });
});
