import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// O15 / O16: the real import graph of bin/ and scripts/ against the compiled Bend `Trust.allowed`
// (MODEL.bend, locked) and the layer map of P10 / T14: Cli > Pipeline > Infra > Config > Core > NodeIo.
// A process.env read counts as an edge to NodeIo. Nothing here restates the layering rule: the
// compiled model decides every edge.

type Layer = "LayerCli" | "LayerPipeline" | "LayerInfra" | "LayerConfig" | "LayerCore" | "LayerNodeIo";
type Edge = { from: string; to: string; kind: "static" | "dynamic" | "env"; layer: Layer | null };
type Allowed = (from: { $: Layer }, to: { $: Layer }) => boolean;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const compiledModelPath = join(repoRoot, "scripts/__tests__/formal/refactor/trust.model.mjs");
const binFile = "bin/playwright-spec-for-ai-agent.mjs";

// P10 layer map, verbatim.
const CORE_FILES = [
  "errors.mjs",
  "spec-hash.mjs",
  "judge-verdict.mjs",
  "qa-run-ledger.mjs",
  "spec-annotation-reader.mjs",
  "judge-plan.mjs",
  "judgment.mjs",
].map((name) => `scripts/${name}`);
const CONFIG_FILES = ["hermes-qa-project-config.mjs", "staging-qa-config.mjs"].map((name) => `scripts/${name}`);
const NODE_IO_BUILTINS = new Set(["fs", "child_process", "net", "http", "https", "os"]);
const CORE_BUILTINS = new Set(["crypto", "path", "url"]);
// Builtins P10 assigns to no layer. Listed so a new one is a visible decision, not a silent skip.
const KNOWN_UNCLASSIFIED_BUILTINS = ["module", "process", "readline", "timers", "util"];

function sourceFiles(): string[] {
  return [
    binFile,
    ...readdirSync(join(repoRoot, "scripts"))
      .filter((name) => name.endsWith(".mjs"))
      .sort()
      .map((name) => `scripts/${name}`),
  ];
}

function pipelineFiles(): string[] {
  const source = readFileSync(join(repoRoot, binFile), "utf8");
  return [...source.matchAll(/^\s+script:\s*"([^"]+\.mjs)"/gm)].map((match) => `scripts/${match[1]}`);
}

function layerOfFile(file: string, pipeline: ReadonlySet<string>): Layer {
  if (file.startsWith("bin/")) return "LayerCli";
  if (pipeline.has(file)) return "LayerPipeline";
  if (CORE_FILES.includes(file)) return "LayerCore";
  if (CONFIG_FILES.includes(file)) return "LayerConfig";
  return "LayerInfra";
}

function builtinName(specifier: string): string | null {
  const bare = specifier.replace(/^node:/, "");
  return bare === specifier && !/^(fs|child_process|net|http|https|os|crypto|path|url|util|module|process|readline|timers)(\/|$)/.test(bare)
    ? null
    : bare.split("/")[0];
}

function layerOfBuiltin(name: string): Layer | null {
  if (NODE_IO_BUILTINS.has(name)) return "LayerNodeIo";
  if (CORE_BUILTINS.has(name)) return "LayerCore";
  return null;
}

/**
 * Blank comments and string contents so import and env patterns match code only. Each string
 * literal becomes "§n§" with its raw text kept in `strings`; template text is dropped and `${}`
 * expressions stay code.
 */
