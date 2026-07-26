import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const BEHAVIORAL_COMMENT_MARKER_PREFIX = "persona-runtime-check";
export const DEFAULT_CHECK_NAME = "Behavioral Release Check";
export const GITHUB_REPORTER_ERROR_CODES = Object.freeze({
  INPUT_INVALID: "INPUT_INVALID",
  GITHUB_TRANSPORT_FAILED: "GITHUB_TRANSPORT_FAILED",
});

const MAX_BODY_BYTES = 60_000;
const MAX_GH_RESPONSE_BYTES = 1024 * 1024;
const MAX_GH_ITEMS = 100;
const ENV_ALLOWLIST = [
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP",
  "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST", "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "LANG", "LC_ALL", "LC_CTYPE",
];

export class GitHubReporterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GitHubReporterError";
    this.code = code;
  }
}

export function classifyReporterOutcome({ runtimeError, findings = [], releaseGate = {}, comparisonStatus, sampleCount = 0 } = {}) {
  if (runtimeError) {
    return Object.freeze({
      kind: "infrastructure",
      conclusion: releaseGate.infrastructureFailureConclusion === "failure" ? "failure" : "neutral",
      summary: safeInline(runtimeError.message ?? runtimeError.code ?? "Behavioral check infrastructure failed"),
    });
  }

  const normalizedFindings = findings.map(normalizeFinding);
  const blocking = normalizedFindings.filter((finding) => isBlockingFinding(finding, releaseGate));
  const manualGate = comparisonStatus === "unstable" || normalizedFindings.some((finding) => finding.humanValidation?.level === "required");
  const warning = normalizedFindings.some((finding) => ["critical", "high", "medium"].includes(finding.severity)) || ["baseline_better", "insufficient_evidence"].includes(comparisonStatus);
  const uncalibratedSingleSession = sampleCount <= 1 && normalizedFindings.some((finding) => finding.category === "behavioral");

  if (blocking.length > 0) return Object.freeze({ kind: "product", conclusion: "failure", summary: `${blocking.length} blocking regression${blocking.length === 1 ? "" : "s"} detected` });
  if (manualGate) return Object.freeze({ kind: "product", conclusion: "action_required", summary: "Behavioral check needs human review" });
  if (warning || uncalibratedSingleSession) return Object.freeze({ kind: "product", conclusion: "neutral", summary: "Behavioral warnings detected" });
  return Object.freeze({ kind: "product", conclusion: "success", summary: "No blocking behavioral regression detected" });
}

export function renderBehavioralPrComment({ studyId, outcome, comparisonReport, findings = [], artifactLinks = [], runUrl } = {}) {
  const safeStudyId = markerStudyId(studyId);
  const normalizedOutcome = normalizeOutcome(outcome);
  const safeLinks = normalizeArtifactLinks(artifactLinks);
  const normalizedFindings = findings.map(normalizeFinding);
  const status = comparisonReport?.status ?? "not_reported";
  const lines = [
    markerLine(safeStudyId),
    `## ${DEFAULT_CHECK_NAME}`,
    "",
    `**Result:** ${titleCase(normalizedOutcome.conclusion)}`,
    `**Signal type:** ${normalizedOutcome.kind === "infrastructure" ? "Infrastructure" : "Product / behavioral"}`,
    `**Summary:** ${safeText(normalizedOutcome.summary)}`,
    "",
    "### Variant comparison",
    `- Status: ${code(status)}`,
  ];

  if (comparisonReport?.delta) {
    lines.push(
      `- Completion delta: ${code(formatDelta(comparisonReport.delta.completionDelta))}`,
      `- Abandonment delta: ${code(formatDelta(comparisonReport.delta.abandonmentDelta))}`,
      `- Median actions delta: ${code(formatDelta(comparisonReport.delta.medianActionDelta))}`,
    );
  }

  lines.push("", "### Findings");
  if (normalizedFindings.length === 0) {
    lines.push("No behavioral findings reported.");
  } else {
    lines.push("| Severity | Category | Finding | Maturity |", "|---|---|---|---|");
    for (const finding of normalizedFindings.slice(0, 10)) {
      lines.push(`| ${safeTable(finding.severity)} | ${safeTable(finding.category)} | ${safeTable(finding.title)} | ${safeTable(finding.maturity ?? "unknown")} |`);
    }
    if (normalizedFindings.length > 10) lines.push(`\n_${normalizedFindings.length - 10} more finding(s) omitted from PR comment; see artifacts._`);
  }

  lines.push("", "### Artifacts");
  if (safeLinks.length === 0 && !runUrl) {
    lines.push("No artifact link provided.");
  } else {
    if (runUrl) lines.push(`- Run: ${markdownLink("workflow run", runUrl)}`);
    for (const link of safeLinks.slice(0, 10)) lines.push(`- ${markdownLink(link.label, link.url)}`);
  }

  return boundBody(lines.join("\n"));
}

