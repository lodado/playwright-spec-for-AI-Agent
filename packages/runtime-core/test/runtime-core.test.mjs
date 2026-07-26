import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileSessionStore,
  evaluateSealedSession,
  markSessionReported,
  removeFileSessionStore,
  runSession,
  runStudy,
} from "../src/index.mjs";

const study = Object.freeze({
  schemaVersion: "study-spec/0.1",
  study: { id: "study-1", name: "Study" },
  environment: { baseUrl: "http://127.0.0.1:4173", allowedOrigins: ["http://127.0.0.1:4173"], viewport: { width: 390, height: 844 } },
  tasks: [task("task-1")],
  personas: [{ id: "persona-1", name: "Persona" }],
  runtime: { seeds: [101], concurrency: 1 },
});

function task(id) {
  return {
    id,
    name: id,
    goal: "finish",
    successOracles: [],
    safetyPolicy: { allowClick: true, allowTyping: true },
    maxActions: 5,
    maxDurationMs: 60_000,
    maxConsecutiveNoProgressActions: 2,
    abandonmentAllowed: true,
  };
}

test("runs one observation per action and seals evidence after closing the driver", async () => {
  const order = [];
  const driver = fakeDriver({ order, successAfterObserve: 2 });
  const rootDir = await mkdtemp(join(tmpdir(), "runtime-core-"));
  const result = await runSession({
    study,
    task: study.tasks[0],
    persona: study.personas[0],
    seed: 101,
    runId: "run-1",
    sessionId: "session-1",
    driver,
    policy: { sampledPolicy: { preset: "fake" }, decide: () => ({ type: "click", elementId: "el-1", reasonCode: "primary_action_match" }) },
    oracle: { evaluate: ({ observation }) => ({ definitiveSuccess: observation.sequence === 1 }) },
    store: orderedFileStore({ rootDir, sessionId: "session-1", order }),
  });

  assert.equal(result.session.phase, "EVIDENCE_SEALED");
  assert.equal(result.session.status, "success");
  assert.equal(result.session.evidenceManifestId, "manifest-session-1");
  assert.deepEqual(result.events.map((event) => event.observationId), ["observation-session-1-0"]);
  assert.equal(result.observations.length, 2);
  assert.ok(order.indexOf("close") < order.indexOf("seal"));
  const eventsJsonl = await readFile(join(rootDir, "sessions/session-1/events.jsonl"), "utf8");
  assert.equal(eventsJsonl.trim().split("\n").length, 1);
  await removeFileSessionStore(rootDir);
});

test("evaluation and reporting only advance after evidence is sealed", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "runtime-core-"));
  const sessionResult = await runSession({
    study,
    task: study.tasks[0],
    persona: study.personas[0],
    seed: 101,
    runId: "run-2",
    sessionId: "session-2",
    driver: fakeDriver({ successAfterObserve: 1 }),
    policy: { decide: () => ({ type: "finish", reasonCode: "done" }) },
    oracle: { evaluate: () => ({ definitiveSuccess: true }) },
    store: createFileSessionStore({ rootDir, sessionId: "session-2" }),
  });

  const evaluated = await evaluateSealedSession({
    sessionResult,
    evaluator: { evaluate: () => ({ status: "success" }) },
    store: createFileSessionStore({ rootDir, sessionId: "session-2" }),
  });
  const reported = await markSessionReported({
    evaluatedSessionResult: evaluated,
    reporterResult: { path: "reports/report.html" },
    store: createFileSessionStore({ rootDir, sessionId: "session-2" }),
  });

  assert.equal(evaluated.session.phase, "EVALUATED");
  assert.equal(reported.session.phase, "REPORTED");
  await removeFileSessionStore(rootDir);
});

