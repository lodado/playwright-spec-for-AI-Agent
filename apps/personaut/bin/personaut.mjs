#!/usr/bin/env node
import { runCli } from "../dist/index.mjs";

runCli(process.argv.slice(2)).catch(error => {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
});
