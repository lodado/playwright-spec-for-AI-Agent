import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { GITHUB_PUBLICATION_RESULT_VERSION, canonicalHash, validateContract } from "../contracts/index.mjs";
import { redactSensitiveText, verifyEvidenceBundleIdentity } from "../evidence/index.mjs";
import { diagnoseFailure, recommendRepair } from "../remediation/index.mjs";

const DEFAULT_LABELS = ["qa-runtime", "auto-generated"];
const MAX_GITHUB_RESPONSE_BYTES = 1024 * 1024;
const MAX_PUBLICATION_MATCHES = 10;
const MAX_SEEN_PUBLICATION_SOURCES = 50;
const PUBLICATION_KEY_ID = "publication-v1";
const GITHUB_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "LANG", "LC_ALL", "LC_CTYPE"];

export function createGitHubCliIssueTransport({ spawn = spawnSync } = {}) {
  if (typeof spawn !== "function") throw new TypeError("GitHub CLI spawn must be a function");
  return Object.freeze({
    async findOpenPublications({ repository, fingerprint }) {
      const target = repositorySlug(repository);
      if (!/^sha256:[0-9a-f]{64}$/.test(fingerprint)) throw new Error("GitHub publication fingerprint is invalid");
      const matches = [];
      const seen = new Set();
      const search = runGhJson(spawn, ["api", "--method", "GET", "search/issues", "-f", `q=repo:${target} is:open in:body label:qa-runtime \"qa-fingerprint: ${fingerprint}\"`, "-f", `per_page=${MAX_PUBLICATION_MATCHES}`, "--jq", "{total_count,items:[.items[]|{number,state,html_url,pull_request}]}" ]);
      if (!search || !Number.isSafeInteger(search.total_count) || search.total_count < 0 || search.total_count > MAX_PUBLICATION_MATCHES || !Array.isArray(search.items) || search.items.length > MAX_PUBLICATION_MATCHES) throw new Error("GitHub publication search is ambiguous");
      for (const item of search.items) {
        if (!item || item.state !== "open" || !Number.isSafeInteger(item.number) || item.number < 1 || seen.has(item.number)) continue;
        const publication = item.pull_request === undefined ? "ISSUE" : "DRAFT_PR";
        const found = awaitGitHubPublication(spawn, target, { publication, number: item.number, url: item.html_url });
        if (!hasFingerprintMarker(found.body, fingerprint)) continue;
        matches.push(found);
        seen.add(item.number);
      }
      return matches;
    },
    async findRecentPublications({ repository, fingerprint, since }) {
      const target = repositorySlug(repository);
      if (!/^sha256:[0-9a-f]{64}$/.test(fingerprint) || !Number.isFinite(Date.parse(since))) throw new Error("GitHub recent publication search input is invalid");
      const items = runGhJson(spawn, ["api", "--method", "GET", `repos/${target}/issues`, "-f", "state=open", "-f", "labels=qa-runtime", "-f", `since=${since}`, "-f", "per_page=100", "--jq", "[.[]|{number,state,html_url,pull_request,body:([.body|split(\"\\n\")[]|select(startswith(\"<!-- qa-fingerprint:\"))|.[:128]][:11]|join(\"\\n\"))}]"]);
      if (!Array.isArray(items) || items.length >= 100) throw new Error("GitHub recent publication search is ambiguous");
      return items.flatMap((item) => {
        if (!item || item.state !== "open" || !Number.isSafeInteger(item.number) || item.number < 1 || typeof item.body !== "string" || !hasFingerprintMarker(item.body, fingerprint)) return [];
        const publication = item.pull_request === undefined ? "ISSUE" : "DRAFT_PR";
        return [awaitGitHubPublication(spawn, target, { publication, number: item.number, url: item.html_url })];
      });
    },
    async readPublication({ repository, publication, number, url }) {
      return awaitGitHubPublication(spawn, repositorySlug(repository), { publication, number, url });
    },
    async verifyCodeContext({ repository, revision, files }) {
      const target = repositorySlug(repository);
      if (typeof revision !== "string" || !/^[0-9a-f]{40,64}$/i.test(revision) || !Array.isArray(files) || files.length > 10) throw new Error("GitHub Code Context verification input is invalid");
      const commit = runGh(spawn, ["api", "--method", "GET", `repos/${target}/commits/${revision}`, "--jq", ".sha"]).toString("utf8").trim();
      if (commit.toLowerCase() !== revision.toLowerCase()) return false;
      for (const file of files) {
        if (!file || typeof file.path !== "string" || !/^[^\0\r\n\\]+$/.test(file.path) || file.path.split("/").some((part) => !part || part === "." || part === "..") || typeof file.contentHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(file.contentHash)) throw new Error("GitHub Code Context verification input is invalid");
        const content = runGh(spawn, ["api", "--method", "GET", `repos/${target}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}`, "-f", `ref=${revision}`, "-H", "Accept: application/vnd.github.raw+json"]);
        if (`sha256:${createHash("sha256").update(content).digest("hex")}` !== file.contentHash) return false;
      }
      return true;
    },
    async createIssue({ repository, title, body, labels }) {
      const target = repositorySlug(repository);
      if (typeof title !== "string" || title.length === 0 || title.length > 240 || typeof body !== "string" || body.length === 0 || body.length > 65_536) throw new Error("GitHub Issue request is invalid");
      const safeLabels = validateLabels(labels, []);
      const args = ["issue", "create", "--repo", target, "--title", title, "--body-file", "-"];
      for (const label of safeLabels) args.push("--label", label);
      const url = runGh(spawn, args, body).toString("utf8").trim();
      const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/([1-9][0-9]*)$/i.exec(url);
      if (!match) throw new Error("GitHub CLI returned an invalid Issue URL");
      return { number: Number(match[1]), url };
    },
    async listOccurrenceRecords({ repository, publication, number, url }) {
      const target = repositorySlug(repository);
      publicationTarget({ repository: target, publication, number, url });
      const login = runGh(spawn, ["api", "--method", "GET", "user", "--jq", ".login"]).toString("utf8").trim();
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?(?:\[bot\])?$/.test(login)) throw new Error("GitHub authenticated actor is invalid");
      const records = runGhJson(spawn, ["api", "--method", "GET", `repos/${target}/issues/${number}/comments`, "-f", "per_page=100", "--paginate", "--slurp", "--jq", `[.[][]|select(.user.login==${JSON.stringify(login)} and (.body|contains(\"qa-occurrence:\")))|{id,html_url,body:([.body|split(\"\\n\")[]|select(startswith(\"<!-- qa-occurrence:\"))|.[:2048]][:1]|join(\"\\n\")),created_at}]`]);
      if (!Array.isArray(records) || records.length > 500) throw new Error("GitHub occurrence search returned invalid data");
      return records;
    },
    async createOccurrenceRecord({ repository, publication, number, url, body }) {
      const target = repositorySlug(repository);
      publicationTarget({ repository: target, publication, number, url });
      if (typeof body !== "string" || body.length === 0 || body.length > 8_192) throw new Error("GitHub occurrence record is invalid");
      const created = runGhJson(spawn, ["api", "--method", "POST", `repos/${target}/issues/${number}/comments`, "--input", "-"], Buffer.from(JSON.stringify({ body })));
      if (!Number.isSafeInteger(created?.id) || created.id < 1 || typeof created.html_url !== "string" || created.body !== body || typeof created.created_at !== "string") throw new Error("GitHub occurrence record creation returned invalid data");
      const createdUrl = new URL(created.html_url);
      const createdAt = Date.parse(created.created_at);
      if (createdUrl.protocol !== "https:" || createdUrl.hostname !== "github.com" || createdUrl.port || createdUrl.username || createdUrl.password || createdUrl.search || createdUrl.pathname.toLowerCase() !== `/${target}/issues/${number}`.toLowerCase() || createdUrl.hash !== `#issuecomment-${created.id}` || !Number.isFinite(createdAt) || new Date(createdAt).toISOString() !== created.created_at) throw new Error("GitHub occurrence record creation returned invalid data");
      return { id: created.id, url: created.html_url, body: created.body, createdAt: created.created_at };
    },
  });
}

