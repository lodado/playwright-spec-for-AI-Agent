import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  CODE_CONTEXT_VERSION,
  canonicalHash,
  validateContract,
} from "../contracts/index.mjs";
import { redactSensitiveText } from "../evidence/index.mjs";

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".graphql", ".html", ".java", ".js", ".jsx", ".kt", ".kts",
  ".mjs", ".php", ".py", ".rb", ".rs", ".scss", ".svelte", ".ts", ".tsx", ".vue", ".yaml", ".yml",
]);
const EXCLUDED_SEGMENTS = new Set([".git", ".next", "build", "coverage", "dist", "generated", "node_modules", "secrets", "vendor"]);
const EXCLUDED_FILES = /(?:^|\/)(?:\.env(?:\..*)?|.*\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|.*\.(?:key|pem|p12|keystore))$/i;
const SENSITIVE_QUERY = /authorization|cookie|credential|password|secret|session|(?:api|access|refresh|id)[_-]?token|api[_-]?key/i;
const MAX_FILE_BYTES = 512 * 1024;

export function createLocalRepositorySnapshot({ root = process.cwd(), revision = "HEAD", repositoryId } = {}) {
  const absoluteRoot = realpathSync(resolve(root));
  const pinnedRevision = gitText(absoluteRoot, ["rev-parse", "--verify", `${revision}^{commit}`]).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(pinnedRevision)) throw new Error("repository revision must resolve to a commit hash");
  return Object.freeze({
    root: absoluteRoot,
    repositoryId: repositoryId ?? basename(absoluteRoot),
    revision: pinnedRevision,
  });
}

export function locateCode({ snapshot, diagnosis, judgeResult, qaIr, evidenceBundle, secrets = [] }) {
  const repository = snapshotRepository(snapshot);
  const input = jsonSnapshot({ diagnosis, judgeResult, qaIr, evidenceBundle });
  const secretList = Object.freeze([...secrets].filter(Boolean).map(String));
  validateContract("QaIrDocument", input.qaIr);
  validateContract("EvidenceBundle", input.evidenceBundle);
  validateContract("JudgeResult", input.judgeResult, { qaIr: input.qaIr, evidenceBundle: input.evidenceBundle });
  validateContract("FailureDiagnosis", input.diagnosis, { judgeResult: input.judgeResult, evidenceBundle: input.evidenceBundle });

  const queries = buildQueries(input, secretList);
  const allowedFiles = trackedSourceFiles(repository);
  const matches = new Map();
  for (const query of queries) {
    for (const match of gitGrep(repository, query.term)) {
      if (!allowedFiles.has(match.path)) continue;
      const current = matches.get(match.path) ?? { path: match.path, lines: [], reasons: new Set() };
      current.lines.push(match.line);
      current.reasons.add(query.reason);
      matches.set(match.path, current);
    }
  }

  const ranked = [...matches.values()]
    .map((item) => ({ ...item, relevanceScore: score(item.reasons) }))
    .sort((left, right) => right.relevanceScore - left.relevanceScore || left.path.localeCompare(right.path))
    .slice(0, 10);
  const candidates = [];
  const snippets = [];
  for (const item of ranked) {
    const file = gitBuffer(repository.root, ["show", `${repository.revision}:${item.path}`]);
    const lines = file.toString("utf8").split(/\r?\n/);
    const matchedLine = Math.max(1, Math.min(...item.lines));
    const startLine = Math.max(1, matchedLine - 3);
    const endLine = Math.min(lines.length, matchedLine + 3);
    const range = sourceRange(startLine, endLine, lines[endLine - 1]?.length ?? 0);
    candidates.push({
      path: item.path,
      range,
      relevanceScore: item.relevanceScore,
      matchReasons: [...item.reasons].sort(),
    });
    snippets.push({
      path: item.path,
      range,
      text: redactSensitiveText((lines.slice(startLine - 1, endLine).join("\n") || " ").slice(0, 32_768), secretList).slice(0, 32_768),
      contentHash: `sha256:${createHash("sha256").update(file).digest("hex")}`,
    });
  }

  const body = {
    schemaVersion: CODE_CONTEXT_VERSION,
    repositoryId: repository.repositoryId,
    revision: repository.revision,
    failureDiagnosisId: input.diagnosis.diagnosisId,
    candidates,
    snippets,
    searchAudit: {
      queries,
      strategies: ["GIT_GREP_FIXED_STRING", "PINNED_GIT_BLOB"],
    },
  };
  return validateContract("CodeContextBundle", {
    ...body,
    bundleId: stableId("code-context", body),
  });
}

