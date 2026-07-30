// The Hermes CLI transport now lives in the shared, self-contained @persona-runtime/hermes-transport
// package so personaut and qa-native share one implementation instead of personaut deep-importing this
// file. qa-native ships raw .mjs, so `prepack` inlines the package back into this path for publish; in
// the monorepo this re-export resolves through the workspace.
export * from "@persona-runtime/hermes-transport";