export function createGitHubCliDraftTransport({ spawn = spawnSync } = {}) {
  if (typeof spawn !== "function") throw new TypeError("GitHub CLI spawn must be a function");
  return Object.freeze({
    async publishDraft({ action, repository, decision, worktreePath, files, expectedDiffHash, title, body, labels, target }) {
      const root = realpathSync(worktreePath);
      const targetRepository = repositorySlug(repository);
      if (!decision?.eligibleDraft || !["CREATE_DRAFT_PR", "UPDATE_DRAFT_PR"].includes(action) || !/^qa\/fix-[a-z0-9-]+$/.test(decision.branch) || !Array.isArray(files) || files.length === 0 || files.length > 10 || !/^sha256:[0-9a-f]{64}$/.test(expectedDiffHash)) throw new Error("GitHub Draft PR input is invalid");
      if (files.some((path) => typeof path !== "string" || !/^[^\0\r\n\\]+$/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".."))) throw new Error("GitHub Draft PR files are invalid");
      const head = runGit(spawn, root, ["rev-parse", "HEAD"]).toString("utf8").trim();
      if (head === decision.baseRevision) {
        assertDraftDiff(spawn, root, ["HEAD"], files, expectedDiffHash);
        runGit(spawn, root, ["add", "--", ...files]);
        const staged = runGit(spawn, root, ["diff", "--cached", "--name-only", "--"]).toString("utf8").trim().split("\n").filter(Boolean).sort();
        const expected = [...files].sort();
        if (staged.length !== expected.length || staged.some((path, index) => path !== expected[index])) throw new Error("GitHub Draft PR staged diff is invalid");
        runGit(spawn, root, ["-c", "user.name=qa-native[bot]", "-c", "user.email=qa-native@users.noreply.github.com", "commit", "-m", `fix(qa): apply ${decision.source.proposalId}`]);
      }
      assertDraftDiff(spawn, root, [`${decision.baseRevision}..HEAD`], files, expectedDiffHash);
      if (runGit(spawn, root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).byteLength > 0) throw new Error("GitHub Draft PR worktree is not clean");
      const branch = action === "UPDATE_DRAFT_PR" ? readDraftHead(spawn, targetRepository, target) : decision.branch;
      const pushArgs = ["push", ...(action === "UPDATE_DRAFT_PR" ? ["--force-with-lease"] : []), "origin", `HEAD:refs/heads/${branch}`];
      runGit(spawn, root, pushArgs);
      if (action === "UPDATE_DRAFT_PR") {
        runGh(spawn, ["pr", "edit", String(target.number), "--repo", targetRepository, "--title", title, "--body-file", "-", ...labels.flatMap((label) => ["--add-label", label])], Buffer.from(body));
        return { number: target.number, url: target.url };
      }
      const base = runGh(spawn, ["repo", "view", targetRepository, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]).toString("utf8").trim();
      if (!/^[A-Za-z0-9._/-]{1,255}$/.test(base)) throw new Error("GitHub default branch is invalid");
      const url = runGh(spawn, ["pr", "create", "--draft", "--repo", targetRepository, "--base", base, "--head", branch, "--title", title, "--body-file", "-", ...labels.flatMap((label) => ["--label", label])], Buffer.from(body)).toString("utf8").trim();
      const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/([1-9][0-9]*)$/i.exec(url);
      if (!match) throw new Error("GitHub CLI returned an invalid Draft PR URL");
      return { number: Number(match[1]), url };
    },
  });
}

