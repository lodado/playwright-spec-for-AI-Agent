import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import {
  jsxAttribute,
  jsxIdentifier,
  stringLiteral,
  type JSXOpeningElement,
  type Node,
} from "@babel/types";
import { z } from "zod";
import {
  DesignConvergenceError,
  designBindingSchema,
  designBindingsFileSchema,
  type DesignBinding,
} from "@design-convergence/shared";
import { collectJsxOpeningElements, resolveTarget } from "./resolve-target.js";

/**
 * Minimal shape of the Babel plugin pass this visitor reads. Typed locally so
 * the package does not depend on `@babel/core` (blocked by the repo's
 * supply-chain policy); the consumer's Babel provides the real runtime.
 */
interface BabelPluginPass {
  readonly file: {
    readonly code: string;
    readonly opts: { readonly filename?: string };
  };
  readonly filename?: string;
}

export interface PluginObj {
  readonly name: string;
  readonly visitor: {
    Program?: (path: { node: Node }, state: BabelPluginPass) => void;
  };
}

const optionsSchema = z
  .object({
    /** When omitted, the env var below decides. Disabled path never reads files. */
    enabled: z.boolean().optional(),
    envVar: z.string().min(1).default("DESIGN_CONVERGENCE"),
    projectRoot: z.string().min(1),
    bindingsPath: z.string().min(1).optional(),
    bindings: z.array(designBindingSchema).optional(),
  })
  .strict()
  .refine((o) => o.bindingsPath != null || o.bindings != null, {
    message: "instrumentation plugin requires bindingsPath or bindings",
  });

function toProjectRelative(filename: string, projectRoot: string): string {
  const rel = isAbsolute(filename) ? relative(projectRoot, filename) : filename;
  return rel.split(sep).join("/");
}

function loadBindings(
  options: z.infer<typeof optionsSchema>,
): readonly DesignBinding[] {
  if (options.bindings != null) return options.bindings;
  const raw: unknown = JSON.parse(readFileSync(options.bindingsPath!, "utf8"));
  return designBindingsFileSchema.parse(raw).bindings;
}

function injectAttribute(
  element: JSXOpeningElement,
  binding: DesignBinding,
): void {
  const { attributeName, attributeValue } = binding.runtime;
  const existing = element.attributes.find(
    (attr) =>
      attr.type === "JSXAttribute" &&
      attr.name.type === "JSXIdentifier" &&
      attr.name.name === attributeName,
  );
  if (existing != null) {
    const current =
      existing.type === "JSXAttribute" &&
      existing.value?.type === "StringLiteral"
        ? existing.value.value
        : undefined;
    if (current === attributeValue) return; // idempotent: identical attribute
    throw new DesignConvergenceError(
      "instrumentation",
      `binding ${binding.id}: attribute ${attributeName} already present with a conflicting value`,
      { reason: "attribute-conflict", bindingId: binding.id, attributeName },
    );
  }
  element.attributes.push(
    jsxAttribute(jsxIdentifier(attributeName), stringLiteral(attributeValue)),
  );
}

/**
 * Test-only Babel plugin that injects one manual binding's runtime attribute on
 * its resolved JSX opening element. Standard Babel signature
 * `(api, options, dirname)`; the disabled path is a no-op that never reads
 * binding files. A stale or ambiguous binding fails the transform before any
 * app or browser process starts.
 */
export function instrumentationPlugin(
  _api: unknown,
  rawOptions: unknown,
): PluginObj {
  const options = optionsSchema.parse(rawOptions);
  const enabled = options.enabled ?? process.env[options.envVar] === "true";
  if (!enabled) {
    return { name: "design-convergence-instrumentation", visitor: {} };
  }

  const bindings = loadBindings(options);

  return {
    name: "design-convergence-instrumentation",
    visitor: {
      Program(path, state) {
        const filename = state.file.opts.filename ?? state.filename;
        if (filename == null) {
          throw new DesignConvergenceError(
            "instrumentation",
            "Babel pass is missing a filename",
            { reason: "missing-filename" },
          );
        }
        const currentFile = toProjectRelative(filename, options.projectRoot);
        const source = state.file.code;

        for (const binding of bindings) {
          if (binding.target.filePath !== currentFile) continue;
          // Validate identity + stale guards; throws before any injection
          // (including `unsupported-target-kind` for component-root bindings).
          resolveTarget({ binding, filePath: currentFile, source });
          const { target } = binding;
          if (target.kind !== "intrinsic-jsx-element") continue; // unreachable: resolveTarget threw
          const element = collectJsxOpeningElements(
            path.node,
            target.elementName,
          )[target.occurrence];
          if (element == null) {
            throw new DesignConvergenceError(
              "instrumentation",
              `binding ${binding.id}: resolved element vanished from the live AST`,
              { reason: "missing-target", bindingId: binding.id },
            );
          }
          injectAttribute(element, binding);
        }
      },
    },
  };
}
