export const STUDY_SPEC_VERSION: "study-spec/0.1";
export const SESSION_VERSION: "session/0.1";
export const OBSERVATION_VERSION: "observation/0.1";
export const INTERACTION_EVENT_VERSION: "interaction-event/0.1";
export const EVIDENCE_MANIFEST_VERSION: "evidence-manifest/0.2";
export const FUNCTIONAL_EVALUATION_VERSION: "functional-evaluation/0.1";
export const FRICTION_POINT_VERSION: "friction-point/0.1";
export const FINDING_VERSION: "finding/0.1";
export const SIMULATION_VALIDITY_VERSION: "simulation-validity/0.1";
export const VARIANT_COMPARISON_REPORT_VERSION: "variant-comparison-report/0.1";
export const VALIDATION_ERROR_CODE: "CONTRACT_VALIDATION_FAILED";
export const MIGRATION_ERROR_CODE: "CONTRACT_MIGRATION_FAILED";

export type Primitive = string | number | boolean | null;
export type JsonValue = Primitive | JsonValue[] | { [key: string]: JsonValue };

export class ContractValidationError extends Error { code: typeof VALIDATION_ERROR_CODE; path: string; }
export class ContractMigrationError extends Error { code: typeof MIGRATION_ERROR_CODE; path: string; }

export interface Viewport { width: number; height: number; deviceScaleFactor?: number; isMobile?: boolean; }
export interface ActionSafetyPolicy { allowRead: boolean; allowNavigation: boolean; allowClick: boolean; allowTyping: boolean; allowFileUpload: boolean; allowStateMutation: boolean; allowExternalOrigin: boolean; forbiddenActions: Array<"payment" | "subscription_change" | "account_delete" | "data_delete" | "send_message" | "confirm_destructive">; stopBeforeConfirmation: boolean; }
export type Oracle =
  | { id: string; type: "url"; operation: "equals" | "contains" | "matches"; value: string }
  | { id: string; type: "visible_text"; operation: "contains" | "not_contains" | "matches"; value: string }
  | { id: string; type: "element"; role?: string; name?: string; state: "visible" | "hidden" | "enabled" | "disabled" | "checked" }
  | { id: string; type: "network"; method?: string; urlPattern: string; status?: number }
  | { id: string; type: "event"; name: string; properties?: Record<string, Primitive> }
  | { id: string; type: "download"; filenamePattern?: string; mimeType?: string }
  | { id: string; type: "custom"; evaluatorId: string; input?: Record<string, unknown> };
export interface TaskSpec { id: string; name: string; goal: string; context?: string; startPath?: string; startingState?: Record<string, unknown>; successOracles: Oracle[]; failureOracles?: Oracle[]; businessOracles?: Oracle[]; safetyPolicy: ActionSafetyPolicy; maxActions: number; maxDurationMs: number; maxConsecutiveNoProgressActions: number; abandonmentAllowed: boolean; humanValidation?: HumanValidationRequirement; }
export type PersonaSpec = { preset: string; id?: string; name?: string } | Record<string, unknown>;
export interface VariantComparisonSpec { baseline: { id: string; baseUrl: string; revision?: string }; candidate: { id: string; baseUrl: string; revision?: string }; assignment: "paired" | "independent"; counterbalanceOrder: boolean; metrics: Array<"task_completion" | "action_count" | "backtrack" | "failed_interaction" | "abandonment" | "finding_recurrence" | "route_entropy">; }
export interface StudySpec { schemaVersion: typeof STUDY_SPEC_VERSION; study: { id: string; name: string; description?: string; tags?: string[] }; product: { description: string; domain?: string; audience?: string; metadata?: Record<string, unknown> }; environment: { baseUrl: string; startPath?: string; allowedOrigins: string[]; blockedOrigins?: string[]; viewport: Viewport; locale?: string; timezoneId?: string; auth?: Record<string, unknown>; storageStatePath?: string; fixtures?: Record<string, string>; network?: Record<string, unknown>; reset?: { beforeSessionCommand?: string; afterSessionCommand?: string } }; tasks: TaskSpec[]; personas: PersonaSpec[]; runtime: { seeds: number[]; concurrency: number; modelRoles: { action: string; evaluator: string; cluster?: string }; budgets?: Record<string, unknown> }; evidence: { screenshot: "off" | "on_failure" | "every_action"; trace: boolean; video: "off" | "on_failure" | "all"; semanticSnapshot: "off" | "on_failure" | "every_action" }; evaluation: { minimumRecurrenceForFinding: number; validityReport: boolean }; comparison?: VariantComparisonSpec; provenance?: { source: "manual" | "playwright-spec" | "qa-ir" | "generated"; sourceRefs?: string[]; generatedAt?: string }; }
export type BrowserAction =
  | { type: "click"; elementId: string; reasonCode: string }
  | { type: "type"; elementId: string; valueRef: string; reasonCode: string }
  | { type: "select"; elementId: string; value: string; reasonCode: string }
  | { type: "scroll"; direction: "up" | "down"; amount: "small" | "medium" | "large"; reasonCode: string }
  | { type: "back" | "observe_more" | "finish" | "abandon"; reasonCode: string }
  | { type: "wait" | "idle"; durationMs: number; reasonCode: string }
  | { type: "ignore"; elementId?: string; reasonCode: string };
