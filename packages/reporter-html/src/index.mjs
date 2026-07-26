import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SECTION_ORDER = Object.freeze([
  "validity",
  "outcomes",
  "findings",
  "personas",
  "variant",
  "timeline",
  "evidence",
  "runtime",
  "cost",
]);

export function renderBehavioralHtmlReport(input = {}, { secrets = [] } = {}) {
  const report = sanitizeValue(snapshot(input), new Set(secrets.filter(Boolean).map(String)));
  const title = text(report.summary?.title ?? report.study?.name ?? "Behavioral report");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css()}</style>
</head>
<body>
<main>
${renderValidity(report)}
${renderOutcomes(report)}
${renderFindings(report)}
${renderPersonas(report)}
${renderVariant(report)}
${renderTimeline(report)}
${renderEvidence(report)}
${renderRuntime(report)}
${renderCost(report)}
${renderModelCard(report)}
</main>
</body>
</html>`;
}

export const renderHtmlReport = renderBehavioralHtmlReport;

export async function writeBehavioralHtmlReport({ input, outputPath, secrets = [] } = {}) {
  if (!outputPath) throw new Error("outputPath is required");
  const html = renderBehavioralHtmlReport(input, { secrets });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");
  return { path: outputPath, bytes: Buffer.byteLength(html) };
}

function renderValidity(report) {
  const validity = report.validity ?? {};
  const calibration = validity.calibration ?? report.calibration ?? {};
  return section("validity", "Limitations / Validity", [
    dl([
      ["Study status", report.summary?.status ?? report.status ?? "not_available"],
      ["Simulation calibration", calibration.level ?? calibration.status ?? calibration],
      ["Recommended use", validity.recommendedUse ?? report.recommendedUse ?? "human_validation_required"],
      ["Population diversity", validity.diversity ?? report.populationDiversity ?? "not_available"],
      ["Seed stability", validity.stability?.seedVariance ?? report.seedStability ?? "not_available"],
      ["Model stability", validity.stability?.modelAgreement ?? report.modelAgreement ?? "not_available"],
      ["Order stability", validity.stability?.orderConsistency ?? report.orderConsistency ?? "not_available"],
      ["Human validation requirement", report.summary?.humanValidation ?? validity.humanValidation ?? "required before user-impact claims"],
    ]),
    list("Detected risks", validity.detectedRisks),
    list("Forbidden interpretations", validity.forbiddenInterpretations),
  ]);
}

function renderOutcomes(report) {
  const outcomes = report.outcomes ?? report.outcomeDistribution ?? report.summary?.outcomes;
  return section("outcomes", "Outcome Distribution", [tableFrom(outcomes, ["status", "count", "rate"])]);
}

function renderFindings(report) {
  const findings = toArray(report.findings);
  return section("findings", "Repeated Findings", findings.length ? findings.map(renderFinding).join("\n") : empty());
}

function renderFinding(finding) {
  return `<article class="card finding" id="${anchorId(finding.id)}">
<h3>[${text(finding.severity ?? "unknown")}] ${text(finding.title ?? finding.id ?? "Finding")}</h3>
${dl([
  ["Maturity", finding.maturity],
  ["Occurrence", occurrence(finding)],
  ["Affected", affected(finding)],
  ["Category", finding.category],
])}
<h4>Observation</h4><p>${text(finding.observation)}</p>
<h4>Interpretation</h4><p>${text(finding.interpretation)}</p>
${finding.recommendation ? `<h4>Recommendation</h4><p>${text(finding.recommendation)}</p>` : ""}
${evidenceLinks(finding.evidenceIds, finding.eventIds)}
<h4>Confidence</h4>${dl(confidenceRows(finding.confidence))}
</article>`;
}

function renderPersonas(report) {
  return section("personas", "Persona Comparison", [tableFrom(report.personas ?? report.personaComparison, ["personaId", "sessions", "successRate", "findingIds"])]);
}

function renderVariant(report) {
  return section("variant", "Variant Comparison", [objectBlock(report.variant ?? report.variantComparison)]);
}

function renderTimeline(report) {
  const timeline = toArray(report.timeline ?? report.sessions);
  return section("timeline", "Session Timeline", timeline.length ? timeline.map((session) => {
    const steps = toArray(session.steps ?? session.events);
    return `<article class="card" id="${anchorId(session.sessionId ?? session.id)}"><h3>${text(session.sessionId ?? session.id ?? "Session")}</h3>${dl([
      ["Persona", session.personaId], ["Task", session.taskId], ["Status", session.status], ["Variant", session.variant],
    ])}${steps.map(renderTimelineStep).join("\n")}</article>`;
  }).join("\n") : empty());
}

function renderTimelineStep(step) {
  return `<div class="step">