function scan(source: string): { code: string; strings: string[] } {
  const strings: string[] = [];
  let code = "";
  const stack: Array<{ kind: "template" } | { kind: "expr"; depth: number }> = [];
  const lastSignificant = () => code.trimEnd().slice(-1);
  const regexAllowed = () => {
    const last = lastSignificant();
    return last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last) || /\b(?:return|typeof|case|in|of)$/.test(code.trimEnd());
  };
  let i = 0;
  while (i < source.length) {
    const top = stack.at(-1);
    const ch = source[i];
    if (top?.kind === "template") {
      if (ch === "\\") i += 2;
      else if (ch === "`") {
        stack.pop();
        code += "`";
        i += 1;
      } else if (ch === "$" && source[i + 1] === "{") {
        stack.push({ kind: "expr", depth: 0 });
        code += "${";
        i += 2;
      } else i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      code += " ";
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      strings.push(source.slice(i + 1, j));
      code += `"§${strings.length - 1}§"`;
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      stack.push({ kind: "template" });
      code += "`";
      i += 1;
      continue;
    }
    if (ch === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && (inClass || source[j] !== "/")) {
        if (source[j] === "\\") j += 1;
        else if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j += 1;
      }
      code += "/r/";
      i = j + 1;
      while (/[a-z]/.test(source[i] ?? "")) i += 1;
      continue;
    }
    if (top?.kind === "expr") {
      if (ch === "{") top.depth += 1;
      if (ch === "}") {
        if (top.depth === 0) {
          stack.pop();
          code += "}";
          i += 1;
          continue;
        }
        top.depth -= 1;
      }
    }
    code += ch;
    i += 1;
  }
  return { code, strings };
}

type RawEdges = { specifiers: Array<{ specifier: string; kind: "static" | "dynamic" }>; env: boolean; opaqueDynamic: number };

function extractEdges(source: string): RawEdges {
  const { code, strings } = scan(source);
  const specifiers: RawEdges["specifiers"] = [];
  const lookup = (index: string) => strings[Number(index)];
  for (const match of code.matchAll(/\bfrom\s*"§(\d+)§"/g)) specifiers.push({ specifier: lookup(match[1]), kind: "static" });
  for (const match of code.matchAll(/\bimport\s*"§(\d+)§"/g)) specifiers.push({ specifier: lookup(match[1]), kind: "static" });
  for (const match of code.matchAll(/\bimport\s*\(\s*"§(\d+)§"\s*\)/g)) specifiers.push({ specifier: lookup(match[1]), kind: "dynamic" });
  const opaqueDynamic = [...code.matchAll(/\bimport\s*\(\s*(?!"§)/g)].length;
  const envFromProcessModule = [...code.matchAll(/\{[^}]*\benv\b[^}]*\}\s*from\s*"§(\d+)§"/g)].some((match) =>
    /^(node:)?process$/.test(lookup(match[1])),
  );
  const env = /\bprocess\s*\.\s*env\b/.test(code) || /\bprocess\s*\[\s*"§\d+§"\s*\]/.test(code) || envFromProcessModule;
  return { specifiers, env, opaqueDynamic };
}

function buildGraph(read: (file: string) => string, files: readonly string[], pipeline: ReadonlySet<string>) {
  const edges: Edge[] = [];
  const unresolved: string[] = [];
  const unclassifiedBuiltins = new Set<string>();
  const opaqueDynamic: string[] = [];
  const moduleGraph = new Map<string, string[]>();
  for (const file of files) {
    const raw = extractEdges(read(file));
    if (raw.opaqueDynamic > 0) opaqueDynamic.push(`${file} x${raw.opaqueDynamic}`);
    const targets: string[] = [];
    for (const { specifier, kind } of raw.specifiers) {
      if (specifier.startsWith(".")) {
        const target = relative(repoRoot, resolve(repoRoot, dirname(file), specifier)).split("\\").join("/");
        if (!files.includes(target)) {
          unresolved.push(`${file} -> ${specifier}`);
          continue;
        }
        targets.push(target);
        edges.push({ from: file, to: target, kind, layer: layerOfFile(target, pipeline) });
        continue;
      }
      const builtin = builtinName(specifier);
      if (builtin === null) continue; // a third-party package: P10 gives it no layer
      const layer = layerOfBuiltin(builtin);
      if (layer === null) unclassifiedBuiltins.add(builtin);
      else edges.push({ from: file, to: `node:${builtin}`, kind, layer });
    }
    if (raw.env) edges.push({ from: file, to: "process.env", kind: "env", layer: "LayerNodeIo" });
    moduleGraph.set(file, targets);
  }
  return { edges, unresolved, unclassifiedBuiltins: [...unclassifiedBuiltins].sort(), opaqueDynamic, moduleGraph };
}

/** Strongly connected components with more than one module, plus self-imports (Tarjan). */
function cyclicComponents(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  const visit = (node: string) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!));
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1 || (graph.get(node) ?? []).includes(node)) found.push(component.sort());
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return found;
}

