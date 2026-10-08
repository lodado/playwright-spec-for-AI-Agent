// World adapter for O1-O3: builds each coordinate of the Verdict world as its Terms Path says (T1, T2, T4,
// T5, T7, T8), calls the product's normalizeBrowseDecision, and reads each observation through the path its
// term names (T3 status, T6 cause, T9 summary note). No expected value lives here.
// The capture file is an in-memory stand-in injected through the normalizer's own fileExists/readText options
// (the adapter audit forbids node:fs imports); "nonempty capture registered in runnerEvidence" is kept as written.
import { CAUSES, normalizeBrowseDecision } from "../../../judge-verdict.mjs";

const ITEM = "Planned check title";
const PLANNED_ID = "C1";
const UNPLANNED_ID = "X9";
const CAPTURE = "/runs/verdict-world/capture.png";
const files = new Map();

const AGENT = {
  AgentPass: "pass",
  AgentFail: "fail",
  AgentSkip: "skip",
  AgentManual: "manual_review",
};
const CHECK = {
  CheckPass: "pass",
  CheckFail: "fail",
  CheckSkip: "skip",
  CheckManual: "manual_review",
  CheckGarbled: "not-a-result",
};
const FINAL = { pass: "FinalPass", fail: "FinalFail", manual_review: "FinalManual" };

function lookup(table, key, name) {
  if (!Object.hasOwn(table, key)) throw new Error(`unmapped ${name}: ${String(key)}`);
  return table[key];
}

export function run(coordinates) {
  const capture = CAPTURE;
  files.set(capture, "png-bytes");

  const result = lookup(CHECK, coordinates.checkResult, "checkResult");
  const report = {
    item: ITEM,
    detail: "observed the page",
    result,
    ...(coordinates.confidenceLow ? { confidence: "low" } : {}),
    ...(coordinates.evidenceVerified ? { evidenceRefs: [capture] } : {}),
  };
  const reported = [];
  if (coordinates.checkAddressed) {
    reported.push({ ...report, checkId: PLANNED_ID });
    if (coordinates.extraReport) reported.push({ ...report, checkId: PLANNED_ID });
  } else if (coordinates.extraReport) {
    reported.push({ ...report, checkId: UNPLANNED_ID });
  }

  const raw = {
    status: lookup(AGENT, coordinates.agentStatus, "agentStatus"),
    summary: "agent summary",
    checks: reported,
  };
  const out = normalizeBrowseDecision(raw, {
    plannedChecks: [{ checkId: PLANNED_ID, item: ITEM }],
    runnerEvidence: { screenshots: [capture] },
    fileExists: file => (files.get(file) ?? "").length > 0,
    readText: file => files.get(file) ?? "",
  });

  const pass = out.status === "pass";
  const recognisedCause = CAUSES.includes(out.cause) && out.cause !== "NONE";
  return {
    finalStatus: lookup(FINAL, out.status, "final status"),
    causeOk: pass ? out.cause === "NONE" : recognisedCause,
    downgradeNoted: out.summary.includes("Verdict floor applied"),
  };
}

export function dispose() {
  files.clear();
}