test("action budget exhaustion becomes runtime_error instead of false pass", async () => {
  const limitedTask = { ...study.tasks[0], maxActions: 1 };
  const result = await runSession({
    study: { ...study, tasks: [limitedTask] },
    task: limitedTask,
    persona: study.personas[0],
    seed: 101,
    runId: "run-3",
    sessionId: "session-3",
    driver: fakeDriver({ successAfterObserve: 99 }),
    policy: { decide: () => ({ type: "click", elementId: "el-1", reasonCode: "try" }) },
    oracle: { evaluate: () => ({}) },
    store: memoryStore(),
  });

  assert.equal(result.session.phase, "EVIDENCE_SEALED");
  assert.equal(result.session.transitions.some((transition) => transition.phase === "RUNTIME_ERROR"), true);
  assert.equal(result.session.terminalReason.code, "ACTION_BUDGET_EXHAUSTED");
});

test("policy cannot act on an element that was not in the current observation", async () => {
  const result = await runSession({
    study,
    task: study.tasks[0],
    persona: study.personas[0],
    seed: 101,
    runId: "run-4",
    sessionId: "session-4",
    driver: fakeDriver({ successAfterObserve: 99 }),
    policy: { decide: () => ({ type: "click", elementId: "hidden-el", reasonCode: "dom_search" }) },
    oracle: { evaluate: () => ({}) },
    store: memoryStore(),
  });

  assert.equal(result.session.terminalReason.code, "ACTION_NOT_ALLOWED");
  assert.equal(result.events.length, 0);
});

test("runStudy schedules the task/persona/seed matrix with bounded concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const matrixStudy = {
    ...study,
    tasks: [task("task-a"), task("task-b")],
    personas: [{ id: "p1" }, { id: "p2" }],
    runtime: { seeds: [1, 2], concurrency: 2 },
  };

  const result = await runStudy({
    study: matrixStudy,
    driverFactory: () => fakeDriver({
      successAfterObserve: 1,
      asyncStart: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      asyncClose: async () => {
        active -= 1;
      },
    }),
    policyFactory: () => ({ decide: () => ({ type: "finish", reasonCode: "done" }) }),
    oracle: { evaluate: () => ({ definitiveSuccess: true }) },
    storeFactory: () => memoryStore(),
  });

  assert.equal(result.sessionCount, 8);
  assert.equal(maxActive <= 2, true);
  assert.equal(result.results.every((item) => item.session.phase === "EVIDENCE_SEALED"), true);
});

test("aborted signal stops scheduling new sessions", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runStudy({
      study: { ...study, runtime: { seeds: [1, 2], concurrency: 1 } },
      driverFactory: () => fakeDriver({ successAfterObserve: 1 }),
      policyFactory: () => ({ decide: () => ({ type: "finish", reasonCode: "done" }) }),
      oracle: { evaluate: () => ({}) },
      storeFactory: () => memoryStore(),
      signal: controller.signal,
    }),
    /cancelled/,
  );
});

function fakeDriver({ order = [], successAfterObserve = 1, asyncStart, asyncClose } = {}) {
  let observes = 0;
  return {
    async start() {
      order.push("start");
      await asyncStart?.();
      return { id: `handle-${Math.random()}` };
    },
    async observe() {
      order.push("observe");
      const sequence = observes;
      observes += 1;
      return {
        page: { url: `http://127.0.0.1:4173/${sequence}`, title: "Fixture", viewport: { width: 390, height: 844 } },
        semantic: { visibleText: [], headings: [], landmarks: [], interactiveElements: sequence < successAfterObserve ? [{ id: "el-1", role: "button", name: "Continue" }] : [] },
      };
    },
    async execute() {
      order.push("execute");
      return { status: "success", urlAfter: "http://127.0.0.1:4173/next", evidenceIds: ["ev-action"], progressChanged: true };
    },
    async close() {
      order.push("close");
      await asyncClose?.();
    },
  };
}

function memoryStore() {
  const calls = [];
  return {
    calls,
    async saveSession(session) {
      calls.push(["session", session.phase]);
    },
    async appendObservation(observation) {
      calls.push(["observation", observation.id]);
    },
    async appendEvent(event) {
      calls.push(["event", event.id]);
    },
    async sealManifest(manifest) {
      calls.push(["manifest", manifest.id]);
    },
  };
}

function orderedFileStore({ rootDir, sessionId, order }) {
  const store = createFileSessionStore({ rootDir, sessionId });
  return {
    ...store,
    async sealManifest(manifest) {
      order.push("seal");
      await store.sealManifest(manifest);
    },
  };
}