export function markerLine(studyId) {
  return `<!-- ${BEHAVIORAL_COMMENT_MARKER_PREFIX}: study=${markerStudyId(studyId)} -->`;
}

export function createGitHubCliTransport({ spawn = spawnSync, botLogin = "github-actions[bot]" } = {}) {
  if (typeof spawn !== "function") throw new TypeError("GitHub CLI spawn must be a function");
  const trustedBotLogin = githubLogin(botLogin);
  return Object.freeze({
    async createCheckRun({ repository, headSha, name = DEFAULT_CHECK_NAME, conclusion, title, summary, detailsUrl }) {
      const repo = repositorySlug(repository);
      const payload = boundCheckPayload({
        name: safeInline(name).slice(0, 100) || DEFAULT_CHECK_NAME,
        head_sha: commitSha(headSha),
        status: "completed",
        conclusion: checkConclusion(conclusion),
        output: { title: safeInline(title ?? name).slice(0, 255) || DEFAULT_CHECK_NAME, summary: safeInline(summary).slice(0, 65_000) || "Behavioral check completed." },
        ...(detailsUrl ? { details_url: safeHttpsUrl(detailsUrl) } : {}),
      });
      const created = runGhJson(spawn, ["api", "--method", "POST", `repos/${repo}/check-runs`, "--input", "-"], Buffer.from(JSON.stringify(payload)));
      if (!Number.isSafeInteger(created?.id) || created.id < 1 || created.conclusion !== payload.conclusion) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.GITHUB_TRANSPORT_FAILED, "GitHub Check creation returned invalid data");
      return Object.freeze({ id: created.id, conclusion: created.conclusion, url: typeof created.html_url === "string" ? created.html_url : undefined });
    },

    async findPrComment({ repository, prNumber, studyId }) {
      const repo = repositorySlug(repository);
      const marker = markerLine(studyId);
      const comments = runGhJson(spawn, ["api", "--method", "GET", `repos/${repo}/issues/${issueNumber(prNumber)}/comments`, "-f", `per_page=${MAX_GH_ITEMS}`, "--paginate", "--slurp", "--jq", "[.[][]|{id,html_url,body,user:{login:.user.login}}]"]);
      if (!Array.isArray(comments) || comments.length > 500) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.GITHUB_TRANSPORT_FAILED, "GitHub comment search returned invalid data");
      const matches = comments.filter((comment) => typeof comment?.user?.login === "string" && comment.user.login.toLowerCase() === trustedBotLogin && Number.isSafeInteger(comment.id) && typeof comment.body === "string" && comment.body.split("\n").some((line) => line.trim() === marker));
      if (matches.length > 1) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.GITHUB_TRANSPORT_FAILED, "GitHub behavioral PR comment marker is ambiguous");
      return matches[0] ? Object.freeze({ id: matches[0].id, url: safeGithubCommentUrl(matches[0].html_url), body: matches[0].body }) : undefined;
    },

    async createPrComment({ repository, prNumber, body }) {
      const repo = repositorySlug(repository);
      const safeBody = boundBody(body);
      const created = runGhJson(spawn, ["api", "--method", "POST", `repos/${repo}/issues/${issueNumber(prNumber)}/comments`, "--input", "-"], Buffer.from(JSON.stringify({ body: safeBody })));
      if (!Number.isSafeInteger(created?.id) || created.id < 1 || created.body !== safeBody) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.GITHUB_TRANSPORT_FAILED, "GitHub comment creation returned invalid data");
      return Object.freeze({ id: created.id, url: safeGithubCommentUrl(created.html_url) });
    },

    async updatePrComment({ repository, commentId, body }) {
      const repo = repositorySlug(repository);
      const id = issueNumber(commentId);
      const safeBody = boundBody(body);
      const updated = runGhJson(spawn, ["api", "--method", "PATCH", `repos/${repo}/issues/comments/${id}`, "--input", "-"], Buffer.from(JSON.stringify({ body: safeBody })));
      if (updated?.id !== id || updated.body !== safeBody) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.GITHUB_TRANSPORT_FAILED, "GitHub comment update returned invalid data");
      return Object.freeze({ id, url: safeGithubCommentUrl(updated.html_url) });
    },
  });
}