<strong>${text(step.index ?? step.sequence ?? "step")}</strong>
${dl([
  ["URL", step.url ?? step.urlAfter ?? step.page?.url],
  ["Perceived elements", joinText(step.perceivedElements ?? step.semantic?.visibleText)],
  ["Action", actionText(step.action)],
  ["Result", step.result?.status ?? step.result],
  ["Progress change", step.progressChange ?? step.derivedSignals?.progressChanged],
  ["Reason code", step.action?.reasonCode ?? step.reasonCode],
  ["Persona state delta", step.personaStateDelta],
  ["Oracle delta", step.oracleDelta],
])}
${evidenceLinks([step.beforeScreenshotEvidenceId, step.afterScreenshotEvidenceId, ...(step.evidenceIds ?? [])].filter(Boolean))}
</div>`;
}

function renderEvidence(report) {
  const entries = toArray(report.evidence?.entries ?? report.evidence);
  return section("evidence", "Evidence Viewer", entries.length ? entries.map((entry) => `<article class="card evidence" id="${anchorId(entry.id ?? entry.evidenceId)}"><h3>${text(entry.id ?? entry.evidenceId)}</h3>${dl([
    ["Type", entry.type],
    ["Content hash", entry.contentHash],
    ["Path", entry.path ?? entry.filePath ?? entry.url],
  ])}${objectBlock(entry.metadata)}</article>`).join("\n") : empty());
}

function renderRuntime(report) {
  return section("runtime", "Runtime Issues", [tableFrom(report.runtime ?? report.runtimeIssues, ["sessionId", "type", "message", "evidenceId"])]);
}

function renderCost(report) {
  return section("cost", "Cost / Model Usage", [objectBlock(report.cost ?? report.modelUsage)]);
}

function renderModelCard(report) {
  return report.modelCard ? section("model-card", "Model Card", [objectBlock(report.modelCard)]) : "";
}

function section(id, heading, children) {
  const body = Array.isArray(children) ? children.filter(Boolean).join("\n") : children;
  return `<section id="${id}" data-section-order="${SECTION_ORDER.indexOf(id)}"><h2>${text(heading)}</h2>${body || empty()}</section>`;
}

function dl(rows) {
  const rendered = rows.filter(([, value]) => value !== undefined && value !== null && value !== "").map(([key, value]) => `<dt>${text(key)}</dt><dd>${valueHtml(value)}</dd>`).join("");
  return rendered ? `<dl>${rendered}</dl>` : "";
}

function tableFrom(value, columns) {
  const rows = toArray(value);
  if (!rows.length) return value ? objectBlock(value) : empty();
  return `<table><thead><tr>${columns.map((column) => `<th>${text(column)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${valueHtml(row?.[column])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function objectBlock(value) {
  if (value === undefined || value === null) return empty();
  return `<pre>${text(JSON.stringify(value, null, 2))}</pre>`;
}

function list(label, values) {
  const items = toArray(values);
  if (!items.length) return "";
  return `<h3>${text(label)}</h3><ul>${items.map((item) => `<li>${valueHtml(item)}</li>`).join("")}</ul>`;
}

function evidenceLinks(evidenceIds = [], eventIds = []) {
  const links = [...new Set(evidenceIds.filter(Boolean).map(String))].map((id) => `<a href="#${anchorId(id)}">${text(id)}</a>`);
  const events = [...new Set(eventIds.filter(Boolean).map(String))].map(text).join(", ");
  return `<h4>Evidence</h4>${events ? `<p>Events: ${events}</p>` : ""}${links.length ? `<p>${links.join(" ")}</p>` : `<p class="empty">No evidence linked.</p>`}`;
}

function confidenceRows(confidence = {}) {
  return [
    ["Evidence", confidence.evidenceConfidence],
    ["Recurrence", confidence.recurrenceConfidence],
    ["Seed stability", confidence.seedStability],
    ["Model agreement", confidence.modelAgreement],
    ["Calibration", confidence.calibrationConfidence],
    ["Order consistency", confidence.orderConsistency],
    ["Overall", confidence.overall],
    ["Limitations", joinText(confidence.limitations)],
  ];
}

function occurrence(finding) {
  if (finding.occurrence) return finding.occurrence;
  if (finding.affectedSessionIds?.length && typeof finding.totalSessionCount === "number") return `${finding.affectedSessionIds.length} / ${finding.totalSessionCount} sessions`;
  if (typeof finding.recurrenceRate === "number") return `${Math.round(finding.recurrenceRate * 100)}% of tested sessions`;
  return undefined;
}

function affected(finding) {
  return [
    finding.affectedPersonaIds?.length ? `${finding.affectedPersonaIds.length} personas` : undefined,
    finding.affectedTaskIds?.length ? `${finding.affectedTaskIds.length} tasks` : undefined,
    finding.viewport,
  ].filter(Boolean).join(", ");
}

function actionText(action) {
  if (!action) return undefined;
  if (typeof action === "string") return action;
  return [action.type, action.elementId, action.reasonCode].filter(Boolean).join(" / ");
}

function joinText(value) {
  return Array.isArray(value) ? value.join(", ") : value;
}

function valueHtml(value) {
  if (Array.isArray(value)) return value.map(valueHtml).join(", ");
  if (value && typeof value === "object") return text(JSON.stringify(value));
  return text(value);
}

function text(value) {
  if (value === undefined || value === null) return "";
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function anchorId(value) {
  return text(String(value ?? "unknown").replace(/[^A-Za-z0-9_-]+/g, "-"));
}

function empty() {
  return `<p class="empty">Not available.</p>`;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : Object.entries(value).map(([key, item]) => (item && typeof item === "object" ? { id: key, ...item } : { id: key, value: item }));
}

function snapshot(value) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("report input must be JSON-serializable");
  return JSON.parse(json);
}

function sanitizeValue(value, secrets) {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item, secrets)]));
  return value;
}

function redactString(value, secrets) {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.split(secret).join("[redacted-secret]");
  return redacted
    .replace(/[A-Z]:\\Users\\[^\\\s<>'"]+(?:\\[^\s<>'"]*)*/gi, "[redacted-path]")
    .replace(/\/(?:Users|home)\/[^\s<>'"]+(?:\/[^\s<>'"]*)*/g, "[redacted-path]")
    .replace(/((?:api[_-]?key|token|secret|password)=)([^\s&<>'"]+)/gi, "$1[redacted-secret]")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[redacted-secret]");
}

function css() {
  return `:root{color-scheme:light dark;font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.45}body{margin:0;background:Canvas;color:CanvasText}main{max-width:1100px;margin:auto;padding:24px}section{margin:0 0 24px;padding:20px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:12px}h2{margin-top:0}dl{display:grid;grid-template-columns:minmax(150px,240px)1fr;gap:8px 16px}dt{font-weight:700}dd{margin:0}.card{padding:16px;margin:12px 0;border:1px solid color-mix(in srgb,CanvasText 14%,transparent);border-radius:10px}table{border-collapse:collapse;width:100%}th,td{padding:8px;border-bottom:1px solid color-mix(in srgb,CanvasText 14%,transparent);text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow:auto}.empty{opacity:.7}a{color:LinkText}.step{border-left:3px solid color-mix(in srgb,CanvasText 25%,transparent);padding-left:12px;margin:12px 0}@media(max-width:480px){main{padding:12px}dl{grid-template-columns:1fr}}`;
}
