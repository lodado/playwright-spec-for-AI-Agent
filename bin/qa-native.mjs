#!/usr/bin/env node
import { executeQaNative } from "../packages/cli/qa-native-execute.mjs";
import { runQaNative } from "../packages/cli/qa-native.mjs";

process.exitCode = await runQaNative(process.argv.slice(2), { handlers: { execute: executeQaNative } });