export async function publishGitHubFailureIssue({
  repository,
  qaIr,
  judgeResult,
  evidenceBundle,
  diagnosis,
  codeContext,
  recommendation,
  labels,
  secrets = [],
  stateAuthenticationKey,
  verifyCodeContext,
  findOpenPublications,
  findRecentPublications,
  readPublication,
  listOccurrenceRecords,
  createOccurrenceRecord,
  transport,
} = {}) {
  if (typeof transport !== "function") throw new TypeError("GitHub Issue transport must be a function");
  if (typeof verifyCodeContext !== "function") throw new TypeError("GitHub Code Context verifier must be a function");
  if ([findOpenPublications, findRecentPublications, readPublication, listOccurrenceRecords, createOccurrenceRecord].some((value) => typeof value !== "function")) throw new TypeError("GitHub publication upsert transport is incomplete");
  assertStateAuthenticationKey(stateAuthenticationKey);
  const input = jsonSnapshot({ qaIr, judgeResult, evidenceBundle, diagnosis, codeContext, recommendation });
  const targetRepository = repositorySlug(repository);
  validateInputs(input, secrets, targetRepository);
  const safeLabels = validateLabels([...new Set(["qa-runtime", ...(labels ?? issueLabels(input, secrets))])], secrets);
  const publicationFingerprint = createFailureFingerprint({ ...input, secrets });
  const title = issueTitle(input, secrets);
  const firstSeen = occurrenceTimestamp(input.evidenceBundle.capturedAt);
  const occurrence = { count: 1, firstSeen, lastSeen: firstSeen };
  const source = publicationSource(input);
  const sourceId = publicationSourceId(source);
  const body = renderGitHubFailureIssue({ ...input, publicationFingerprint, occurrence, seenSourceIds: [sourceId], stateAuthenticationKey, secrets });
  const occurrenceBody = renderGitHubOccurrenceRecord({ repository: targetRepository, publicationFingerprint, source, occurredAt: firstSeen, stateAuthenticationKey, secrets });
  const files = input.codeContext.snippets.map(({ path, contentHash }) => ({ path, contentHash }));
  if (await verifyCodeContext({ repository: targetRepository, revision: input.codeContext.revision, files }) !== true) throw new Error("GitHub repository does not match the pinned Code Context");
  const matches = publicationMatches(await findOpenPublications({ repository: targetRepository, fingerprint: publicationFingerprint }), targetRepository, publicationFingerprint, stateAuthenticationKey);
  if (matches.length > 1) return ambiguousPublicationResult({ repository: targetRepository, source, publicationFingerprint, matches });
  if (matches.length === 1) {
    const match = matches[0];
    const records = occurrenceRecords(await listOccurrenceRecords({ repository: targetRepository, ...match }), targetRepository, publicationFingerprint, stateAuthenticationKey);
    if (records.some((record) => record.sourceId === sourceId)) return publicationResult({ repository: targetRepository, publication: match.publication, action: "NOOP", target: match, occurrence: occurrenceFromRecords(records), source, publicationFingerprint });
    await createOccurrenceRecord({ repository: targetRepository, ...match, body: occurrenceBody });
    const confirmedRecords = occurrenceRecords(await listOccurrenceRecords({ repository: targetRepository, ...match }), targetRepository, publicationFingerprint, stateAuthenticationKey);
    if (!confirmedRecords.some((record) => record.sourceId === sourceId)) throw new Error("GitHub occurrence record could not be confirmed");
    const confirmed = publicationMatches(await findOpenPublications({ repository: targetRepository, fingerprint: publicationFingerprint }), targetRepository, publicationFingerprint, stateAuthenticationKey);
    if (confirmed.length > 1) return ambiguousPublicationResult({ repository: targetRepository, source, publicationFingerprint, matches: confirmed });
    return publicationResult({ repository: targetRepository, publication: match.publication, action: "UPDATED", target: match, occurrence: occurrenceFromRecords(confirmedRecords), source, publicationFingerprint });
  }
  const recentSince = new Date(Date.now() - 5 * 60_000).toISOString();
  const published = await transport({ repository: targetRepository, title, body, labels: safeLabels });
  const target = publicationTarget({ repository: targetRepository, publication: "ISSUE", number: published?.number, url: published?.url });
  const created = await readPublication({ repository: targetRepository, ...target });
  const confirmedTarget = publicationMatch({ repository: targetRepository, publication: created?.publication, number: created?.number, url: created?.url, body: created?.body });
  const createdState = parsePublicationState(confirmedTarget.body, targetRepository, publicationFingerprint, stateAuthenticationKey);
  if (confirmedTarget.publication !== target.publication || confirmedTarget.number !== target.number || createdState.occurrence.count !== 1 || !createdState.seenSourceIds.includes(sourceId)) throw new Error("GitHub Issue creation could not be confirmed");
  await createOccurrenceRecord({ repository: targetRepository, ...target, body: occurrenceBody });
  const records = occurrenceRecords(await listOccurrenceRecords({ repository: targetRepository, ...target }), targetRepository, publicationFingerprint, stateAuthenticationKey);
  if (!records.some((record) => record.sourceId === sourceId)) throw new Error("GitHub occurrence record could not be confirmed");
  const reconciled = publicationMatches(await findRecentPublications({ repository: targetRepository, fingerprint: publicationFingerprint, since: recentSince }), targetRepository, publicationFingerprint, stateAuthenticationKey);
  const conflicts = reconciled.filter((match) => match.publication !== target.publication || match.number !== target.number);
  if (conflicts.length > 0) return ambiguousPublicationResult({ repository: targetRepository, source, publicationFingerprint, matches: [target, ...conflicts] });
  return publicationResult({ repository: targetRepository, publication: "ISSUE", action: "CREATED", target, occurrence: occurrenceFromRecords(records), source, publicationFingerprint });
}