function buildQueries({ diagnosis, judgeResult, qaIr, evidenceBundle }, secrets) {
  const failedIds = new Set(judgeResult.expectationResults
    .filter((item) => ["CONTRADICTED", "NOT_OBSERVED", "AMBIGUOUS"].includes(item.status))
    .map((item) => item.expectationId));
  const scenario = qaIr.suites.flatMap((suite) => suite.scenarios).find((item) => item.id === evidenceBundle.scenarioId);
  if (!scenario) throw new Error("evidence scenario is missing from QA IR");
  const queries = [];
  for (const expectation of scenario.expectations.filter((item) => failedIds.has(item.id))) {
    addQuery(queries, expectation.target?.testId, "TEST_ID_MATCH", secrets);
    addQuery(queries, literal(expectation.text) ?? literal(expectation.target?.text), "VISIBLE_TEXT_MATCH", secrets);
    const expected = literal(expectation.expected);
    addQuery(queries, expected, expectation.kind.startsWith("URL") ? "ROUTE_MATCH" : "VISIBLE_TEXT_MATCH", secrets);
  }
  for (const step of scenario.steps.filter((item) => item.kind === "NAVIGATE")) addQuery(queries, step.target?.value, "ROUTE_MATCH", secrets);

  const evidenceRefs = new Set(diagnosis.supportingEvidenceRefs);
  for (const fact of evidenceBundle.facts.filter((item) => evidenceRefs.has(item.id))) {
    const url = typeof fact.value === "string" ? fact.value : fact.value?.url;
    if (typeof url !== "string") continue;
    let term = url;
    try {
      const parsed = new URL(url, "https://qa.invalid");
      term = `${parsed.pathname}${parsed.search}`;
    } catch {
      // Keep the literal structured evidence value.
    }
    addQuery(queries, term, /NETWORK|HTTP|API/i.test(fact.kind) ? "NETWORK_ENDPOINT_MATCH" : "ROUTE_MATCH", secrets);
  }
  return uniqueQueries(queries).slice(0, 20);
}

function addQuery(queries, value, reason, secrets) {
  if (typeof value !== "string") return;
  const term = value.trim();
  if (term.length < 2 || term.length > 200 || /[\r\n\0]/.test(term) || SENSITIVE_QUERY.test(term) || secrets.some((secret) => term.includes(secret)) || redactSensitiveText(term, secrets) !== term) return;
  queries.push({ term, reason });
}

function trackedSourceFiles(repository) {
  const output = gitBuffer(repository.root, ["ls-tree", "-r", "-l", "-z", repository.revision]);
  const files = new Set();
  for (const entry of output.toString("utf8").split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("\t");
    const header = entry.slice(0, separator).trim().split(/\s+/);
    const path = entry.slice(separator + 1);
    const size = Number(header.at(-1));
    if (Number.isFinite(size) && size <= MAX_FILE_BYTES && safeSourcePath(path)) files.add(path);
  }
  return files;
}

function safeSourcePath(path) {
  const segments = path.split("/");
  return SOURCE_EXTENSIONS.has(extname(path).toLowerCase())
    && !/[\r\n\0]/.test(path)
    && !segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))
    && !EXCLUDED_FILES.test(path);
}

function gitGrep(repository, term) {
  const result = spawnSync("git", ["-C", repository.root, "grep", "-n", "-I", "-F", "-z", "-e", term, repository.revision, "--"], {
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(`git grep failed: ${result.stderr.toString("utf8").trim()}`);
  const prefix = Buffer.from(`${repository.revision}:`);
  const matches = [];
  let offset = 0;
  while (offset < result.stdout.length) {
    const pathEnd = result.stdout.indexOf(0, offset);
    const lineEnd = result.stdout.indexOf(0, pathEnd + 1);
    const recordEnd = result.stdout.indexOf(10, lineEnd + 1);
    if (pathEnd < 0 || lineEnd < 0) break;
    const identifier = result.stdout.subarray(offset, pathEnd);
    const line = Number(result.stdout.subarray(pathEnd + 1, lineEnd).toString("utf8"));
    if (identifier.subarray(0, prefix.length).equals(prefix) && Number.isInteger(line)) {
      matches.push({ path: identifier.subarray(prefix.length).toString("utf8"), line });
    }
    offset = recordEnd < 0 ? result.stdout.length : recordEnd + 1;
  }
  return matches;
}

function snapshotRepository(snapshot) {
  const copy = jsonSnapshot(snapshot);
  if (!copy || Object.keys(copy).some((key) => !["root", "repositoryId", "revision"].includes(key)) || typeof copy.root !== "string" || typeof copy.repositoryId !== "string" || typeof copy.revision !== "string") {
    throw new TypeError("snapshot must come from createLocalRepositorySnapshot");
  }
  const root = realpathSync(copy.root);
  const revision = gitText(root, ["rev-parse", "--verify", `${copy.revision}^{commit}`]).trim();
  if (revision !== copy.revision) throw new Error("repository snapshot revision is not pinned to an exact commit");
  return { root, repositoryId: copy.repositoryId, revision };
}

function sourceRange(startLine, endLine, endLength) {
  return {
    start: { line: startLine, column: 1 },
    end: { line: endLine, column: Math.max(1, endLength + 1) },
  };
}

function score(reasons) {
  const weights = {
    STACK_TRACE_MATCH: 0.6,
    TEST_ID_MATCH: 0.45,
    NETWORK_ENDPOINT_MATCH: 0.4,
    ROUTE_MATCH: 0.3,
    VISIBLE_TEXT_MATCH: 0.2,
    RECENTLY_CHANGED: 0.15,
    DEPENDENCY_MATCH: 0.15,
  };
  return Math.min(1, [...reasons].reduce((total, reason) => total + weights[reason], 0));
}

function literal(value) {
  if (typeof value === "string") return value;
  return value?.kind === "literal" || value?.kind === "TEXT" ? value.value : undefined;
}

function uniqueQueries(queries) {
  const seen = new Set();
  return queries.filter((query) => {
    const key = `${query.reason}\0${query.term}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function jsonSnapshot(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("repository locator input must be JSON-serializable");
  return JSON.parse(serialized);
}

function gitText(root, args) {
  return gitBuffer(root, args).toString("utf8");
}

function gitBuffer(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString("utf8").trim()}`);
  return result.stdout;
}

function stableId(prefix, value) {
  return `${prefix}-${canonicalHash(value).slice("sha256:".length, "sha256:".length + 16)}`;
}
