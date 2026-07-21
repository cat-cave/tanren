// in-21 — Integration Control Center BFF contract types. These mirror the
// FROZEN in-20 HTTP read surface (`services/orchestrator/src/routes/integrations/
// contract.ts`) shape-for-shape. The orchestrator validates every response
// through its Zod schemas before it crosses the wire (each store calls
// `ResponseSchema.parse(...)`), so the dashboard receives a strictly-typed
// body and trusts that shape — the same trust boundary every other dashboard
// read client (`integrationEvents.ts`, `governance.ts`) uses.
//
// REDACTION follows in-20: bindings carry the in-15 `appEnvHash` PROOF (the
// content digest of the canonical app-env the materializer sealed), NEVER a
// resolved env value / token / principal secret. The TS types below express
// only the fields the orchestrator publishes.

/** The version tag every in-20 response carries. Bumped only on a breaking change. */
export const INTEGRATION_READ_SURFACE_VERSION = "v1" as const;
export type IntegrationReadSurfaceVersion = typeof INTEGRATION_READ_SURFACE_VERSION;

export type IntegrationPlane = "control" | "product";
export type IntegrationDirection = "inbound" | "outbound" | "bidirectional";
export type IntegrationEnvironment = "test" | "preview" | "production";
export type IntegrationCriticality = "merge_required" | "release_required" | "best_effort";
export type IntegrationRequirementStatus = "active" | "superseded" | "needs_attention";
export type IntegrationRequirementSourceKind = "behavior_revision" | "design_contract";

export type CapabilityNodeStatus = "pending" | "enqueued" | "awaiting_grant" | "ready" | "needs_attention";
export type CapabilityNodeExecutorKind = "provider_operation";

export type IntegrationBindingStatus = "pending" | "ready" | "drifted" | "needs_attention" | "retired";
export type IntegrationBindingDriftState = "unknown" | "in_sync" | "drifted";
export type IntegrationBindingOwnership = "created" | "adopted" | "shared";
export type IntegrationBindingTeardownPolicy = "delete" | "retain";
export type IntegrationBindingEnvClassification = "secret" | "non_secret";
export type IntegrationBindingEnvScope = "build" | "test" | "runtime" | "dev";

export type DeliveryRunStatus = "pending" | "claimed" | "running" | "completed" | "degraded" | "needs_attention";
export type DeliveryStage =
  | "reconcile_binding"
  | "mint_lease"
  | "materialize_env"
  | "attach_runtime"
  | "deploy"
  | "verify_deploy"
  | "stimulate"
  | "observe"
  | "record_evidence";
export type DeliveryStageAttemptStatus = "pending" | "claimed" | "running" | "succeeded" | "retry_scheduled" | "failed";

// --- Lifecycle inventory (in-3 rollup, first-class in in-20) --------------

export interface IntegrationLifecycleInventoryResponse {
  readonly version: IntegrationReadSurfaceVersion;
  readonly orgId: string;
  readonly projectId: string;
  readonly requirements: { readonly total: number; readonly needsAttention: number };
  readonly capabilityNodes: {
    readonly total: number;
    readonly awaitingGrant: number;
    readonly ready: number;
    readonly needsAttention: number;
  };
  readonly bindings: {
    readonly total: number;
    readonly ready: number;
    readonly drifted: number;
    readonly needsAttention: number;
  };
  readonly deliveries: {
    readonly total: number;
    readonly completed: number;
    readonly degraded: number;
    readonly needsAttention: number;
  };
}

// --- Integration requirements ----------------------------------------------

export interface IntegrationRequirementView {
  readonly requirementId: string;
  readonly capability: string;
  readonly plane: IntegrationPlane;
  readonly direction: IntegrationDirection;
  readonly sourceKind: IntegrationRequirementSourceKind;
  readonly sourceRevisionId: string;
  readonly sourceDigest: string;
  readonly policyVersion: string;
  readonly criticality: IntegrationCriticality;
  readonly status: IntegrationRequirementStatus;
  readonly supersededBy: string | null;
  readonly createdAt: string;
}

export interface IntegrationRequirementsResponse {
  readonly version: IntegrationReadSurfaceVersion;
  readonly orgId: string;
  readonly projectId: string;
  readonly requirements: readonly IntegrationRequirementView[];
}

// --- Capability nodes (in-9 / in-10 / in-17) -------------------------------

