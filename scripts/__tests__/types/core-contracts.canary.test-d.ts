// Checker canary for core-contracts.test-d.ts. Each pair below mirrors a witness without the property it
// relies on, so the compiler must reject the pair: an unused `@ts-expect-error` (TS2578) when the
// protection is gone, an unsatisfied Assert (TS2344) when the type is open. If this file ever compiles
// clean, the witnesses cannot be trusted.
import type { IsEqual, ReadonlyDeep } from "type-fest";

type Assert<T extends true> = T;
type LedgerEntry = { hash: string; prevHash: string };

// With ReadonlyDeep the assignment is an error (the witness); without the wrapper it is not (this canary).
declare const guarded: ReadonlyDeep<LedgerEntry>;
declare const unwrapped: LedgerEntry;
// @ts-expect-error guarded is readonly
guarded.hash = "sha256:forged";
// CANARY-UNWRAPPED
// @ts-expect-error unwrapped is NOT readonly, so this directive is unused
unwrapped.hash = "sha256:forged";

// CANARY-OPEN-UNION
export type OpenStatusIsClosed = Assert<IsEqual<string, "pass" | "manual_review" | "fail">>;