export async function publishGitHubVerifiedDraft({ repository, qaIr, judgeResult, evidenceBundle, diagnosis, codeContext, recommendation, proposal, application, verification, comparison, integrity, review, decision, worktreePath, secrets = [], stateAuthenticationKey, findOpenPublications, readPublication, listOccurrenceRecords, createOccurrenceRecord, publishDraft } = {}) {
  if ([findOpenPublications, readPublication, listOccurrenceRecords, createOccurrenceRecord, publishDraft].some((value) => typeof value !== "function")) throw new TypeError("GitHub Draft PR transport is incomplete");
  assertStateAuthenticationKey(stateAuthenticationKey);
  const input = jsonSnapshot({ qaIr, judgeResult, evidenceBundle, diagnosis, codeContext, recommendation, proposal, application, verification, comparison, integrity, review, decision });
  validateInputs(input, secrets, repository);
  validateContract("PatchProposal", input.proposal, { diagnosis: input.diagnosis, codeContext: input.codeContext, recommendation: input.recommendation });
  validateContract("PatchApplicationResult", input.application, { proposal: input.proposal });
  validateContract("VerificationResult", input.verification, { proposal: input.proposal, application: input.application });
  validateContract("EvidenceComparison", input.comparison, { proposal: input.proposal, application: input.application, verification: input.verification });
  validateContract("ExpectationIntegrityResult", input.integrity, { proposal: input.proposal, application: input.application, verification: input.verification, comparison: input.comparison });
  validateContract("IndependentRemediationReview", input.review, { proposal: input.proposal, application: input.application, verification: input.verification, comparison: input.comparison, integrity: input.integrity });
  validateContract("PublicationDecision", input.decision);
  const targetRepository = repositorySlug(repository);
  if (!input.decision.eligibleDraft || !["CREATE_DRAFT_PR", "UPDATE_DRAFT_PR"].includes(input.decision.action) || input.decision.repository.toLowerCase() !== targetRepository.toLowerCase()) throw new Error("GitHub Draft PR decision is not eligible");
  if (input.verification.status !== "PASS" || input.comparison.conclusion !== "IMPROVED" || input.comparison.newlyFailedExpectationIds.length > 0 || input.integrity.weakened || input.integrity.manualReview || input.review.decision !== "APPROVE_DRAFT") throw new Error("GitHub Draft PR deterministic gates failed");
  for (const [sourceKey, value] of [["proposalId", input.proposal.proposalId], ["applicationId", input.application.applicationId], ["verificationId", input.verification.verificationId], ["comparisonId", input.comparison.comparisonId], ["integrityId", input.integrity.integrityId], ["reviewId", input.review.reviewId]]) if (input.decision.source[sourceKey] !== value) throw new Error("GitHub Draft PR decision artifact binding is invalid");
  const publicationFingerprint = input.decision.publicationFingerprint;
  const source = publicationSource(input);
  const sourceId = publicationSourceId(source);
  const matches = publicationMatches(await findOpenPublications({ repository: targetRepository, fingerprint: publicationFingerprint }), targetRepository, publicationFingerprint, stateAuthenticationKey);
  if (matches.length > 1) return ambiguousPublicationResult({ repository: targetRepository, source, publicationFingerprint, matches });
  const match = matches[0];
  if ((input.decision.action === "CREATE_DRAFT_PR" && match) || (input.decision.action === "UPDATE_DRAFT_PR" && (!match || match.publication !== "DRAFT_PR" || match.number !== input.decision.target.number))) throw new Error("GitHub Draft PR decision is stale");
  const records = match ? occurrenceRecords(await listOccurrenceRecords({ repository: targetRepository, ...match }), targetRepository, publicationFingerprint, stateAuthenticationKey) : [];
  if (records.some((record) => record.sourceId === sourceId)) return publicationResult({ repository: targetRepository, publication: "DRAFT_PR", action: "NOOP", target: match, occurrence: occurrenceFromRecords(records), source, publicationFingerprint });
  const occurredAt = occurrenceTimestamp(input.evidenceBundle.capturedAt);
  const nextSources = [...records.map((record) => record.sourceId), sourceId];
  const nextTimes = [...records.map((record) => record.occurredAt), occurredAt].sort();
  const occurrence = { count: nextSources.length, firstSeen: nextTimes[0], lastSeen: nextTimes.at(-1) };
  const body = renderGitHubRemediationDraft({ ...input, repository: targetRepository, publicationFingerprint, occurrence, seenSourceIds: nextSources, source, stateAuthenticationKey, secrets });
  const title = safePlainText(`[QA fix] ${input.diagnosis.symptom}`, secrets).slice(0, 240);
  const labels = validateLabels(["qa-generated", "needs-human-review", `origin:${input.diagnosis.origin.toLowerCase().replaceAll("_", "-")}`], secrets);
  const published = await publishDraft({ action: input.decision.action, repository: targetRepository, decision: input.decision, worktreePath, files: input.application.appliedFiles.map((file) => file.path), expectedDiffHash: input.application.diff.contentHash, title, body, labels, ...(match ? { target: match } : {}) });
  const target = publicationTarget({ repository: targetRepository, publication: "DRAFT_PR", number: published?.number, url: published?.url });
  const confirmed = publicationMatch({ repository: targetRepository, ...(await readPublication({ repository: targetRepository, ...target })) });
  if (confirmed.publication !== "DRAFT_PR" || confirmed.number !== target.number || !hasFingerprintMarker(confirmed.body, publicationFingerprint)) throw new Error("GitHub Draft PR publication could not be confirmed");
  parsePublicationState(confirmed.body, targetRepository, publicationFingerprint, stateAuthenticationKey);
  await createOccurrenceRecord({ repository: targetRepository, ...target, body: renderGitHubOccurrenceRecord({ repository: targetRepository, publicationFingerprint, source, occurredAt, stateAuthenticationKey, secrets }) });
  const confirmedRecords = occurrenceRecords(await listOccurrenceRecords({ repository: targetRepository, ...target }), targetRepository, publicationFingerprint, stateAuthenticationKey);
  if (!confirmedRecords.some((record) => record.sourceId === sourceId)) throw new Error("GitHub Draft PR occurrence could not be confirmed");
  return publicationResult({ repository: targetRepository, publication: "DRAFT_PR", action: match ? "UPDATED" : "CREATED", target, occurrence: occurrenceFromRecords(confirmedRecords), source, publicationFingerprint });
}

export function createFailureFingerprint({ qaIr, judgeResult, evidenceBundle, diagnosis, codeContext, secrets = [] } = {}) {
  const input = jsonSnapshot({ qaIr, judgeResult, evidenceBundle, diagnosis, codeContext });
  validateInputs(input, secrets);
  const expectationIds = input.judgeResult.expectationResults
    .filter((result) => !["MATCHED", "NOT_APPLICABLE"].includes(result.status))
    .map((result) => result.expectationId)
    .sort();
  return canonicalHash({
    scenarioId: input.evidenceBundle.scenarioId,
    expectationIds,
    failureOrigin: input.diagnosis.origin,
    normalizedSymptom: input.diagnosis.symptom.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 1_000),
    route: fingerprintRoute(input.evidenceBundle.environment.targetUrl),
    componentHint: [...input.codeContext.candidates].sort((left, right) => right.relevanceScore - left.relevanceScore || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))[0]?.path ?? "UNLOCATED",
  });
}

export function renderGitHubRemediationDraft({ repository, qaIr, evidenceBundle, diagnosis, proposal, application, verification, comparison, integrity, review, decision, publicationFingerprint, occurrence, seenSourceIds, source, stateAuthenticationKey, secrets = [] }) {
  assertStateAuthenticationKey(stateAuthenticationKey);
  const scenario = qaIr?.suites?.flatMap((suite) => suite.scenarios).find((item) => item.id === evidenceBundle?.scenarioId);
  if (!scenario || decision?.publicationFingerprint !== publicationFingerprint || !validOccurrence(occurrence) || !validSeenSourceIds(seenSourceIds) || seenSourceIds.length !== occurrence.count) throw new Error("GitHub Draft PR rendering input is invalid");
  const checks = verification.checks.map((check) => `- ${safePlainText(check.name, secrets)}: **${check.status}**`);
  const risks = [...new Set([...proposal.risks, ...review.risks])];
  const body = [
    "<!-- qa-runtime:start -->",
    "## Verified QA remediation",
    "",
    `**${safePlainText(scenario.title, secrets)}**`,
    "",
    `- Origin: **${diagnosis.origin}**`,
    `- Base revision: ${code(application.baseRevision, secrets)}`,
    `- Patch Proposal: ${code(proposal.proposalId, secrets)}`,
    `- Verification: ${code(verification.verificationId, secrets)} — **${verification.status}**`,
    `- Evidence Comparison: ${code(comparison.comparisonId, secrets)} — **${comparison.conclusion}**`,
    `- Expectation Integrity: ${code(integrity.integrityId, secrets)} — **${integrity.weakened ? "WEAKENED" : integrity.manualReview ? "MANUAL_REVIEW" : "PASS"}**`,
    `- Independent Review: ${code(review.reviewId, secrets)} — **${review.decision}**`,
    "",
    "### Failure",
    safePlainText(diagnosis.symptom, secrets),
    "",
    "### Change intent",
    safePlainText(proposal.intent, secrets),
    "",
    "### Applied files",
    ...application.appliedFiles.map((file) => `- ${code(file.path, secrets)} (${file.action})`),
    "",
    "### Deterministic checks",
    ...checks,
    "",
    "### Before / after evidence",
    `- Before: ${code(comparison.before.evidenceBundleId, secrets)} / ${code(comparison.before.judgeResultId, secrets)}`,
    `- After: ${code(comparison.after.evidenceBundleId, secrets)} / ${code(comparison.after.judgeResultId, secrets)}`,
    `- Fixed expectations: ${comparison.fixedExpectationIds.map((id) => code(id, secrets)).join(", ") || "none"}`,
    `- Newly failed expectations: ${comparison.newlyFailedExpectationIds.map((id) => code(id, secrets)).join(", ") || "none"}`,
    "",
    "### Risks",
    ...(risks.length > 0 ? risks.map((risk) => `- ${safePlainText(risk, secrets)}`) : ["- none reported"]),
    "",
    "### Reproduce",
    `1. Inspect private run ${code(evidenceBundle.runId, secrets)}.`,
    "2. Re-run the trusted repository verification configuration.",
    "3. Re-run the original live QA scenario and compare authenticated evidence.",
    "",
    "This pull request is a draft and requires human review. qa-native never merges automatically.",
    "",
    `<!-- qa-fingerprint: ${publicationFingerprint} -->`,
    publicationStateMarker({ repository, publicationFingerprint, occurrence, seenSourceIds, source, stateAuthenticationKey }),
    "<!-- qa-runtime:end -->",
  ].join("\n");
  if (body.length > 65_536) throw new Error("GitHub Draft PR body exceeds size limit");
  return body;
}