export async function publishBehavioralGitHubReport({ repository, prNumber, headSha, studyId, comparisonReport, findings = [], artifactLinks = [], runtimeError, releaseGate, sampleCount, runUrl, transport = createGitHubCliTransport() } = {}) {
  const outcome = classifyReporterOutcome({ runtimeError, findings, releaseGate, comparisonStatus: comparisonReport?.status, sampleCount });
  const body = renderBehavioralPrComment({ studyId, outcome, comparisonReport, findings, artifactLinks, runUrl });
  const existing = await transport.findPrComment({ repository, prNumber, studyId });
  const comment = existing
    ? await transport.updatePrComment({ repository, commentId: existing.id, body })
    : await transport.createPrComment({ repository, prNumber, body });
  const check = headSha
    ? await transport.createCheckRun({ repository, headSha, conclusion: outcome.conclusion, title: DEFAULT_CHECK_NAME, summary: outcome.summary, detailsUrl: runUrl ?? artifactLinks[0]?.url })
    : undefined;
  return Object.freeze({ action: existing ? "UPDATED" : "CREATED", outcome, comment, check, fingerprint: canonicalHash({ studyId: markerStudyId(studyId), comparisonStatus: comparisonReport?.status, findingIds: findings.map((finding) => finding.id ?? finding.fingerprint ?? finding.title).sort() }) });
}

function isBlockingFinding(finding, releaseGate) {
  const severity = finding.severity;
  const category = finding.category;
  if (category === "functional" && ["critical", "high"].includes(severity)) return true;
  if (category === "behavioral" && severity === "critical" && finding.maturity === "reproduced_synthetic_finding" && confidenceOverall(finding.confidence) === "high") return true;
  return (releaseGate.failOn ?? []).some((rule) => rule.category === category && rule.severity === severity && (!rule.minimumMaturity || rule.minimumMaturity === finding.maturity) && (!rule.minimumConfidence || rule.minimumConfidence === confidenceOverall(finding.confidence)));
}

function normalizeFinding(finding) {
  if (!finding || typeof finding !== "object") throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.INPUT_INVALID, "finding must be an object");
  return Object.freeze({
    id: safeInline(finding.id ?? finding.fingerprint ?? finding.title ?? "finding"),
    title: safeInline(finding.title ?? finding.observation ?? finding.id ?? "Behavioral finding"),
    category: ["functional", "behavioral"].includes(finding.category) ? finding.category : "behavioral",
    severity: ["critical", "high", "medium", "low"].includes(finding.severity) ? finding.severity : "low",
    maturity: typeof finding.maturity === "string" ? safeInline(finding.maturity) : undefined,
    confidence: finding.confidence,
    humanValidation: finding.humanValidation,
  });
}

function normalizeOutcome(outcome) {
  const value = outcome ?? {};
  return Object.freeze({
    kind: value.kind === "infrastructure" ? "infrastructure" : "product",
    conclusion: checkConclusion(value.conclusion ?? "neutral"),
    summary: safeInline(value.summary ?? "Behavioral check completed"),
  });
}

function confidenceOverall(confidence) {
  return ["high", "medium", "low"].includes(confidence?.overall) ? confidence.overall : undefined;
}

