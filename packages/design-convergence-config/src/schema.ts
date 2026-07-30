import { z } from "zod";

/**
 * A secret is authored as a reference to an environment variable, never as a
 * literal value: `"accessToken": { "env": "FIGMA_ACCESS_TOKEN" }`. The loader
 * keeps it as a SecretRef; only the REST/provider/GitHub boundary resolves it.
 */
export const secretRefSchema = z.object({ env: z.string().min(1) }).strict();
export type SecretRef = z.infer<typeof secretRefSchema>;

/**
 * Internal command representation. `spawn(executable, args, { shell: false })`
 * is the only execution form, so a command is always {executable, args}.
 */
export const normalizedCommandSchema = z
  .object({ executable: z.string().min(1), args: z.array(z.string()) })
  .strict();
export type NormalizedCommand = z.infer<typeof normalizedCommandSchema>;

const SHELL_METACHAR = /[;&|<>$`(){}\[\]!*?~#\\'"\n\r]/;

/**
 * A command is either a plain string of space-separated safe tokens or an
 * explicit {executable, args}. A string containing shell metacharacters is
 * rejected — those must use the explicit form so nothing is ever shelled out.
 */
export const commandSchema = z
  .union([z.string().min(1), normalizedCommandSchema])
  .superRefine((value, ctx) => {
    if (typeof value !== "string") return;
    if (value.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "command is empty",
      });
      return;
    }
    if (SHELL_METACHAR.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "command string contains shell metacharacters; use { executable, args }",
      });
    }
  })
  .transform((value): NormalizedCommand => {
    if (typeof value !== "string") return value;
    const parts = value.trim().split(/\s+/);
    return { executable: parts[0]!, args: parts.slice(1) };
  });

const viewportSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive().default(1),
  })
  .strict();

const caseSchema = z
  .object({
    id: z.string().min(1),
    route: z
      .string()
      .min(1)
      .refine((r) => r.startsWith("/") && !r.startsWith("//"), {
        message:
          "route must be a same-origin path starting with '/', not an absolute URL",
      }),
    viewport: viewportSchema,
    figmaRootNodeId: z.string().min(1),
    prepare: z.string().min(1).optional(),
    readySelector: z.string().min(1).optional(),
  })
  .strict();
export type CaseConfig = z.infer<typeof caseSchema>;

const figmaSchema = z
  .object({
    fileKey: z.string().min(1),
    accessToken: secretRefSchema.optional(),
  })
  .strict();

const executionSchema = z
  .object({
    // Security-critical: no default. The user must consciously state whether
    // project code (app command, prepare module, build) may run.
    allowProjectCode: z.boolean(),
  })
  .strict();

const appSchema = z
  .object({
    command: commandSchema,
    readyURL: z.string().url().optional(),
    startupTimeoutMs: z.number().int().positive().default(30000),
  })
  .strict();

const instrumentationSchema = z
  .object({
    attributeName: z
      .string()
      .regex(/^data-[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .default("data-design-node"),
    envVar: z.string().min(1).default("DESIGN_CONVERGENCE"),
  })
  .strict()
  .default({});

const severityWeightsSchema = z
  .object({
    info: z.number().default(0),
    low: z.number().default(1),
    medium: z.number().default(3),
    high: z.number().default(8),
    critical: z.number().default(20),
  })
  .strict()
  .default({});

const comparisonSchema = z
  .object({
    tolerance: z.record(z.string(), z.number()).default({}),
    severityWeights: severityWeightsSchema,
    fontAliases: z.record(z.string(), z.array(z.string())).default({}),
    // Safe default: cursor/caret-color never affect a design comparison.
    ignoredProperties: z.array(z.string()).default(["cursor", "caret-color"]),
  })
  .strict()
  .default({});

// Shape-only in Phase 01; the patch phase (07) gives these behavior.
const patchingSchema = z
  .object({
    allowedGlobs: z.array(z.string()).default([]),
    forbiddenGlobs: z.array(z.string()).default([]),
    cssOnly: z.boolean().default(true),
    allowJsxClassNameChanges: z.boolean().default(false),
    allowStructuralJsxChanges: z.boolean().default(false),
  })
  .strict()
  .optional();

// Shape-only in Phase 01; the verification phase (08) gives these behavior.
const verificationSchema = z
  .object({
    requiredChecks: z
      .array(z.enum(["format", "type-check", "lint", "test", "build"]))
      .default([]),
    // Minimum number of diff records a patch must resolve to count as improved.
    minimumImprovement: z.number().int().nonnegative().default(1),
    commands: z.record(z.string(), commandSchema).optional(),
  })
  .strict()
  .optional();

const aiSchema = z
  .discriminatedUnion("provider", [
    z.object({ provider: z.literal("mock") }).strict(),
    z
      .object({
        provider: z.literal("openai-compatible"),
        baseURL: z.string().url(),
        model: z.string().min(1),
        apiKey: secretRefSchema,
      })
      .strict(),
  ])
  .optional();

const githubSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    baseBranch: z.string().min(1),
    token: secretRefSchema,
  })
  .strict()
  .optional();

export const configSchema = z
  .object({
    // Allow (and ignore) the editor-support hint at the top of config.json.
    $schema: z.string().optional(),
    project: z
      .object({ rootDir: z.string().min(1).default(".") })
      .strict()
      .default({}),
    figma: figmaSchema,
    execution: executionSchema,
    app: appSchema.optional(),
    instrumentation: instrumentationSchema,
    comparison: comparisonSchema,
    patching: patchingSchema,
    verification: verificationSchema,
    ai: aiSchema,
    github: githubSchema,
    // Project-relative path to the manual `design-bindings.json`. Absent file is
    // treated as zero eligible bindings; a present file is validated + preflighted.
    bindings: z.string().min(1).default("design-bindings.json"),
    cases: z.array(caseSchema).min(1),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.cases.forEach((c, index) => {
      if (seen.has(c.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index, "id"],
          message: `duplicate case id: ${c.id}`,
        });
      }
      seen.add(c.id);
    });
  });

export type DesignConvergenceConfig = z.infer<typeof configSchema>;
export type DesignConvergenceConfigInput = z.input<typeof configSchema>;
