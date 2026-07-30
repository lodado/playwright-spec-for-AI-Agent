import { describe, expect, it } from "vitest";
import { z } from "zod";
import { envelope, type Provenance } from "../src/index.js";

const provenance: Provenance = {
  createdAt: "2026-07-30T00:00:00.000Z",
  toolVersion: "0.1.0",
  configHash: "sha256:abc",
  git: { available: true, commit: "abcdef1" },
  sourceKind: "generated",
};

const schema = envelope(z.object({ value: z.number() }).strict());

describe("envelope", () => {
  it("accepts a well-formed envelope", () => {
    const r = schema.safeParse({
      schemaVersion: 1,
      provenance,
      payload: { value: 3 },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a wrong schemaVersion", () => {
    const r = schema.safeParse({
      schemaVersion: 2,
      provenance,
      payload: { value: 3 },
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown top-level keys (tamper/stale guard)", () => {
    const r = schema.safeParse({
      schemaVersion: 1,
      provenance,
      payload: { value: 3 },
      extra: true,
    });
    expect(r.success).toBe(false);
  });

  it("requires provenance", () => {
    const r = schema.safeParse({ schemaVersion: 1, payload: { value: 3 } });
    expect(r.success).toBe(false);
  });

  it("validates the payload against the provided schema", () => {
    const r = schema.safeParse({
      schemaVersion: 1,
      provenance,
      payload: { value: "x" },
    });
    expect(r.success).toBe(false);
  });
});
