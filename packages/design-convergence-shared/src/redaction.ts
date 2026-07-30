/**
 * Names whose values must never be logged, hashed, or sent to an AI provider:
 * Figma token, cookies, authorization headers, passwords, and token/key/secret
 * shaped environment variables. Bare "auth" is intentionally excluded so a
 * field like "author" is not mistaken for a secret.
 */
const SECRET_NAME_PATTERN =
  /(token|secret|password|passwd|passphrase|cookie|authorization|api[_-]?key|access[_-]?key|private[_-]?key|credential)/i;

export const REDACTED = "«redacted»";

export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/**
 * Redact a plain env-like map: any key that looks like a secret has its value
 * replaced. Names are kept (useful for debugging), values never are.
 */
export function redactEnvMap(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    out[key] = isSecretName(key) ? REDACTED : value;
  }
  return out;
}

/**
 * Central redactor. Returns a deep copy where (1) any object key that looks like
 * a secret has its value replaced wholesale, and (2) any string containing a
 * known secret value is scrubbed. Every log line, artifact hash input, and AI
 * prompt passes through this so a leaked value fails closed.
 */
export function redact(
  value: unknown,
  secretValues: Iterable<string> = [],
): unknown {
  const secrets = [...secretValues].filter((s) => s.length > 0);

  const scrub = (s: string): string => {
    let out = s;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  };

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
        out[key] = isSecretName(key) ? REDACTED : walk(val);
      }
      return out;
    }
    return v;
  };

  return walk(value);
}
