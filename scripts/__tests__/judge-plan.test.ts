// Regression coverage for scripts/judge-plan.mjs (decideAuthMode, prepareJudgePlan, buildJudgePlan).
// Risk: Low (existing, approved behavior; expectations from docs/explanation/pipeline.md "The provenance
// chain" and the decideAuthMode contract); no Oracle card. Ports are in-memory stubs, no fs, no network.
import { describe, expect, it } from "vitest";
import { buildJudgePlan, decideAuthMode, prepareJudgePlan } from "../judge-plan.mjs";
import { hashSpecDefinition } from "../spec-hash.mjs";

const spec = {
  scenarios: [
    {
      scenarioId: "SCN_ACTIVE",
      sourceFile: "a.spec.ts",
      alwaysRun: false,
      tests: [
        { title: "Open the page", liveRunPolicy: "executable-readonly", stagingMode: "live" },
        { title: "Save a draft", liveRunPolicy: "executable-interaction", stagingMode: "live" },
      ],
    },
    {
      scenarioId: "SCN_TRIAL",
      sourceFile: "b.spec.ts",
      alwaysRun: false,
      tests: [{ title: "Upgrade banner", liveRunPolicy: "executable-readonly", stagingMode: "live" }],
    },
  ],
};

const readOnlySpec = {
  scenarios: [
    {
      scenarioId: "SCN_ACTIVE",
      sourceFile: "a.spec.ts",
      alwaysRun: false,
      tests: [{ title: "Open the page", liveRunPolicy: "executable-readonly", stagingMode: "live" }],
    },
  ],
};

function makePorts(resolved: unknown, calls: Record<string, unknown[]> = {}) {
  return {
    resolveSpecForJudge: () => resolved,
    buildStagingLogin: () => ({ loginUrl: "https://stage.example.com/login", email: "qa@example.com", password: "pw" }),
    loadSpecSourceFiles: () => ({}),
    buildUploadFixturesPayload: () => ({ defaults: {} }),
    inspectUploadFixtures: () => undefined,
    resolveFixturePaths: () => ({}),
    scopeSavedPlan: () => null,
    buildJudgeDocument: (args: unknown) => {
      (calls.document ??= []).push(args);
      return { document: "JUDGE DOCUMENT", planSource: "spec-live.json" };
    },
    buildQuery: (args: unknown) => {
      (calls.query ??= []).push(args);
      return "QUERY";
    },
  };
}

function baseInputs(overrides: Record<string, unknown> = {}) {
  return {
    page: "dashboard",
    targetUrl: "https://stage.example.com/dashboard",
    paths: { specJson: "unused" },
    config: { email: "qa@example.com", password: "pw" },
    adapter: { capabilities: { supportsMaxTurns: true } },
    preauthenticated: false,
    accountState: null,
    turnBudgetOverride: 40,
    ...overrides,
  };
}

describe("prepareJudgePlan as a live plan whose stamp matches the raw spec", () => {
  it("to be { plan, planMarkdown } with the raw-spec hash stamped on the first line", () => {
    const resolved = { path: "/p/spec-live.json", definition: spec, staleness: { ok: true, expected: "sha256:raw", actual: "sha256:raw" } };

    const result = prepareJudgePlan(baseInputs(), makePorts(resolved));

    expect("mismatch" in result).toBe(false);
    expect(result.plan.specHash).toBe("sha256:raw");
    expect(result.plan.specPath).toBe("/p/spec-live.json");
    expect(result.planMarkdown).toBe("<!-- specHash: sha256:raw -->\nJUDGE DOCUMENT");
  });
});

describe("prepareJudgePlan as a live plan whose stamp differs from the raw spec", () => {
  it("to be { mismatch } with expected and actual, returned not thrown", () => {
    const resolved = { path: "/p", definition: spec, staleness: { ok: false, expected: "sha256:old", actual: "sha256:new" } };

    const result = prepareJudgePlan(baseInputs(), makePorts(resolved));

    expect(result).toEqual({ mismatch: { expected: "sha256:old", actual: "sha256:new" } });
  });
});

describe("prepareJudgePlan as a live plan whose stamp cannot be established", () => {
  it("to be a plan stamped with the hash of the definition when the raw spec is absent", () => {
    const resolved = { path: "/p", definition: spec, staleness: { ok: true, expected: null, actual: null } };

    const result = prepareJudgePlan(baseInputs(), makePorts(resolved));

    expect("mismatch" in result).toBe(false);
    expect(result.plan.specHash).toBe(hashSpecDefinition(spec));
    expect(result.planMarkdown.split("\n")[0]).toBe(`<!-- specHash: ${hashSpecDefinition(spec)} -->`);
  });

  it("to be a plan for a legacy artifact with no sourceHash (expected null, raw hash known)", () => {
    const resolved = { path: "/p", definition: spec, staleness: { ok: true, expected: null, actual: "sha256:raw" } };

    const result = prepareJudgePlan(baseInputs(), makePorts(resolved));

    expect("mismatch" in result).toBe(false);
    expect(result.plan.specHash).toBe("sha256:raw");
  });
});

describe("prepareJudgePlan as a page with no spec JSON", () => {
  it("to be a UsageError (exit 2) naming the page and the spec command", () => {
    expect(() => prepareJudgePlan(baseInputs(), makePorts(null))).toThrow(
      expect.objectContaining({ name: expect.any(String), exitCode: 2, message: 'Missing qa spec JSON for page "dashboard".' }),
    );
  });
});