export interface SessionRecord { schemaVersion: typeof SESSION_VERSION; runId: string; sessionId: string; studyId: string; taskId: string; personaId: string; seed: number; variant?: string; model?: string; status: "created" | "running" | "success" | "partial" | "failure" | "abandoned" | "runtime_error" | "manual_review"; startedAt: string; completedAt?: string; sampledPolicy: Record<string, unknown>; terminalReason?: Record<string, unknown>; eventIds: string[]; evidenceManifestId?: string; }
export interface InteractionEvent { schemaVersion: typeof INTERACTION_EVENT_VERSION; id: string; sessionId: string; index: number; timestamp: string; observationId: string; action: BrowserAction; result: { status: "success" | "failure" | "no_change" | "blocked"; message?: string }; urlBefore: string; urlAfter: string; evidenceIds: string[]; derivedSignals: Record<"progressChanged" | "backtrack" | "repeatedPage" | "failedInteraction" | "noProgress", boolean>; }
export interface EvidenceEntry { id: string; type: "screenshot" | "semantic_snapshot" | "trace" | "video" | "console_issue" | "network_failure" | "download" | "oracle_result" | "action_result"; relativePath?: string; contentHash: string; byteSize?: number; metadata?: Record<string, unknown>; }
export interface EvidenceManifest { schemaVersion: typeof EVIDENCE_MANIFEST_VERSION; id: string; runId: string; sessionId: string; createdAt: string; sealedAt: string; sealed: true; repositoryRevision?: string; studyHash: string; policyHash: string; entries: EvidenceEntry[]; manifestHash: string; redactionSummary: { redactedCount: number; rulesVersion: string }; }
export interface FunctionalEvaluation { schemaVersion: typeof FUNCTIONAL_EVALUATION_VERSION; status: "success" | "partial" | "failure" | "runtime_error" | "manual_review"; satisfiedOracleIds: string[]; violatedOracleIds: string[]; unknownOracleIds: string[]; evidenceIds: string[]; reasons: string[]; }
export interface FindingConfidence { evidenceConfidence: number; recurrenceConfidence: number; seedStability: number | "not_available"; modelAgreement: number | "not_available"; calibrationConfidence: number | "not_available"; orderConsistency: number | "not_available"; overall: "low" | "medium" | "high"; limitations: string[]; }
export interface HumanValidationRequirement { required?: boolean; level?: "none" | "recommended" | "required"; reason?: string; sensitive?: boolean; }

export function canonicalJson(value: unknown): string;
export function canonicalHash(value: unknown): string;
export function stableId(prefix: string, parts: unknown[]): string;
export function createSessionId(input: { runId: string; taskId: string; personaId: string; seed: number; variant?: string }): string;
export function createEventId(sessionId: string, sequence: number): string;
export function createEvidenceId(input: { sessionId: string; type: string; sequence: number; contentHash: string }): string;
export function validateContract(contractName: string, value: unknown): unknown;
export function validateStudySpec(value: unknown): Readonly<StudySpec>;
export function validateSessionRecord(value: unknown): Readonly<SessionRecord>;
export function validateObservation(value: unknown): unknown;
export function validateInteractionEvent(value: unknown): Readonly<InteractionEvent>;
export function validateEvidenceManifest(value: unknown): Readonly<EvidenceManifest>;
export function validateFunctionalEvaluation(value: unknown): Readonly<FunctionalEvaluation>;
export function validateBehavioralFingerprint(value: unknown): unknown;
export function validateFrictionPoint(value: unknown): unknown;
export function validateFinding(value: unknown): unknown;
export function validateSimulationValidityReport(value: unknown): unknown;
export function validateVariantComparisonSpec(value: unknown): Readonly<VariantComparisonSpec>;
export function validateVariantComparisonReport(value: unknown): unknown;
export function createMigrationRegistry(): { register(migrator: { from: string; to: string; migrate(value: unknown): unknown }): void; migrate(value: unknown, to: string): unknown };
export function migrateContract(value: unknown, to: string, registry?: ReturnType<typeof createMigrationRegistry>): unknown;
export const defaultMigrationRegistry: ReturnType<typeof createMigrationRegistry>;
export const validators: Readonly<Record<string, (value: unknown) => unknown>>;
