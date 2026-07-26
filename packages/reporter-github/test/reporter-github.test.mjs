import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyReporterOutcome,
  createGitHubCliTransport,
  markerLine,
  publishBehavioralGitHubReport,
  renderBehavioralPrComment,
} from "../src/index.mjs";

test("maps product, manual, warning, and infrastructure outcomes to GitHub conclusions", () => {
  assert.deepEqual(classifyReporterOutcome({ findings: [] }), { kind: "product", conclusion: "success", summary: "No blocking behavioral regression detected" });
  assert.equal(classifyReporterOutcome({ findings: [criticalBehavioral()] }).conclusion, "failure");
  assert.equal(classifyReporterOutcome({ findings: [{ ...criticalBehavioral(), confidence: { overall: "medium" } }], sampleCount: 1 }).conclusion, "neutral");
  assert.equal(classifyReporterOutcome({ comparisonStatus: "unstable" }).conclusion, "action_required");
  assert.equal(classifyReporterOutcome({ comparisonStatus: "baseline_better" }).conclusion, "neutral");
  assert.deepEqual(classifyReporterOutcome({ runtimeError: { code: "MODEL_TIMEOUT", message: "model timed out" } }), { kind: "infrastructure", conclusion: "neutral", summary: "model timed out" });
  assert.equal(classifyReporterOutcome({ runtimeError: { code: "BROWSER_START_FAILED" }, releaseGate: { infrastructureFailureConclusion: "failure" } }).conclusion, "failure");
});