describe("buildJudgePlan as a small live spec with a read-write check", () => {
  const resolved = { path: "/p/spec-live.json", definition: spec, staleness: { ok: true, expected: "sha256:raw", actual: "sha256:raw" } };

  it("to be one planned check per test with the scenario, source file and policy", () => {
    const { plan } = buildJudgePlan({ ...baseInputs(), resolved } as never, makePorts(resolved));

    expect(plan.plannedChecks.map((check: any) => [check.item, check.scenarioId, check.sourceFile, check.liveRunPolicy])).toEqual([
      ["Open the page", "SCN_ACTIVE", "a.spec.ts", "executable-readonly"],
      ["Save a draft", "SCN_ACTIVE", "a.spec.ts", "executable-interaction"],
      ["Upgrade banner", "SCN_TRIAL", "b.spec.ts", "executable-readonly"],
    ]);
    expect(new Set(plan.plannedChecks.map((check: any) => check.checkId)).size).toBe(3);
    expect(plan.notApplicable).toEqual([]);
  });

  it("to be not read-only, with the override as the turn budget and the document handed to the query", () => {
    const calls: Record<string, unknown[]> = {};
    const { plan } = buildJudgePlan({ ...baseInputs(), resolved } as never, makePorts(resolved, calls));

    expect(plan.readOnly).toBe(false);
    expect(plan.maxTurns).toBe(40);
    expect(plan.query).toBe("QUERY");
    expect(plan.planSource).toBe("spec-live.json");
    expect(plan.secrets).toEqual(["qa@example.com", "pw"]);
    expect(plan.stagingLogin.targetUrl).toBe("https://stage.example.com/dashboard");
    expect((calls.query[0] as any).judgeDocument).toBe("JUDGE DOCUMENT");
  });

  it("to be a null turn budget when the adapter cannot cap its turns", () => {
    const adapter = { capabilities: { supportsMaxTurns: false } };
    const { plan } = buildJudgePlan({ ...baseInputs({ adapter }), resolved } as never, makePorts(resolved));

    expect(plan.maxTurns).toBeNull();
  });
});

describe("buildJudgePlan as a spec with only read-only checks", () => {
  it("to be read-only", () => {
    const resolved = { path: "/p", definition: readOnlySpec, staleness: { ok: true, expected: null, actual: "sha256:raw" } };

    const { plan } = buildJudgePlan({ ...baseInputs(), resolved } as never, makePorts(resolved));

    expect(plan.readOnly).toBe(true);
  });
});

describe("buildJudgePlan as a run on a pre-authenticated browser", () => {
  it("to be a plan whose staging login carries no email or password to the prompt", () => {
    const resolved = { path: "/p", definition: readOnlySpec, staleness: { ok: true, expected: null, actual: "sha256:raw" } };
    const calls: Record<string, unknown[]> = {};

    const { plan } = buildJudgePlan({ ...baseInputs({ preauthenticated: true }), resolved } as never, makePorts(resolved, calls));

    expect(plan.stagingLogin.email).toBe("");
    expect(plan.stagingLogin.password).toBe("");
    expect((calls.document[0] as any).stagingLogin.email).toBe("");
  });
});

describe("buildJudgePlan as a run settled in one account state", () => {
  it("to be only that state's checks, with the other scenarios listed as not applicable", () => {
    const resolved = { path: "/p", definition: spec, staleness: { ok: true, expected: null, actual: "sha256:raw" } };

    const { plan } = buildJudgePlan({ ...baseInputs({ accountState: "SCN_TRIAL" }), resolved } as never, makePorts(resolved));

    expect(plan.plannedChecks.map((check: any) => check.item)).toEqual(["Upgrade banner"]);
    expect(plan.notApplicable).toEqual(["SCN_ACTIVE"]);
  });
});

describe("decideAuthMode as the three adapter auth capabilities", () => {
  const base = { credentialsInPrompt: false, cloud: false, attachUrl: undefined, sessionProfile: false, seedable: false };

  it.each([
    ["cdp-attach with nothing to attach to", { auth: "cdp-attach" }, { requireCredentials: true, sessionCoversLogin: false }],
    ["cdp-attach with an attach URL", { auth: "cdp-attach", attachUrl: "http://127.0.0.1:9222" }, { requireCredentials: false, sessionCoversLogin: true }],
    ["cdp-attach on a cloud browser", { auth: "cdp-attach", cloud: true }, { requireCredentials: false, sessionCoversLogin: true }],
    ["cdp-attach with a session profile", { auth: "cdp-attach", sessionProfile: true }, { requireCredentials: false, sessionCoversLogin: true }],
    ["cdp-attach with a seedable page", { auth: "cdp-attach", seedable: true }, { requireCredentials: false, sessionCoversLogin: true }],
    ["self-prelogin on a page that needs a login", { auth: "self-prelogin" }, { requireCredentials: true, sessionCoversLogin: true }],
    ["self-prelogin on a seedable page", { auth: "self-prelogin", seedable: true }, { requireCredentials: false, sessionCoversLogin: true }],
    ["credentials-in-prompt", { auth: "credentials-in-prompt" }, { requireCredentials: true, sessionCoversLogin: false }],
    ["credentials-in-prompt on a seedable page", { auth: "credentials-in-prompt", seedable: true }, { requireCredentials: false, sessionCoversLogin: false }],
    ["--credentials-in-prompt forcing the legacy flow over an attachable cdp-attach", { auth: "cdp-attach", attachUrl: "http://127.0.0.1:9222", credentialsInPrompt: true }, { requireCredentials: true, sessionCoversLogin: false }],
    ["--credentials-in-prompt over self-prelogin on a seedable page", { auth: "self-prelogin", seedable: true, credentialsInPrompt: true }, { requireCredentials: true, sessionCoversLogin: false }],
  ])("to be the documented decision for %s", (_label, input, expected) => {
    expect(decideAuthMode({ ...base, ...input } as never)).toEqual(expected);
  });
});