export function renderGitHubFailureIssue({ qaIr, judgeResult, evidenceBundle, diagnosis, codeContext, recommendation, secrets = [], stateAuthenticationKey, publicationFingerprint = createFailureFingerprint({ qaIr, judgeResult, evidenceBundle, diagnosis, codeContext, secrets }), occurrence = { count: 1, firstSeen: evidenceBundle?.capturedAt, lastSeen: evidenceBundle?.capturedAt }, seenSourceIds } = {}) {
  assertStateAuthenticationKey(stateAuthenticationKey);
  if (!/^sha256:[0-9a-f]{64}$/.test(publicationFingerprint)) throw new Error("GitHub publication fingerprint is invalid");
  if (!validOccurrence(occurrence)) throw new Error("GitHub publication occurrence is invalid");
  const input = jsonSnapshot({ qaIr, judgeResult, evidenceBundle, diagnosis, codeContext, recommendation });
  validateInputs(input, secrets);
  const source = publicationSource(input);
  const normalizedSeenSourceIds = seenSourceIds ?? [publicationSourceId(source)];
  if (!validSeenSourceIds(normalizedSeenSourceIds) || normalizedSeenSourceIds.length !== occurrence.count) throw new Error("GitHub publication occurrence history is invalid");
  const scenario = input.qaIr.suites.flatMap((suite) => suite.scenarios).find((item) => item.id === input.evidenceBundle.scenarioId);
  const unresolved = input.judgeResult.expectationResults.filter((item) => !["MATCHED", "NOT_APPLICABLE"].includes(item.status));
  const expected = unresolved.map((result) => {
    const expectation = scenario.expectations.find((item) => item.id === result.expectationId);
    return `${code(result.expectationId, secrets)} — ${safeText(expectationSummary(expectation), secrets)}`;
  });
  const observed = unresolved.map((result) => `${code(result.expectationId, secrets)} — ${safeText(result.rationale, secrets)}`);
  const locations = input.codeContext.candidates.map((candidate) => {
    const range = candidate.range ? `:${candidate.range.start.line}-${candidate.range.end.line}` : "";
    return `${code(`${candidate.path}${range}`, secrets)} — ${safeText(candidate.matchReasons.join(", "), secrets)}`;
  });
  const finalUrl = safeUrl(input.evidenceBundle.environment.targetUrl, secrets);
  const lines = [
    "<!-- qa-runtime:start -->",
    "## QA failure",
    "",
    `- Scenario: **${safeText(scenario.title, secrets)}** (${code(scenario.id, secrets)})`,
    `- Verdict: **${input.judgeResult.verdict}**`,
    `- Origin: **${input.diagnosis.origin}**`,
    `- Confidence: **${input.diagnosis.confidence.toFixed(2)}**`,
    `- Run: ${code(input.evidenceBundle.runId, secrets)}`,
    `- Judge Result: ${code(input.judgeResult.resultId, secrets)}`,
    `- Evidence Bundle: ${code(input.evidenceBundle.bundleId, secrets)}`,
    `- Repository revision: ${code(input.codeContext.revision, secrets)}`,
    `- Occurrence count: **${occurrence.count}**`,
    `- First seen: ${code(occurrence.firstSeen, secrets)}`,
    `- Last seen: ${code(occurrence.lastSeen, secrets)}`,
    "",
    "## Symptom",
    "",
    safeText(input.diagnosis.symptom, secrets),
    "",
    "## Expected",
    "",
    ...list(expected, "No bounded expectation summary is available."),
    "",
    "## Observed",
    "",
    ...list(observed, "The Judge did not provide a bounded observation rationale."),
    "",
    "## Evidence",
    "",
    ...list(input.diagnosis.supportingEvidenceRefs.map((ref) => code(ref, secrets)), "No supporting evidence reference."),
    `- Final safe URL: ${code(finalUrl, secrets)}`,
    `- Final checkpoint: ${code(input.evidenceBundle.checkpointId, secrets)}`,
    "",
    "## Suspected locations",
    "",
    ...list(locations, "No repository location met the deterministic relevance threshold."),
    "",
    "## Uncertainty / manual review",
    "",
    ...list([
      ...input.judgeResult.uncertainty.map((item) => `${safeText(item.code, secrets)} — ${safeText(item.description, secrets)}`),
      ...input.diagnosis.manualReviewReasons.map((reason) => safeText(reason, secrets)),
    ], "No additional uncertainty was recorded."),
    "",
    "## Reproduction",
    "",
    code(`qa-native replay --run-dir=.qa/runs/${safeRunId(input.evidenceBundle.runId)}`, secrets),
    "",
    `Diagnosis: ${code(input.diagnosis.diagnosisId, secrets)}`,
    `Code context: ${code(input.codeContext.bundleId, secrets)}`,
    ...(input.recommendation ? [`Repair recommendation: ${code(input.recommendation.recommendationId, secrets)}`] : []),
    "",
    `<!-- qa-fingerprint: ${publicationFingerprint} -->`,
    publicationStateMarker({ repository: input.codeContext.repositoryId, publicationFingerprint, occurrence, seenSourceIds: normalizedSeenSourceIds, source, stateAuthenticationKey }),
    "<!-- qa-runtime:end -->",
  ];
  const body = lines.join("\n");
  if (body.length > 65_536) throw new Error("GitHub Issue body exceeds size limit");
  return body;
}

