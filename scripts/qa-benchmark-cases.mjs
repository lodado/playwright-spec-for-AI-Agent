/** Deterministic corpus: harness validation by default; adapter mode uses semantic cases only. */
const VALID_ARTIFACT = "__EVIDENCE__/capture.txt";

const check = (id, item, result, detail, extra = {}) => ({
  checkId: id,
  item,
  result,
  detail,
  confidence: result === "pass" ? "high" : "medium",
  ...extra,
});

const pass = (name, id, item, expected, aria, intent = `${expected} is visible`) => ({
  name,
  kind: "semantic",
  expectedStatus: "pass",
  intent,
  aria,
  plannedChecks: [{ checkId: id, item }],
  raw: {
    status: "pass",
    checks: [check(id, item, "pass", `Observed "${expected}"`)],
  },
});

const productFail = (name, id, item, expected, observed, aria) => ({
  name,
  kind: "semantic",
  expectedStatus: "fail",
  intent: `${expected} is visible`,
  aria,
  plannedChecks: [{ checkId: id, item }],
  raw: {
    status: "fail",
    checks: [check(id, item, "fail", `Observed "${observed}"`, { cause: "PRODUCT_DEFECT" })],
  },
});

const review = (name, id, item, intent, aria, detail) => ({
  name,
  kind: "semantic",
  expectedStatus: "manual_review",
  intent,
  aria,
  plannedChecks: [{ checkId: id, item }],
  raw: { status: "pass", checks: [check(id, item, "pass", detail)] },
});

export const BENCHMARK_CASES = [
  pass("pass-basic-label", "check-1", "shows account label", "Value 1", "name: Value 1"),
  pass("pass-localized-label", "check-2", "shows payment completion", "결제 완료", "name: 결제 완료", "결제 완료 상태가 표시된다"),
  pass("pass-number", "check-3", "shows score", "Score 98%", "name: Score 98%"),
  pass("pass-url-state", "check-4", "shows billing route", "/billing", "url: /billing\nname: Active", "billing route /billing is active"),
  pass("pass-multiline-card", "check-5", "shows Pro plan renewal", "Renewal 2027-01-01", "name: Pro plan\nname: Renewal 2027-01-01"),
  pass("pass-whitespace", "check-6", "shows normalized value", "Value 6", "name:   Value 6"),
  pass("pass-aria-role", "check-7", "shows status value", "Value 7", "role: status\nname: Value 7"),
  pass("pass-table-cell", "check-8", "shows invoice payment state", "Paid", "row: Invoice\ncell: Paid"),
  pass("pass-modal", "check-9", "shows modal title", "Value 9", "dialog: Value 9"),
  pass("pass-counter", "check-10", "shows result count", "10 results", "name: 10 results"),

  productFail("fail-wrong-label", "check-11", "shows account label", "Value 11", "Wrong 11", "name: Wrong 11"),
  productFail("fail-wrong-number", "check-12", "shows score", "Score 98%", "Score 12%", "name: Score 12%"),
  productFail("fail-missing-card", "check-13", "shows plan card", "Pro plan", "Empty state", "name: Empty state"),
  productFail("fail-stale-status", "check-14", "shows current status", "Active", "Pending", "name: Pending"),
  productFail("fail-wrong-locale", "check-15", "shows localized invoice label", "세금계산서", "Wrong invoice", "name: Wrong invoice"),
  productFail("fail-wrong-url", "check-16", "shows billing route", "/billing", "/home", "url: /home"),
  productFail("fail-wrong-role", "check-17", "shows status value", "Value 17", "Wrong 17", "role: alert\nname: Wrong 17"),
  productFail("fail-duplicate-value", "check-18", "shows unique value", "Value 18", "Wrong 18", "name: Wrong 18\nname: Wrong 18"),

  review("review-login-expired", "check-19", "shows account label", "Account label is verifiable", "login form: expired", "Login expired before the page could be checked"),
  review("review-timeout", "check-20", "shows loading result", "Result is visible after loading", "loading: true", "Loading did not finish"),
  review("review-empty-aria", "check-21", "shows account label", "Account label is verifiable", "", "No accessible snapshot was captured"),
  review("review-permission", "check-22", "shows restricted result", "Restricted result is verifiable", "name: Access denied", "Permission state blocks verification"),
  review("review-ambiguous", "check-23", "shows the primary account value", "The primary account shows Value 23", "group: account\\nname: Value 23\\ngroup: account\\nname: Value 99", "Neither account group identifies which account is primary"),
  review("review-network", "check-24", "shows network result", "Network result is verifiable", "network: unavailable", "Network data is unavailable"),
  review("review-partial-dom", "check-25", "shows loaded value", "Loaded value is verifiable", "name: Value 25\nstatus: loading", "The DOM is still loading"),
  review("review-auth-redirect", "check-26", "shows account label", "Account label is verifiable", "url: /login\nname: Sign in", "Authentication redirect replaced the target page"),

  { name: "duplicate-title-distinct-ids", kind: "harness", expectedStatus: "manual_review", intent: "Two distinct checks share a title", aria: "name: Account title", plannedChecks: [{ checkId: "billing-title", item: "shows account title" }, { checkId: "invoice-title", item: "shows account title" }], raw: { status: "pass", checks: [check("billing-title", "shows account title", "pass", 'Observed "Account title"', { evidenceRefs: [VALID_ARTIFACT] })] } },
  { name: "wrong-check-id", kind: "harness", expectedStatus: "manual_review", intent: "Reported ID must match the plan", aria: "name: Account title", plannedChecks: [{ checkId: "expected-id", item: "shows account title" }], raw: { status: "pass", checks: [check("wrong-id", "shows account title", "pass", 'Observed "Account title"', { evidenceRefs: [VALID_ARTIFACT] })] } },
  { name: "quoted-nonexistent-observation", kind: "harness", expectedStatus: "manual_review", intent: "Quoted observation must exist in evidence", aria: "name: Actual text", plannedChecks: [{ checkId: "quote", item: "shows account title" }], raw: { status: "pass", checks: [check("quote", "shows account title", "pass", 'Observed "Made-up text"')] } },
  { name: "unexpected-readonly-mutation", kind: "harness", expectedStatus: "manual_review", intent: "Read-only run must not mutate", aria: "name: Account title", plannedChecks: [{ checkId: "mutation", item: "shows account title" }], raw: { status: "pass", checks: [check("mutation", "shows account title", "pass", 'Observed "Account title"', { evidenceRefs: [VALID_ARTIFACT] })] }, violations: [{ kind: "unexpected-mutation", detail: "POST /api/account" }] },
];
if (BENCHMARK_CASES.length < 30) throw new Error("Benchmark corpus must contain at least 30 cases");
