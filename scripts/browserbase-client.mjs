import { EnvironmentError } from "./errors.mjs";

const API = "https://api.browserbase.com/v1";
const STATUSES = new Set(["PENDING", "RUNNING", "ERROR", "TIMED_OUT", "COMPLETED"]);
const invalid = () => new EnvironmentError("Browserbase returned an invalid response.");

function safeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new EnvironmentError("Browserbase requires a path-safe resource ID.");
  }
  return value;
}
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value;
}
function url(value, protocol) {
  if (typeof value !== "string" || /\s/.test(value)) throw invalid();
  let parsed;
  try { parsed = new URL(value); } catch { throw invalid(); }
  if (parsed.protocol !== protocol || !parsed.hostname || parsed.username || parsed.password) throw invalid();
  return value;
}
function resource(value, expectedId) {
  object(value);
  const result = { id: safeId(value.id) };
  if (expectedId !== undefined && result.id !== expectedId) throw invalid();
  for (const key of ["projectId", "contextId"]) {
    if (value[key] !== undefined) result[key] = safeId(value[key]);
  }
  for (const key of ["createdAt", "updatedAt", "startedAt", "expiresAt", "endedAt"]) {
    if (value[key] === undefined) continue;
    if (key === "endedAt" && value[key] === null) { result[key] = null; continue; }
    if (typeof value[key] !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value[key]) || !Number.isFinite(Date.parse(value[key]))) throw invalid();
    result[key] = value[key];
  }
  return result;
}
function session(value, expectedId, requireConnect = false) {
  const result = resource(value, expectedId);
  if (!STATUSES.has(value.status)) throw invalid();
  result.status = value.status;
  if (requireConnect || value.connectUrl !== undefined) result.connectUrl = url(value.connectUrl, "wss:");
  return result;
}
function debuggerUrls(value) {
  object(value);
  return {
    debuggerUrl: url(value.debuggerUrl, "https:"),
    debuggerFullscreenUrl: url(value.debuggerFullscreenUrl, "https:"),
  };
}
function debug(value) {
  const result = debuggerUrls(value);
  result.wsUrl = url(value.wsUrl, "wss:");
  if (!Array.isArray(value.pages)) throw invalid();
  result.pages = value.pages.map((page) => ({ id: safeId(object(page).id), ...debuggerUrls(page) }));
  return result;
}

/**
 * Dependency-free Browserbase REST boundary, separate from the AI adapter.
 * Official references checked 2026-09-08 (https://docs.browserbase.com/reference/api/):
 * create-a-context, get-a-context, delete-a-context, create-a-session,
 * get-a-session, session-live-urls, update-a-session.
 *
 * Assumptions: callers need IDs/status/timestamps and connection/debug URLs, not
 * encryption material, signing keys, arbitrary metadata, page titles or page URLs.
 * Responses are projected to that allowlist, validating every returned field.
 * Unused REST fields are not required, allowing additive provider schema changes.
 * Returned connection/debug URLs are sensitive capabilities. Never log/persist them.
 * Project is required locally even though the API can infer it from the key.
 * keepAlive is deliberately omitted: it requires Hobby+ and is not needed for a
 * connected browser. Callers explicitly release sessions when work completes.
 * Release uses the current documented status-only body, not legacy projectId.
 * Context persistence finishes asynchronously after release. Polling belongs to
 * the caller. No retries: retrying create could allocate another paid resource.
 */
export function createBrowserbaseClient({
  apiKey = process.env.BROWSERBASE_API_KEY,
  projectId = process.env.BROWSERBASE_PROJECT_ID,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new EnvironmentError("BROWSERBASE_API_KEY is required.");
  if (typeof projectId !== "string" || !projectId.trim()) throw new EnvironmentError("BROWSERBASE_PROJECT_ID is required.");
  safeId(projectId);
  if (typeof fetchImpl !== "function") throw new EnvironmentError("Browserbase requires fetch support.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new EnvironmentError("Browserbase request timeout must be a positive bounded integer.");

  async function request(path, method, body, validate, noContent = false) {
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("timeout"));
        }, timeoutMs);
      });
      const perform = async () => {
        const response = await fetchImpl(`${API}${path}`, {
          method,
          headers: { "X-BB-API-Key": apiKey, "Content-Type": "application/json" },
          redirect: "error", // Never forward the API key to a redirect destination.
          signal: controller.signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response || response.ok !== true) throw new Error("HTTP failure");
        if (noContent) {
          if (response.status !== 204) throw invalid();
          return undefined;
        }
        return validate(await response.json());
      };
      return await Promise.race([perform(), deadline]);
    } catch {
      // Do not retain raw errors as cause, even if already an EnvironmentError.
      // HTTP bodies/statusText, IDs and URLs may contain credentials or user data.
      throw new EnvironmentError(timedOut ? "Browserbase request timed out." : "Browserbase request failed or returned an invalid response.");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async createContext() {
      return request("/contexts", "POST", { projectId }, (value) => resource(value));
    },
    async getContext(id) {
      safeId(id);
      return request(`/contexts/${id}`, "GET", undefined, (value) => resource(value, id));
    },
    async deleteContext(id) {
      safeId(id);
      return request(`/contexts/${id}`, "DELETE", undefined, undefined, true);
    },
    async createSession({ contextId, persist = false, timeout = 600 } = {}) {
      if (contextId !== undefined) safeId(contextId);
      if (typeof persist !== "boolean" || !Number.isInteger(timeout) || timeout < 60 || timeout > 21600) {
        throw new EnvironmentError("Browserbase requires boolean persist and a session timeout of 60 to 21600 seconds.");
      }
      const body = { projectId, timeout };
      if (contextId !== undefined) body.browserSettings = { context: { id: contextId, persist } };
      return request("/sessions", "POST", body, (value) => session(value, undefined, true));
    },
    async getSession(id) {
      safeId(id);
      return request(`/sessions/${id}`, "GET", undefined, (value) => session(value, id));
    },
    async getDebug(id) {
      safeId(id);
      return request(`/sessions/${id}/debug`, "GET", undefined, debug);
    },
    async releaseSession(id) {
      safeId(id);
      return request(`/sessions/${id}`, "POST", { status: "REQUEST_RELEASE" }, (value) => session(value, id));
    },
  };
}