function forbiddenEdges(edges: readonly Edge[], layerOf: (file: string) => Layer, allowed: Allowed): string[] {
  return edges
    .filter((edge) => !allowed({ $: layerOf(edge.from) }, { $: edge.layer! }))
    .map((edge) => `${edge.from} (${layerOf(edge.from)}) -> ${edge.to} (${edge.layer}) [${edge.kind}]`);
}

describe("import graph as bin and scripts judged by the compiled Trust.allowed", () => {
  const files = sourceFiles();
  const pipeline = new Set(pipelineFiles());
  const layerOf = (file: string) => layerOfFile(file, pipeline);
  const read = (file: string) => readFileSync(join(repoRoot, file), "utf8");
  const graph = buildGraph(read, files, pipeline);
  let allowed: Allowed;

  // trust.model.mjs is MODEL.bend compiled by `oracle-projection.mjs emit-trace`; its generated suite
  // pins both files by SHA-256, so this needs no Bend toolchain in CI.
  beforeAll(async () => {
    const compiled = (await import(pathToFileURL(compiledModelPath).href)) as { default: Record<string, unknown> };
    allowed = compiled.default["Trust.allowed"] as Allowed;
  });

  it("to be the layer map seeing the bin COMMANDS table as Pipeline and every relative import resolving to a module", () => {
    expect(pipeline.size).toBe(15);
    expect([...pipeline].filter((file) => !existsSync(join(repoRoot, file)))).toStrictEqual([]);
    expect(graph.unresolved).toStrictEqual([]);
  });

  it("to be the builtins outside P10's layer map exactly the known five, with no opaque dynamic import in a Core module", () => {
    expect(graph.unclassifiedBuiltins).toStrictEqual(KNOWN_UNCLASSIFIED_BUILTINS);
    const opaqueInCore = graph.opaqueDynamic.filter((entry) => CORE_FILES.includes(entry.split(" ")[0]));
    expect(opaqueInCore).toStrictEqual([]);
  });

  it("to be zero violating edges [O15]", () => {
    expect(forbiddenEdges(graph.edges, layerOf, allowed)).toStrictEqual([]);
  });

  it("to be zero strongly connected components of more than one module [O15]", () => {
    expect(cyclicComponents(graph.moduleGraph)).toStrictEqual([]);
  });
});

describe("core modules as the T1, T2 and T4 decision functions after the refactor", () => {
  const files = sourceFiles();
  const pipeline = new Set(pipelineFiles());
  const read = (file: string) => readFileSync(join(repoRoot, file), "utf8");
  const graph = buildGraph(read, files, pipeline);
  const coreEdges = graph.edges.filter((edge) => CORE_FILES.includes(edge.from));
  const importsOf = (match: (edge: Edge) => boolean) =>
    coreEdges.filter(match).map((edge) => `${edge.from} -> ${edge.to} [${edge.kind}]`);

  it("to be judge-plan.mjs and judgment.mjs present as Core and node-io.mjs present as Infra [O16]", () => {
    const missing = ["scripts/judge-plan.mjs", "scripts/judgment.mjs", "scripts/node-io.mjs"].filter(
      (file) => !existsSync(join(repoRoot, file)),
    );
    expect(missing).toStrictEqual([]);
    expect(CORE_FILES).toContain("scripts/judge-plan.mjs");
    expect(CORE_FILES).toContain("scripts/judgment.mjs");
    expect(pipeline.has("scripts/node-io.mjs")).toBe(false);
  });

  it("to be zero node:fs imports in a core module [O16 fs]", () => {
    expect(importsOf((edge) => edge.to === "node:fs")).toStrictEqual([]);
  });

  it("to be zero process.env reads in a core module [O16 env]", () => {
    expect(importsOf((edge) => edge.kind === "env")).toStrictEqual([]);
  });

  it("to be zero node:child_process imports in a core module [O16 spawn]", () => {
    expect(importsOf((edge) => edge.to === "node:child_process")).toStrictEqual([]);
  });

  it("to be zero config module imports in a core module [O16 config]", () => {
    expect(importsOf((edge) => CONFIG_FILES.includes(edge.to))).toStrictEqual([]);
  });
});

