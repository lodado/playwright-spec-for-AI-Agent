import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const SRC = new URL("../src/", import.meta.url);

async function srcFiles() {
  return (await readdir(SRC)).filter(file => file.endsWith(".mjs"));
}

test("contracts.mjs is a leaf", async () => {
  const source = await readFile(new URL("contracts.mjs", SRC), "utf8");
  assert.doesNotMatch(source, /from "\.\//, "contracts must not import siblings");
});

test("only driver.mjs imports Playwright", async () => {
  for (const file of await srcFiles()) {
    const source = await readFile(new URL(file, SRC), "utf8");
    const importsPlaywright = /from "(?:@playwright\/test|playwright)"/.test(source);
    if (file !== "driver.mjs") assert.equal(importsPlaywright, false, `${file} must not import Playwright`);
  }
});

test("only hermes-action-policy.mjs imports hermes transport", async () => {
  for (const file of await srcFiles()) {
    const source = await readFile(new URL(file, SRC), "utf8");
    const importsHermes = /@persona-runtime\/hermes-transport/.test(source);
    if (file !== "hermes-action-policy.mjs") assert.equal(importsHermes, false, `${file} must not import hermes transport`);
  }
});