function validateInputs(input, secrets, repository) {
  validateContract("QaIrDocument", input.qaIr);
  validateContract("EvidenceBundle", input.evidenceBundle);
  verifyEvidenceBundleIdentity(input.evidenceBundle);
  validateContract("JudgeResult", input.judgeResult, { qaIr: input.qaIr, evidenceBundle: input.evidenceBundle });
  verifyStableId("judge", "resultId", input.judgeResult);
  if (!["FAIL", "MANUAL_REVIEW"].includes(input.judgeResult.verdict)) throw new Error("only failed or manual-review QA results can publish an Issue");
  validateContract("FailureDiagnosis", input.diagnosis, { judgeResult: input.judgeResult, evidenceBundle: input.evidenceBundle });
  const derivedDiagnosis = diagnoseFailure({ qaIr: input.qaIr, judgeResult: input.judgeResult, evidenceBundle: input.evidenceBundle, secrets });
  if (canonicalHash(input.diagnosis) !== canonicalHash(derivedDiagnosis)) throw new Error("Failure Diagnosis does not match Judge evidence");
  validateContract("CodeContextBundle", input.codeContext);
  if (input.codeContext.failureDiagnosisId !== input.diagnosis.diagnosisId) throw new Error("Code Context does not belong to the failure diagnosis");
  if (!/^[0-9a-f]{40,64}$/i.test(input.codeContext.revision)) throw new Error("Code Context revision is not pinned");
  if (repository && input.codeContext.repositoryId.toLowerCase() !== repository.toLowerCase()) throw new Error("Code Context belongs to a different repository");
  verifyStableId("code-context", "bundleId", input.codeContext);
  const candidateKeys = input.codeContext.candidates.map((item) => `${item.path}\0${canonicalHash(item.range ?? null)}`).sort();
  const snippetKeys = input.codeContext.snippets.map((item) => `${item.path}\0${canonicalHash(item.range)}`).sort();
  if (candidateKeys.length !== snippetKeys.length || candidateKeys.some((key, index) => key !== snippetKeys[index])) throw new Error("Code Context candidates do not match pinned snippets");
  if (input.recommendation !== undefined) {
    validateContract("RepairRecommendation", input.recommendation, { diagnosis: input.diagnosis, codeContext: input.codeContext });
    const derivedRecommendation = recommendRepair({ diagnosis: derivedDiagnosis, codeContext: input.codeContext, qaIr: input.qaIr, judgeResult: input.judgeResult, evidenceBundle: input.evidenceBundle, secrets });
    if (canonicalHash(input.recommendation) !== canonicalHash(derivedRecommendation)) throw new Error("Repair Recommendation does not match deterministic remediation");
  }
}

function issueTitle({ qaIr, evidenceBundle, diagnosis }, secrets) {
  const scenario = qaIr.suites.flatMap((suite) => suite.scenarios).find((item) => item.id === evidenceBundle.scenarioId);
  return safePlainText(`[QA] ${scenario.title}: ${diagnosis.symptom}`, secrets).replaceAll("@", "@\u200b").slice(0, 240);
}

function issueLabels({ evidenceBundle, diagnosis, recommendation }, secrets) {
  const severity = recommendation?.severity.toLowerCase() ?? (diagnosis.origin === "PRODUCT_CODE" ? "medium" : "low");
  return [...DEFAULT_LABELS, `origin:${diagnosis.origin.toLowerCase().replaceAll("_", "-")}`, `severity:${severity}`, `scenario:${labelSlug(safeText(evidenceBundle.scenarioId, secrets))}`];
}

function validateLabels(labels, secrets) {
  if (!Array.isArray(labels) || labels.length === 0 || labels.length > 10 || new Set(labels).size !== labels.length || labels.some((label) => typeof label !== "string" || label.length === 0 || label.length > 50 || /[\0\r\n]/.test(label) || safePlainText(label, secrets) !== label)) throw new Error("GitHub Issue labels are invalid");
  return Object.freeze([...labels]);
}

function repositorySlug(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value) || value.split("/").some((part) => part === "." || part === "..")) throw new Error("GitHub repository must be an owner/repository slug");
  return value;
}

function expectationSummary(expectation) {
  if (!expectation) return "Expectation metadata unavailable.";
  const expected = expectation.expected?.value ?? expectation.text?.value ?? expectation.target?.text?.value ?? expectation.target?.accessibleName?.value ?? expectation.target?.testId;
  return expected === undefined ? `${expectation.kind} expectation` : `${expectation.kind}: ${String(expected).slice(0, 1_000)}`;
}

function safeUrl(value, secrets) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "unavailable";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const path = url.pathname.split("/").map((segment) => segment.includes("%") ? "[REDACTED]" : safePlainText(segment, secrets)).join("/");
    return path || "/";
  } catch {
    return "unavailable";
  }
}

function safeRunId(value) {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : "REPLACE_WITH_RUN_ID";
}

function fingerprintRoute(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "unavailable";
    const depth = url.pathname.split("/").filter(Boolean).length;
    return depth === 0 ? "/" : `/${Array(depth).fill(":segment").join("/")}`;
  } catch {
    return "unavailable";
  }
}

function publicationSource(input) {
  return {
    runId: input.evidenceBundle.runId,
    evidenceBundleId: input.evidenceBundle.bundleId,
    judgeResultId: input.judgeResult.resultId,
    failureDiagnosisId: input.diagnosis.diagnosisId,
    codeContextBundleId: input.codeContext.bundleId,
    ...(input.recommendation ? { repairRecommendationId: input.recommendation.recommendationId } : {}),
  };
}

function publicationSourceId(source) {
  return canonicalHash({ runId: source.runId, judgeResultId: source.judgeResultId, evidenceBundleId: source.evidenceBundleId });
}

function publicationResult({ repository, publication, action, target, occurrence, source, publicationFingerprint }) {
  return validateContract("GitHubPublicationResult", { schemaVersion: GITHUB_PUBLICATION_RESULT_VERSION, repository, publication, action, target: { publication: target.publication, number: target.number, url: target.url }, occurrence, source, publicationFingerprint });
}

function ambiguousPublicationResult({ repository, source, publicationFingerprint, matches }) {
  const targets = [...new Map(matches.map((match) => [match.number, match])).values()].map(({ publication, number, url }) => ({ publication, number, url }));
  if (targets.length < 2) throw new Error("GitHub publication search is inconsistent");
  return validateContract("GitHubPublicationResult", { schemaVersion: GITHUB_PUBLICATION_RESULT_VERSION, repository, publication: "UNRESOLVED", action: "AMBIGUOUS", matches: targets, source, publicationFingerprint });
}