describe("architecture checker as a canary over synthetic sources", () => {
  const pipeline = new Set<string>();
  const synthetic: Record<string, string> = {
    "scripts/spec-hash.mjs": 'import { readFileSync } from "node:fs";\nexport const x = 1;',
    "scripts/judge-verdict.mjs": 'const t = process.env.QA_X;\nexport const y = import("./node-io.mjs");',
    "scripts/node-io.mjs": '// import "node:fs" in a comment\nconst msg = "process.env in a string";\nexport const z = `${1}`;',
    "scripts/qa-run-ledger.mjs": 'import { createHash } from "node:crypto";\nexport * from "./spec-hash.mjs";',
  };
  const files = Object.keys(synthetic);
  const graph = buildGraph((file) => synthetic[file], files, pipeline);

  it("to be every import form, process.env read and ignored comment or string seen as expected", () => {
    const summary = graph.edges.map((edge) => `${edge.from} -> ${edge.to} [${edge.kind}]`).sort();
    expect(summary).toStrictEqual([
      "scripts/judge-verdict.mjs -> process.env [env]",
      "scripts/judge-verdict.mjs -> scripts/node-io.mjs [dynamic]",
      "scripts/qa-run-ledger.mjs -> node:crypto [static]",
      "scripts/qa-run-ledger.mjs -> scripts/spec-hash.mjs [static]",
      "scripts/spec-hash.mjs -> node:fs [static]",
    ]);
  });

  it("to be Core edges to NodeIo and Infra rejected by a stand-in Trust.allowed and Core to Core accepted", () => {
    const heights: Record<Layer, number> = {
      LayerCli: 5,
      LayerPipeline: 4,
      LayerInfra: 3,
      LayerConfig: 2,
      LayerCore: 1,
      LayerNodeIo: 0,
    };
    const standIn: Allowed = (from, to) =>
      from.$ === "LayerCore" ? to.$ === "LayerCore" : heights[to.$] <= heights[from.$] && from.$ !== "LayerNodeIo";
    const coreOnly = (file: string): Layer => (file === "scripts/node-io.mjs" ? "LayerInfra" : "LayerCore");
    expect(forbiddenEdges(graph.edges, coreOnly, standIn).sort()).toStrictEqual([
      "scripts/judge-verdict.mjs (LayerCore) -> process.env (LayerNodeIo) [env]",
      "scripts/judge-verdict.mjs (LayerCore) -> scripts/node-io.mjs (LayerInfra) [dynamic]",
      "scripts/spec-hash.mjs (LayerCore) -> node:fs (LayerNodeIo) [static]",
    ]);
  });

  it("to be a two-module cycle and a self-import found and an acyclic graph clean", () => {
    expect(cyclicComponents(new Map([["a", ["b"]], ["b", ["a"]], ["c", []]]))).toStrictEqual([["a", "b"]]);
    expect(cyclicComponents(new Map([["a", ["a"]]]))).toStrictEqual([["a"]]);
    expect(cyclicComponents(new Map([["a", ["b"]], ["b", ["c"]], ["c", []]]))).toStrictEqual([]);
  });
});