function normalizeArtifactLinks(links) {
  if (!Array.isArray(links)) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.INPUT_INVALID, "artifactLinks must be an array");
  return links.map((link) => ({ label: safeInline(link?.label ?? "artifact"), url: safeHttpsUrl(link?.url) }));
}

function repositorySlug(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.INPUT_INVALID, "GitHub repository must be owner/name");
  return value.toLowerCase();
}

function commitSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/i.test(value)) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.INPUT_INVALID, "headSha must be a commit sha");
  return value;
}

function issueNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.INPUT_INVALID, "GitHub issue number must be a positive integer");
  return value;
}

function githubLogin(value) {
  if (typeof value !== "string" || value.length > 100 || !/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(value)) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.INPUT_INVALID, "GitHub bot login is invalid");
  return value.toLowerCase();
}

function checkConclusion(value) {
  if (!["success", "neutral", "failure", "action_required", "cancelled", "timed_out"].includes(value)) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.INPUT_INVALID, "GitHub Check conclusion is invalid");
  return value;
}

function markerStudyId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(value)) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.INPUT_INVALID, "studyId must be marker-safe");
  return value;
}

function boundCheckPayload(payload) {
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  if (bytes > MAX_BODY_BYTES) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.INPUT_INVALID, "GitHub Check payload is too large");
  return payload;
}

function boundBody(value) {
  const body = String(value ?? "");
  if (body.length === 0 || Buffer.byteLength(body) > MAX_BODY_BYTES) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.INPUT_INVALID, "GitHub comment body is empty or too large");
  return body;
}

function safeHttpsUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.INPUT_INVALID, "artifact URL must be HTTPS"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hostname === "") throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.INPUT_INVALID, "artifact URL must be safe HTTPS");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function safeGithubCommentUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.GITHUB_TRANSPORT_FAILED, "GitHub returned an unsafe comment URL"); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password || parsed.port || parsed.search || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/[1-9][0-9]*$/.test(parsed.pathname) || (parsed.hash && !/^#issuecomment-[1-9][0-9]*$/.test(parsed.hash))) {
    throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.GITHUB_TRANSPORT_FAILED, "GitHub returned an unsafe comment URL");
  }
  return parsed.toString();
}

function markdownLink(label, url) {
  return `[${safeText(label)}](${safeHttpsUrl(url)})`;
}

function safeInline(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/<!--.*?-->/gs, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "[image removed]").replace(/@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g, "@\u200bteam").replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function safeText(value) {
  return safeInline(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1").replaceAll("@", "@\u200b");
}

function safeTable(value) {
  return safeText(value).replaceAll("|", "\\|");
}

function code(value) {
  return `\`${safeInline(value).replaceAll("`", "'")}\``;
}

function formatDelta(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value}` : "n/a";
}

function titleCase(value) {
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function canonicalHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function runGh(spawn, args, input) {
  const result = spawn("gh", args, { encoding: "buffer", maxBuffer: MAX_GH_RESPONSE_BYTES, env: githubEnvironment(), ...(input === undefined ? {} : { input }) });
  if (!result || result.status !== 0 || !(result.stdout instanceof Uint8Array) || result.stdout.byteLength > MAX_GH_RESPONSE_BYTES) throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.GITHUB_TRANSPORT_FAILED, "GitHub CLI request failed");
  return Buffer.from(result.stdout);
}

function runGhJson(spawn, args, input) {
  try { return JSON.parse(runGh(spawn, args, input).toString("utf8")); } catch (error) {
    if (error instanceof GitHubReporterError) throw error;
    throw new GitHubReporterError(GITHUB_REPORTER_ERROR_CODES.GITHUB_TRANSPORT_FAILED, "GitHub CLI returned invalid JSON");
  }
}

function githubEnvironment() {
  return Object.fromEntries([...ENV_ALLOWLIST.map((key) => [key, process.env[key]]).filter(([, value]) => typeof value === "string"), ["GH_PROMPT_DISABLED", "1"], ["GH_NO_UPDATE_NOTIFIER", "1"]]);
}