export interface CapabilityNodeView {
  readonly nodeId: string;
  readonly requirementId: string;
  readonly environment: IntegrationEnvironment;
  readonly executorKind: CapabilityNodeExecutorKind;
  readonly desiredStateHash: string;
  readonly status: CapabilityNodeStatus;
  readonly waitReason: string | null;
  readonly priority: number;
  readonly generation: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CapabilityNodesResponse {
  readonly version: IntegrationReadSurfaceVersion;
  readonly orgId: string;
  readonly projectId: string;
  readonly capabilityNodes: readonly CapabilityNodeView[];
}

// --- Integration bindings with the in-15 appEnvHash proof -------------------

export interface IntegrationBindingOutputShapeView {
  readonly logicalKey: string;
  readonly classification: IntegrationBindingEnvClassification;
  readonly required: boolean;
  readonly scopes: readonly IntegrationBindingEnvScope[];
}

export interface IntegrationBindingCurrentGenerationView {
  readonly generation: number;
  readonly authGeneration: number;
  readonly grantId: string;
  readonly grantGeneration: number;
  readonly adapterVersion: string;
  readonly resource: {
    readonly externalResourceId: string;
    readonly externalResourceName: string;
  };
  readonly ownership: IntegrationBindingOwnership;
  readonly teardownPolicy: IntegrationBindingTeardownPolicy;
  /** The in-15 content digest of the canonical app-env the materializer sealed. */
  readonly appEnvHash: string;
  readonly outputs: readonly IntegrationBindingOutputShapeView[];
}

export interface IntegrationBindingListItem {
  readonly bindingId: string;
  readonly requirementId: string;
  readonly environment: IntegrationEnvironment;
  readonly providerKind: string;
  readonly connectionId: string;
  readonly currentGenerationNumber: number | null;
  readonly status: IntegrationBindingStatus;
  readonly driftState: IntegrationBindingDriftState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentGeneration: IntegrationBindingCurrentGenerationView | null;
}

export interface IntegrationBindingsResponse {
  readonly version: IntegrationReadSurfaceVersion;
  readonly orgId: string;
  readonly projectId: string;
  readonly bindings: readonly IntegrationBindingListItem[];
}

// --- Delivery DAG status (in-17 / in-19) ------------------------------------

export interface DeliveryRunBindingRef {
  readonly bindingId: string;
  readonly bindingGeneration: number;
}

export interface DeliveryStageCurrentAttemptView {
  readonly stage: DeliveryStage;
  readonly ordinal: number;
  readonly latestAttempt: number;
  readonly latestStatus: DeliveryStageAttemptStatus;
  readonly failureClassification: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface DeliveryRunView {
  readonly deliveryRunId: string;
  readonly authorityDecisionId: string;
  readonly mergeSha: string;
  readonly status: DeliveryRunStatus;
  readonly retryAfter: string | null;
  readonly failureClassification: string | null;
  readonly stages: readonly DeliveryStageCurrentAttemptView[];
  readonly bindings: readonly DeliveryRunBindingRef[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface DeliveryDagStatusResponse {
  readonly version: IntegrationReadSurfaceVersion;
  readonly orgId: string;
  readonly projectId: string;
  readonly deliveryRuns: readonly DeliveryRunView[];
}

// --- Status-preserving read result -----------------------------------------

/**
 * Every in-20 read returns this wrapper so the UI can distinguish a legitimate
 * empty (200 with `[]`) from an unavailable or malformed read. The orchestrator
 * Zod-validates each response before it crosses the wire, so a malformed body
 * indicates transport corruption or an off-shape orchestrator bug; we never
 * mask that as a successful empty panel.
 */
export type IntegrationReadResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: "unavailable" | "malformed"; readonly status: number };

/**
 * The shape every in-20 response carries at the top level. Used by the small
 * defensive scope check the BFF runs (the version tag, the orgId/projectId
 * match the request) before promoting the response to a typed value. The
 * check blocks a buggy/leaky orchestrator from putting data for org B under a
 * panel the operator requested for org A.
 */
export interface BaseIntegrationReadResponse {
  readonly version: IntegrationReadSurfaceVersion;
  readonly orgId: string;
  readonly projectId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Verifies the surface-scope invariants every in-20 response shares: the
 * version tag is the frozen `v1`, the body is a record, and the org+project
 * ids match what the caller asked for. Returns the body typed as `T` on
 * success; otherwise signals `malformed` so the caller renders an honest
 * failure state. The check is intentionally shallow — the orchestrator's Zod
 * schema is the load-bearing shape authority.
 */
export function decodeIntegrationReadResponse<T extends BaseIntegrationReadResponse>(
  body: unknown,
  expectedOrgId: string,
  expectedProjectId: string,
): { readonly ok: true; readonly data: T } | { readonly ok: false; readonly failure: "malformed" } {
  if (
    !isRecord(body) ||
    body["version"] !== INTEGRATION_READ_SURFACE_VERSION ||
    body["orgId"] !== expectedOrgId ||
    body["projectId"] !== expectedProjectId
  ) {
    return { ok: false, failure: "malformed" };
  }
  return { ok: true, data: body as T };
}
