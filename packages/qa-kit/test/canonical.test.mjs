import assert from "node:assert/strict";
import test from "node:test";
import { canonicalHash } from "../canonical.mjs";

test("canonicalHash preserves the shared regression value", () => {
  assert.equal(canonicalHash({ b: 1, a: [2, { d: 3, c: 4 }], s: "문자열" }), "sha256:28df1e02d8c8710df82712dbf77dc9caeb69036d53c0a6aebde64e7966d25508");
});