function publicationMatches(value, repository, fingerprint, stateAuthenticationKey) {
  if (!Array.isArray(value) || value.length > MAX_PUBLICATION_MATCHES) throw new Error("GitHub publication search returned invalid data");
  return value.flatMap((match) => {
    const normalized = publicationMatch({ repository, publication: match?.publication, number: match?.number, url: match?.url, body: match?.body });
    if (!hasFingerprintMarker(normalized.body, fingerprint)) throw new Error("GitHub publication search returned an unbound match");
    try { parsePublicationState(normalized.body, repository, fingerprint, stateAuthenticationKey); } catch { return []; }
    return [normalized];
  });
}

function publicationTarget({ repository, publication, number, url }) {
  return publicationMatch({ repository, publication, number, url, body: "bounded" });
}

function publicationStateMarker({ repository, publicationFingerprint, occurrence, seenSourceIds, source, stateAuthenticationKey }) {
  const state = { schemaVersion: "qa-publication-state/0.2", keyId: PUBLICATION_KEY_ID, repository: repositorySlug(repository).toLowerCase(), publicationFingerprint, occurrence, seenSourceIds, initialSourceId: publicationSourceId(source) };
  const authentication = publicationAuthentication("state", state, stateAuthenticationKey);
  return `<!-- qa-publication-state: ${Buffer.from(JSON.stringify({ ...state, authentication })).toString("base64url")} -->`;
}

function parsePublicationState(body, repository, fingerprint, stateAuthenticationKey) {
  assertStateAuthenticationKey(stateAuthenticationKey);
  const matches = [...body.matchAll(/<!-- qa-publication-state: ([A-Za-z0-9_-]{1,8192}) -->/g)];
  if (matches.length !== 1) throw new Error("GitHub publication occurrence state is missing or ambiguous");
  let state;
  try {
    const bytes = Buffer.from(matches[0][1], "base64url");
    if (bytes.toString("base64url") !== matches[0][1]) throw new Error();
    state = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("GitHub publication occurrence state is invalid");
  }
  if (!state || Object.keys(state).sort().join(",") !== "authentication,initialSourceId,keyId,occurrence,publicationFingerprint,repository,schemaVersion,seenSourceIds" || state.schemaVersion !== "qa-publication-state/0.2" || state.keyId !== PUBLICATION_KEY_ID || state.repository !== repositorySlug(repository).toLowerCase() || state.publicationFingerprint !== fingerprint || !validOccurrence(state.occurrence) || !validSeenSourceIds(state.seenSourceIds) || state.seenSourceIds.length !== state.occurrence.count || state.initialSourceId !== state.seenSourceIds[0] || typeof state.authentication !== "string" || !/^hmac-sha256:[0-9a-f]{64}$/.test(state.authentication)) throw new Error("GitHub publication occurrence state is invalid");
  const { authentication, ...authenticated } = state;
  const actual = Buffer.from(authentication.slice("hmac-sha256:".length), "hex");
  const expected = publicationAuthenticationBytes("state", authenticated, stateAuthenticationKey);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("GitHub publication occurrence state authentication failed");
  return state;
}

function validOccurrence(value) {
  const first = typeof value?.firstSeen === "string" ? Date.parse(value.firstSeen) : Number.NaN;
  const last = typeof value?.lastSeen === "string" ? Date.parse(value.lastSeen) : Number.NaN;
  return value && Number.isSafeInteger(value.count) && value.count >= 1 && value.firstSeen.length <= 128 && value.lastSeen.length <= 128 && Number.isFinite(first) && Number.isFinite(last) && first <= last;
}

function validSeenSourceIds(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_SEEN_PUBLICATION_SOURCES && new Set(value).size === value.length && value.every((item) => /^sha256:[0-9a-f]{64}$/.test(item));
}

function assertStateAuthenticationKey(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 32) throw new Error("GitHub publication state authentication key is invalid");
}

function occurrenceTimestamp(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("GitHub publication occurrence timestamp is invalid");
  return new Date(timestamp).toISOString();
}

export function renderGitHubOccurrenceRecord({ repository, publicationFingerprint, source, occurredAt, stateAuthenticationKey, secrets = [] }) {
  assertStateAuthenticationKey(stateAuthenticationKey);
  if (!/^sha256:[0-9a-f]{64}$/.test(publicationFingerprint) || !source || [source.runId, source.judgeResultId, source.evidenceBundleId].some((value) => typeof value !== "string" || value.length === 0 || value.length > 512)) throw new Error("GitHub occurrence record input is invalid");
  const record = { schemaVersion: "qa-occurrence/0.1", keyId: PUBLICATION_KEY_ID, repository: repositorySlug(repository).toLowerCase(), publicationFingerprint, sourceId: publicationSourceId(source), occurredAt: occurrenceTimestamp(occurredAt) };
  const authentication = publicationAuthentication("occurrence", record, stateAuthenticationKey);
  return ["## QA occurrence", "", `- Run: ${code(source.runId, secrets)}`, `- Judge Result: ${code(source.judgeResultId, secrets)}`, `- Evidence Bundle: ${code(source.evidenceBundleId, secrets)}`, `- Seen: ${code(record.occurredAt, secrets)}`, "", `<!-- qa-occurrence: ${Buffer.from(JSON.stringify({ ...record, authentication })).toString("base64url")} -->`].join("\n");
}

function occurrenceRecords(value, repository, fingerprint, stateAuthenticationKey) {
  if (!Array.isArray(value) || value.length > 500) throw new Error("GitHub occurrence search returned invalid data");
  const records = value.flatMap((item) => {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || typeof item.body !== "string" || item.body.length > 8_192) return [];
    const match = /<!-- qa-occurrence: ([A-Za-z0-9_-]{1,8192}) -->/.exec(item.body);
    if (!match) return [];
    let record;
    try {
      const bytes = Buffer.from(match[1], "base64url");
      if (bytes.toString("base64url") !== match[1]) return [];
      record = JSON.parse(bytes.toString("utf8"));
    } catch { return []; }
    const occurredAt = typeof record?.occurredAt === "string" ? Date.parse(record.occurredAt) : Number.NaN;
    if (!record || Object.keys(record).sort().join(",") !== "authentication,keyId,occurredAt,publicationFingerprint,repository,schemaVersion,sourceId" || record.schemaVersion !== "qa-occurrence/0.1" || record.keyId !== PUBLICATION_KEY_ID || record.repository !== repositorySlug(repository).toLowerCase() || record.publicationFingerprint !== fingerprint || !/^sha256:[0-9a-f]{64}$/.test(record.sourceId) || !Number.isFinite(occurredAt) || new Date(occurredAt).toISOString() !== record.occurredAt || typeof record.authentication !== "string" || !/^hmac-sha256:[0-9a-f]{64}$/.test(record.authentication)) return [];
    const { authentication, ...authenticated } = record;
    const actual = Buffer.from(authentication.slice("hmac-sha256:".length), "hex");
    const expected = publicationAuthenticationBytes("occurrence", authenticated, stateAuthenticationKey);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return [];
    return [{ ...authenticated, commentId: item.id }];
  });
  return [...new Map(records.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.commentId - right.commentId).map((record) => [record.sourceId, record])).values()];
}

