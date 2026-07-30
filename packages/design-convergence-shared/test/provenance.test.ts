import { describe, expect, it } from "vitest";
import {
  buildProvenance,
  provenanceSchema,
  type Provenance,
} from "../src/index.js";

const base: Provenance = {
  createdAt: "2026-07-30T00:00:00.000Z",
  toolVersion: "0.1.0",
  configHash: "sha256:abc",
  git: { available: true, commit: "abcdef1" },
  sourceKind: "fixture",
};

describe("provenance", () => {
  it("accepts a complete provenance with an available git commit", () => {
    expect(() => buildProvenance(base)).not.toThrow();
  });

  it("accepts an unavailable git ref carrying a reason", () => {
    const p = {
      ...base,
      git: { available: false, reason: "not a git checkout" },
    };
    expect(provenanceSchema.safeParse(p).success).toBe(true);
  });

  it("rejects a git ref that mixes available:true with a reason", () => {
    const p = { ...base, git: { available: true, reason: "x" } };
    expect(provenanceSchema.safeParse(p).success).toBe(false);
  });

  it("rejects a non-hex commit", () => {
    const p = { ...base, git: { available: true, commit: "zzz" } };
    expect(provenanceSchema.safeParse(p).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(provenanceSchema.safeParse({ ...base, extra: 1 }).success).toBe(
      false,
    );
  });

  it("rejects a missing toolVersion", () => {
    const { toolVersion, ...rest } = base;
    expect(provenanceSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an unknown source kind", () => {
    const p = { ...base, sourceKind: "screenshot" };
    expect(provenanceSchema.safeParse(p).success).toBe(false);
  });
});
