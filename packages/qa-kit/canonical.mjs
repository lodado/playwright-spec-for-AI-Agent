import { createHash } from "node:crypto";

export function canonicalJson(value, { omitKeys = new Set() } = {}) {
  return JSON.stringify(canonicalize(value, omitKeys));
}

export function canonicalHash(value, options) {
  return `sha256:${createHash("sha256").update(canonicalJson(value, options)).digest("hex")}`;
}

function canonicalize(value, omitKeys) {
  if (Array.isArray(value)) return value.map(item => canonicalize(item, omitKeys));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).filter(key => !omitKeys.has(key)).sort().map(key => [key, canonicalize(value[key], omitKeys)]));
}
