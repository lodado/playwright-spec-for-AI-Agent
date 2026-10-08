// Type Contract witnesses (card section "Type Contract", P11 / O16): the real injection boundary of the
// refactored core modules, compiled with TypeScript against the JSDoc of the actual .mjs files and
// judged with type-fest. Each relation has a positive witness and a negative one: one misuse on the
// line after `@ts-expect-error`. A removed or unused directive is itself a compiler error (TS2578),
// so a relation that stops holding fails the compile either way.
//
// Positions assumed from the card's signatures: hashFile(path, { readFile }), the ledger functions take
// the injected `io` inside their options object ({ io }), parseSpecFile(fileName, source, { livePolicyOverrides }),
// executeWithRetries(attempt, { onRetry }).
import type { IsEqual, JsonValue, ReadonlyDeep, RequiredKeysOf } from "type-fest";
import { decideAuthMode } from "../../judge-plan.mjs";
import { normalizeBrowseDecision } from "../../judge-verdict.mjs";
import { executeWithRetries } from "../../judgment.mjs";
import * as nodeIo from "../../node-io.mjs";
import { readLedger, verifyLedger } from "../../qa-run-ledger.mjs";
import { parseSpecDirectory, parseSpecFile } from "../../spec-annotation-reader.mjs";
import { hashFile } from "../../spec-hash.mjs";

type Assert<T extends true> = T;

// ── Relation 1: the normalizer takes untrusted JSON and returns a closed status union ─────────────────
type NormalizeResult = ReturnType<typeof normalizeBrowseDecision>;
type NormalizeOptions = NonNullable<Parameters<typeof normalizeBrowseDecision>[1]>;
declare const agentJson: JsonValue;
declare const evidenceIo: { fileExists: (path: string) => boolean; readText: (path: string) => string };

// positive: JSON in, status exactly the three-way union out, file access required in options
normalizeBrowseDecision(agentJson, evidenceIo);
export type StatusIsClosed = Assert<IsEqual<NormalizeResult["status"], "pass" | "manual_review" | "fail">>;
export type FileAccessIsRequired = Assert<IsEqual<RequiredKeysOf<NormalizeOptions>, "fileExists" | "readText">>;

// negative: a non-JSON value is refused at the trust boundary
// @ts-expect-error a function is not a JsonValue
normalizeBrowseDecision(() => 1, evidenceIo);
// negative: the status is not an open string
// @ts-expect-error the status is a literal union, not string
export type StatusIsOpen = Assert<IsEqual<NormalizeResult["status"], string>>;
// negative: fs access is injected, never defaulted
// @ts-expect-error fileExists and readText are required
normalizeBrowseDecision(agentJson, {});

// ── Relation 2: the ledger core hands entries out read-only, and file access is injected (S8) ─────────
declare const ledgerIo: {
  readFile: (path: string) => string;
  appendFile: (path: string, data: string) => void;
  exists: (path: string) => boolean;
};
const entries = readLedger("runs.jsonl", { io: ledgerIo });
type LedgerEntry = (typeof entries)[number];
declare const entry: LedgerEntry;

// positive: entries read as ReadonlyDeep records carrying the chain hash, and verify reports a boolean
export const chainHash: string = entry.hash;
export type EntriesAreReadonlyDeep = Assert<IsEqual<LedgerEntry, ReadonlyDeep<LedgerEntry>>>;
export const chainIntact: boolean = verifyLedger("runs.jsonl", { io: ledgerIo }).ok;

// negative: a caller cannot rewrite an entry it read
// @ts-expect-error entries are readonly
entry.hash = "sha256:forged";
// negative: the ledger has no fs default, so io cannot be left out
// @ts-expect-error io is required
verifyLedger("runs.jsonl");

// ── Relation 3: decideAuthMode accepts only the three auth literals ───────────────────────────────────
type AuthInput = Parameters<typeof decideAuthMode>[0];

// positive
export const cdpAuth: Pick<AuthInput, "auth"> = { auth: "cdp-attach" };
export type AuthIsClosed = Assert<IsEqual<AuthInput["auth"], "cdp-attach" | "self-prelogin" | "credentials-in-prompt">>;
// negative
// @ts-expect-error not a declared auth capability
export const otherAuth: Pick<AuthInput, "auth"> = { auth: "headless" };

// ── Injection boundary: spec-hash, spec-annotation-reader, judgment, node-io ──────────────────────────
type HashFileOptions = NonNullable<Parameters<typeof hashFile>[1]>;

// positive: readFile is the only port hashFile takes, and it is required
hashFile("spec.json", { readFile: (path: string) => path });
export type HashFileTakesOnlyReadFile = Assert<IsEqual<RequiredKeysOf<HashFileOptions>, "readFile">>;
// negative
// @ts-expect-error readFile is required, node:fs is not imported as a default
hashFile("spec.json");

// positive: the live-policy overrides arrive as an argument
parseSpecFile("a.spec.ts", "", { livePolicyOverrides: { "deep-link": "readonly" } });
declare const directoryOptions: NonNullable<Parameters<typeof parseSpecDirectory>[1]>;
parseSpecDirectory("specs", directoryOptions);
// negative: overrides are a record, not a string
// @ts-expect-error livePolicyOverrides must be a record of policy names
parseSpecFile("a.spec.ts", "", { livePolicyOverrides: "readonly" });
// negative: the directory reader's io is injected
// @ts-expect-error io is required
parseSpecDirectory("specs", {});

// positive: the retry loop takes the attempt and the ledger append as arguments
executeWithRetries(async () => ({ status: "pass" }), { onRetry: () => undefined });
// negative: the attempt is a function, injected
// @ts-expect-error not a function
executeWithRetries("attempt", { onRetry: () => undefined });

// positive: node-io.mjs exports the port the shells pass to the core
export type NodeIoHasExports = Assert<IsEqual<keyof typeof nodeIo extends never ? true : false, false>>;