function occurrenceFromRecords(records) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("GitHub occurrence record is missing");
  const times = records.map((record) => Date.parse(record.occurredAt));
  return { count: records.length, firstSeen: new Date(Math.min(...times)).toISOString(), lastSeen: new Date(Math.max(...times)).toISOString() };
}

function publicationAuthentication(kind, value, key) {
  return `hmac-sha256:${publicationAuthenticationBytes(kind, value, key).toString("hex")}`;
}

function publicationAuthenticationBytes(kind, value, key) {
  return createHmac("sha256", key).update(`qa-native/github/${kind}/v1\0`).update(canonicalHash(value)).digest();
}

function labelSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 41) || "unknown";
}

function list(items, fallback) { return items.length > 0 ? items.map((item) => `- ${item}`) : [`- ${fallback}`]; }
function code(value, secrets) { return `\`${safePlainText(value, secrets).replaceAll("`", "'")}\``; }
function safePlainText(value, secrets) {
  const suppliedSecretsRemoved = redactSensitiveText(String(value), secrets);
  let redacted;
  try { redacted = JSON.parse(redactSensitiveText(JSON.stringify(suppliedSecretsRemoved))); } catch { redacted = "[REDACTED]"; }
  return redacted.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function safeText(value, secrets) { return safePlainText(value, secrets).replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1").replaceAll("@", "@\u200b"); }
function verifyStableId(prefix, idKey, value) { const { [idKey]: id, ...body } = value; const expected = `${prefix}-${canonicalHash(body).slice("sha256:".length, "sha256:".length + 16)}`; if (id !== expected) throw new Error(`${prefix} artifact identity is invalid`); }
function jsonSnapshot(value) { const serialized = JSON.stringify(value); if (serialized === undefined) throw new Error("GitHub publication input must be JSON-serializable"); return JSON.parse(serialized); }
// Input must be a Buffer: Node 24 rejects string input combined with encoding:"buffer"
// (ERR_UNKNOWN_ENCODING inside spawnSync).
function runGh(spawn, args, input) { const result = spawn("gh", args, { encoding: "buffer", maxBuffer: MAX_GITHUB_RESPONSE_BYTES, env: githubEnvironment(), ...(input === undefined ? {} : { input: Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8") }) }); if (!result || result.status !== 0 || !(result.stdout instanceof Uint8Array) || result.stdout.byteLength > MAX_GITHUB_RESPONSE_BYTES) throw new Error("GitHub CLI request failed"); return Buffer.from(result.stdout); }
function runGit(spawn, root, args) { const result = spawn("git", ["-C", root, ...args], { encoding: "buffer", maxBuffer: MAX_GITHUB_RESPONSE_BYTES, env: gitPublicationEnvironment() }); if (!result || result.status !== 0 || !(result.stdout instanceof Uint8Array) || result.stdout.byteLength > MAX_GITHUB_RESPONSE_BYTES) throw new Error("GitHub Draft PR git operation failed"); return Buffer.from(result.stdout); }
function assertDraftDiff(spawn, root, range, files, expectedHash) { const args = ["diff", "--no-ext-diff", "--no-renames", ...range, "--"]; const diff = runGit(spawn, root, args); const names = runGit(spawn, root, ["diff", "--name-only", "--no-renames", ...range, "--"]).toString("utf8").trim().split("\n").filter(Boolean).sort(); const expected = [...files].sort(); if (`sha256:${createHash("sha256").update(diff).digest("hex")}` !== expectedHash || names.length !== expected.length || names.some((path, index) => path !== expected[index])) throw new Error("GitHub Draft PR diff does not match the verified application"); }
function readDraftHead(spawn, repository, target) { if (!target || target.publication !== "DRAFT_PR" || !Number.isSafeInteger(target.number)) throw new Error("GitHub Draft PR target is invalid"); const branch = runGh(spawn, ["pr", "view", String(target.number), "--repo", repository, "--json", "headRefName", "--jq", ".headRefName"]).toString("utf8").trim(); if (!/^qa\/fix-[a-z0-9-]+$/.test(branch)) throw new Error("GitHub Draft PR head branch is not managed"); return branch; }
function runGhJson(spawn, args, input) { try { return JSON.parse(runGh(spawn, args, input).toString("utf8")); } catch { throw new Error("GitHub CLI returned invalid JSON"); } }
function githubEnvironment() { return Object.fromEntries([...GITHUB_ENV_KEYS.map((key) => [key, process.env[key]]).filter(([, value]) => typeof value === "string"), ["GH_PROMPT_DISABLED", "1"], ["GH_NO_UPDATE_NOTIFIER", "1"]]); }
function gitPublicationEnvironment() { return Object.fromEntries([... ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE"].map((key) => [key, process.env[key]]).filter(([, value]) => typeof value === "string"), ["GIT_TERMINAL_PROMPT", "0"], ["GIT_AUTHOR_NAME", "qa-native[bot]"], ["GIT_AUTHOR_EMAIL", "qa-native@users.noreply.github.com"], ["GIT_COMMITTER_NAME", "qa-native[bot]"], ["GIT_COMMITTER_EMAIL", "qa-native@users.noreply.github.com"]]); }
function hasFingerprintMarker(body, fingerprint) { return body.split("\n").some((line) => line.trim() === `<!-- qa-fingerprint: ${fingerprint} -->`); }
function publicationMatch({ repository, publication, number, url, body }) {
  if (!["ISSUE", "DRAFT_PR"].includes(publication) || !Number.isSafeInteger(number) || number < 1 || typeof url !== "string" || typeof body !== "string" || body.length === 0 || body.length > 65_536) throw new Error("GitHub publication data is invalid");
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("GitHub publication data is invalid"); }
  const segment = publication === "ISSUE" ? "issues" : "pull";
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.toLowerCase() !== `/${repository}/${segment}/${number}`.toLowerCase()) throw new Error("GitHub publication data is invalid");
  return Object.freeze({ publication, number, url, body });
}
function awaitGitHubPublication(spawn, repository, { publication, number, url }) {
  const target = publicationTarget({ repository, publication, number, url });
  const endpoint = publication === "ISSUE" ? `repos/${repository}/issues/${number}` : `repos/${repository}/pulls/${number}`;
  const value = runGhJson(spawn, ["api", "--method", "GET", endpoint]);
  if (!value || value.state !== "open" || (publication === "DRAFT_PR" && value.draft !== true)) throw new Error("GitHub publication is not open and managed");
  return publicationMatch({ repository, publication, number: value.number, url: value.html_url, body: value.body });
}