test("renders one marker-scoped PR comment with sanitized findings and artifact links", () => {
  const body = renderBehavioralPrComment({
    studyId: "signup-flow",
    outcome: { kind: "product", conclusion: "neutral", summary: "Needs @org/team review <!-- injected -->" },
    comparisonReport: { status: "baseline_better", delta: { completionDelta: -0.3, abandonmentDelta: 0.2, medianActionDelta: 5 } },
    findings: [{ ...criticalBehavioral(), title: "CTA hidden ![x](https://attacker.test/x.png) @org/team" }],
    artifactLinks: [{ label: "HTML report", url: "https://github.com/owner/repo/actions/runs/1?token=secret#log" }],
  });
  assert.match(body, new RegExp(`^${escapeRegExp(markerLine("signup-flow"))}`));
  assert.match(body, /Result:\*\* Neutral/);
  assert.match(body, /baseline_better/);
  assert.doesNotMatch(body, /<!-- injected -->|!\[x\]|@org\/team|#log|token=secret/);
  assert.match(body, /https:\/\/github.com\/owner\/repo\/actions\/runs\/1/);
});

test("publishes by updating the existing marker comment and creating a bounded Check", async () => {
  const calls = [];
  const transport = {
    async findPrComment(input) { calls.push(["find", input]); return { id: 12, body: `${markerLine("signup-flow")}\nold` }; },
    async updatePrComment(input) { calls.push(["update", input]); return { id: input.commentId, url: "https://github.com/owner/repo/issues/7#issuecomment-12" }; },
    async createPrComment(input) { calls.push(["create", input]); return { id: 13, url: "https://github.com/owner/repo/issues/7#issuecomment-13" }; },
    async createCheckRun(input) { calls.push(["check", input]); return { id: 99, conclusion: input.conclusion }; },
  };
  const result = await publishBehavioralGitHubReport({
    repository: "owner/repo",
    prNumber: 7,
    headSha: "a".repeat(40),
    studyId: "signup-flow",
    comparisonReport: { status: "candidate_better" },
    findings: [],
    runUrl: "https://github.com/owner/repo/actions/runs/1",
    transport,
  });
  assert.equal(result.action, "UPDATED");
  assert.equal(result.outcome.conclusion, "success");
  assert.deepEqual(calls.map(([name]) => name), ["find", "update", "check"]);
  assert.match(calls[1][1].body, /^<!-- persona-runtime-check: study=signup-flow -->/);
});

test("GitHub CLI transport uses bounded gh payloads, safe env, and marker idempotency", async () => {
  process.env.QA_NATIVE_PUBLICATION_KEY = "secret";
  process.env.GITHUB_TOKEN = "token";
  const marker = markerLine("signup-flow");
  const spawn = mockSpawn([
    [{ id: 4, html_url: "https://github.com/owner/repo/issues/7#issuecomment-4", body: `${marker}\nold`, user: { login: "bot" } }],
    { id: 4, html_url: "https://github.com/owner/repo/issues/7#issuecomment-4", body: `${marker}\nnew` },
    { id: 88, conclusion: "neutral", html_url: "https://github.com/owner/repo/runs/88" },
  ]);
  const transport = createGitHubCliTransport({ spawn, botLogin: "bot" });
  assert.equal((await transport.findPrComment({ repository: "owner/repo", prNumber: 7, studyId: "signup-flow" })).id, 4);
  await transport.updatePrComment({ repository: "owner/repo", commentId: 4, body: `${marker}\nnew` });
  await transport.createCheckRun({ repository: "owner/repo", headSha: "a".repeat(40), conclusion: "neutral", summary: "ok", detailsUrl: "https://github.com/owner/repo/actions/runs/1" });
  assert.equal(spawn.mock.calls.length, 3);
  assert.equal(spawn.mock.calls[1][0], "gh");
  assert.deepEqual(JSON.parse(spawn.mock.calls[1][2].input), { body: `${marker}\nnew` });
  assert.equal(spawn.mock.calls[1][2].env.GITHUB_TOKEN, "token");
  assert.equal(spawn.mock.calls[1][2].env.QA_NATIVE_PUBLICATION_KEY, undefined);
  assert.equal(JSON.parse(spawn.mock.calls[2][2].input).conclusion, "neutral");
});

test("matches markers only from the configured bot and ignores foreign duplicates", async () => {
  const marker = markerLine("signup-flow");
  const transport = createGitHubCliTransport({
    botLogin: "trusted-bot[bot]",
    spawn: mockSpawn([[
      { id: 1, html_url: "https://github.com/owner/repo/issues/7#issuecomment-1", body: marker, user: { login: "attacker" } },
      { id: 2, html_url: "https://github.com/owner/repo/issues/7#issuecomment-2", body: marker, user: { login: "attacker-2" } },
      { id: 3, html_url: "https://github.com/owner/repo/issues/7#issuecomment-3", body: `${marker}\n${marker}`, user: { login: "Trusted-Bot[bot]" } },
    ]]),
  });
  assert.equal((await transport.findPrComment({ repository: "owner/repo", prNumber: 7, studyId: "signup-flow" })).id, 3);
});

test("rejects unsafe artifact URLs and ambiguous trusted-bot marker comments", async () => {
  assert.throws(() => renderBehavioralPrComment({ studyId: "signup-flow", outcome: {}, artifactLinks: [{ label: "bad", url: "javascript:alert(1)" }] }), /HTTPS/);
  const marker = markerLine("signup-flow");
  const transport = createGitHubCliTransport({ botLogin: "bot", spawn: mockSpawn([[
    { id: 1, html_url: "https://github.com/owner/repo/issues/7#issuecomment-1", body: marker, user: { login: "bot" } },
    { id: 2, html_url: "https://github.com/owner/repo/issues/7#issuecomment-2", body: marker, user: { login: "bot" } },
  ]]) });
  await assert.rejects(() => transport.findPrComment({ repository: "owner/repo", prNumber: 7, studyId: "signup-flow" }), /ambiguous/);
});

function criticalBehavioral() {
  return { id: "finding-1", title: "CTA below fold", category: "behavioral", severity: "critical", maturity: "reproduced_synthetic_finding", confidence: { overall: "high" } };
}

function mockSpawn(outputs) {
  const fn = (...args) => {
    fn.mock.calls.push(args);
    const output = outputs.shift();
    return { status: 0, stdout: Buffer.from(JSON.stringify(output)) };
  };
  fn.mock = { calls: [] };
  return fn;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
