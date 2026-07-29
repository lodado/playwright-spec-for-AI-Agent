import assert from "node:assert/strict";
import test from "node:test";
import { assertHermesStudySupported, createHermesActionPolicy } from "../src/hermes-action-policy.mjs";

const study = {
  environment: {
    baseUrl: "http://127.0.0.1:4173",
    fixtures: { email: "private@example.test" },
  },
  runtime: { concurrency: 1 },
  evidence: { semanticSnapshot: "every_action" },
};
const task = {
  id: "signup",
  goal: "Create an account",
  context: "Use the visible form",
  safetyPolicy: { allowClick: true, allowTyping: true, allowNavigation: true },
  maxActions: 5,
  maxDurationMs: 60_000,
  abandonmentAllowed: true,
};
const entry = { study, task, persona: { preset: "impatient_new_user" }, seed: 101 };

function input() {
  return {
    study,
    task,
    persona: entry.persona,
    session: { startedAt: new Date(0).toISOString() },
    observation: {
      page: { url: "https://user:password@example.test/signup?token=secret#private" },
      semantic: {
        visibleText: ["Create account", "Signed in as private@example.test"],
        headings: [{ role: "heading", name: "Sign up", fingerprint: "raw-fingerprint" }],
        landmarks: [],
        interactiveElements: [{ id: "email-field", role: "textbox", name: "Email", enabled: true, fingerprint: "raw-selector" }],
      },
    },
    events: [],
  };
}

test("Hermes chooses from bounded semantic input and records digest-only attempts", async () => {
  const calls = [];
  const policy = createHermesActionPolicy(entry, {
    model: "test-model",
    now: () => 1_000,
    transport(prompt, maxTurns, options) {
      calls.push({ prompt, maxTurns, options });
      return { action: { type: "type", elementId: "email-field", valueRef: "email" } };
    },
  });
  const decision = await policy.decide(input());

  assert.deepEqual(decision.action, { type: "type", elementId: "email-field", valueRef: "email", reasonCode: "hermes_selected" });
  assert.equal(calls[0].maxTurns, 1);
  assert.equal(calls[0].options.mode, "text-only");
  assert.ok(calls[0].options.timeoutMs <= 30_000);
  assert.match(calls[0].prompt, /"route":"\/signup"/);
  for (const forbidden of ["private@example.test", "password", "token=secret", "raw-fingerprint", "raw-selector", "successOracles"]) {
    assert.equal(calls[0].prompt.includes(forbidden), false);
  }
  assert.deepEqual(decision.attempts.map(item => item.outcomeCode), ["MODEL_ACTION_ACCEPTED"]);
  assert.equal(JSON.stringify(decision.attempts).includes(calls[0].prompt), false);
});

test("Hermes may voluntarily finish or abandon the session", async () => {
  for (const type of ["finish", "abandon"]) {
    const policy = createHermesActionPolicy(entry, {
      model: "test-model",
      now: () => 1_000,
      transport: () => ({ action: { type } }),
    });
    const decision = await policy.decide(input());
    assert.deepEqual(decision.action, { type, reasonCode: "hermes_selected" });
  }
});

test("abandon is rejected when the task forbids abandonment", async () => {
  const policy = createHermesActionPolicy(entry, {
    model: "test-model",
    now: () => 1_000,
    transport: () => ({ action: { type: "abandon" } }),
  });
  const strictInput = { ...input(), task: { ...task, abandonmentAllowed: false } };
  await assert.rejects(() => policy.decide(strictInput), error => error.code === "MODEL_INVALID_OUTPUT");
});

test("invalid output gets one schema-only repair and never deterministic fallback", async () => {
  const prompts = [];
  const policy = createHermesActionPolicy(entry, {
    model: "test-model",
    now: () => 1_000,
    transport(prompt) {
      prompts.push(prompt);
      return { action: { type: "select", elementId: "email-field", value: "secret" } };
    },
  });

  await assert.rejects(() => policy.decide(input()), error => {
    assert.equal(error.code, "MODEL_INVALID_OUTPUT");
    assert.equal(error.modelAttempts.length, 2);
    return true;
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /repair the format once/i);
  assert.equal(prompts[1].includes("secret\""), false);
});

test("timeout and provider failures do not retry", async () => {
  for (const [sourceCode, expected] of [["ETIMEDOUT", "MODEL_TIMEOUT"], ["ECONNRESET", "MODEL_PROVIDER_FAILED"]]) {
    let calls = 0;
    const policy = createHermesActionPolicy(entry, {
      model: "test-model",
      now: () => 1_000,
      transport() {
        calls += 1;
        throw Object.assign(new Error("unsafe provider detail"), { code: sourceCode });
      },
    });
    await assert.rejects(() => policy.decide(input()), error => error.code === expected && !error.message.includes("unsafe provider detail"));
    assert.equal(calls, 1);
  }
});

test("Hermes preflight keeps execution serial and semantic while allowing driver-owned authentication", () => {
  assert.doesNotThrow(() => assertHermesStudySupported(study));
  assert.throws(() => assertHermesStudySupported({ ...study, runtime: { concurrency: 2 } }), /concurrency/);
  assert.throws(() => assertHermesStudySupported({ ...study, evidence: { semanticSnapshot: "off" } }), /semanticSnapshot/);
  assert.doesNotThrow(() => assertHermesStudySupported({ ...study, environment: { ...study.environment, auth: { token: "x" }, storageStatePath: ".private/session.json", baseUrl: "https://example.test" } }));
});
