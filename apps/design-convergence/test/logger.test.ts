import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: (l: string) => out.push(l),
    writeErr: (l: string) => err.push(l),
  };
}

describe("createLogger", () => {
  it("renders human text by default with just the message", () => {
    const c = capture();
    createLogger({ write: c.write, writeErr: c.writeErr }).info({
      message: "selected case pricing-desktop",
      caseId: "pricing-desktop",
    });
    expect(c.out).toEqual(["selected case pricing-desktop"]);
  });

  it("appends structured fields only in verbose mode", () => {
    const c = capture();
    createLogger({ verbose: true, write: c.write, writeErr: c.writeErr }).info({
      message: "selected",
      caseId: "pricing-desktop",
    });
    expect(c.out[0]).toContain("caseId=pricing-desktop");
  });

  it("emits JSON when json is set", () => {
    const c = capture();
    createLogger({ json: true, write: c.write, writeErr: c.writeErr }).info({
      message: "hi",
      caseId: "x",
    });
    expect(JSON.parse(c.out[0]!)).toEqual({
      level: "info",
      message: "hi",
      caseId: "x",
    });
  });

  it("suppresses info under --quiet but never errors", () => {
    const c = capture();
    const logger = createLogger({
      quiet: true,
      write: c.write,
      writeErr: c.writeErr,
    });
    logger.info({ message: "hidden" });
    logger.error({ kind: "configuration", message: "shown" });
    expect(c.out).toEqual([]);
    expect(c.err).toEqual(["error: shown"]);
  });

  it("redacts secret-named keys in every mode", () => {
    const c = capture();
    createLogger({ json: true, write: c.write, writeErr: c.writeErr }).info({
      message: "auth",
      authorization: "Bearer supersecret",
    });
    const parsed = JSON.parse(c.out[0]!) as { authorization: string };
    expect(parsed.authorization).not.toContain("supersecret");
  });

  it("scrubs known secret values that leak into the message", () => {
    const c = capture();
    createLogger({
      secretValues: ["figd_leaked"],
      write: c.write,
      writeErr: c.writeErr,
    }).error({
      kind: "figma-auth",
      message: "fetch failed for token figd_leaked",
    });
    expect(c.err[0]).not.toContain("figd_leaked");
  });
});
