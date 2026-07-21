// in-20 — the STABLE, versioned response contract for the integration HTTP READ
// surface (the "visible" in provable/callable/visible). Mirrors the rv-22 read
// surface (`routes/runtimeVerification/contract.ts`) shape-for-shape: every field
// a read route surfaces is named and typed here once, the surface is closed
// (`.strict()`), and the rendered JSON-Schema set is pinned against drift by a
// committed compatibility floor (the `integration-read-compat` guard) plus the
// unified `contracts/json/integrations/**` byte-exact mirror via the central
// `engine/schemaExport/catalog.ts`.
//
// REDACTION is the law here. The binding response carries the `appEnvHash` proof
// (in-15) — the content-addressed digest of the canonical app-env the materializer
// sealed at materialize time — NEVER the resolved env values, never a token, never
// a principal secret, never a raw provider response body. The requirement response
// surfaces the row's typed lifecycle fields; the deep `desired_state` body is
// intentionally NOT exposed (it lives in the spec registry, identified by
// `sourceDigest`). A failed / inconclusive state is a first-class enum member so
// the read surface can never launder a needs-attention row into a ready one.

import { z, type ZodType } from "zod";

/** The frozen version tag every response carries. Bump to `v2` on a breaking change. */
export const INTEGRATION_READ_SURFACE_VERSION = "v1" as const;

// --- Closed string sets (mirror the DB CHECK constraints in 0043) ------------
export const IntegrationPlaneRead = z.enum(["control", "product"]);
export const IntegrationDirectionRead = z.enum(["inbound", "outbound", "bidirectional"]);
export const IntegrationEnvironmentRead = z.enum(["test", "preview", "production"]);
export const IntegrationCriticalityRead = z.enum(["merge_required", "release_required", "best_effort"]);
export const IntegrationRequirementStatusRead = z.enum(["active", "superseded", "needs_attention"]);
export const IntegrationRequirementSourceKindRead = z.enum(["behavior_revision", "design_contract"]);

export const CapabilityNodeStatusRead = z.enum(["pending", "enqueued", "awaiting_grant", "ready", "needs_attention"]);
export const CapabilityNodeExecutorKindRead = z.enum(["provider_operation"]);

export const IntegrationBindingStatusRead = z.enum(["pending", "ready", "drifted", "needs_attention", "retired"]);
export const IntegrationBindingDriftStateRead = z.enum(["unknown", "in_sync", "drifted"]);
export const IntegrationBindingOwnershipRead = z.enum(["created", "adopted", "shared"]);
export const IntegrationBindingTeardownPolicyRead = z.enum(["delete", "retain"]);
export const IntegrationBindingEnvClassificationRead = z.enum(["secret", "non_secret"]);
export const IntegrationBindingEnvScopeRead = z.enum(["build", "test", "runtime", "dev"]);

export const DeliveryRunStatusRead = z.enum([
  "pending",
  "claimed",
  "running",
  "completed",
  "degraded",
  "needs_attention",
]);
export const DeliveryStageRead = z.enum([
  "reconcile_binding",
  "mint_lease",
  "materialize_env",
  "attach_runtime",
  "deploy",
  "verify_deploy",
  "stimulate",
  "observe",
  "record_evidence",
]);
export const DeliveryStageAttemptStatusRead = z.enum([
  "pending",
  "claimed",
  "running",
  "succeeded",
  "retry_scheduled",
  "failed",
]);

// --- Lifecycle inventory (in-3 rollup, promoted to first-class endpoint) -----

const RequirementsInventoryBucket = z
  .object({
    total: z.number().int().nonnegative(),
    needsAttention: z.number().int().nonnegative(),
  })
  .strict();

const CapabilityNodesInventoryBucket = z
  .object({
    total: z.number().int().nonnegative(),
    awaitingGrant: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    needsAttention: z.number().int().nonnegative(),
  })
  .strict();

const BindingsInventoryBucket = z
  .object({
    total: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    drifted: z.number().int().nonnegative(),
    needsAttention: z.number().int().nonnegative(),
  })
  .strict();

const DeliveriesInventoryBucket = z
  .object({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    degraded: z.number().int().nonnegative(),
    needsAttention: z.number().int().nonnegative(),
  })
  .strict();

/** GET .../integrations/lifecycle — the in-3 rollup, first-class. */
export const IntegrationLifecycleInventoryResponse = z
  .object({
    version: z.literal(INTEGRATION_READ_SURFACE_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    requirements: RequirementsInventoryBucket,
    capabilityNodes: CapabilityNodesInventoryBucket,
    bindings: BindingsInventoryBucket,
    deliveries: DeliveriesInventoryBucket,
  })
  .strict();
export type IntegrationLifecycleInventoryResponse = z.infer<typeof IntegrationLifecycleInventoryResponse>;

// --- Integration requirements ------------------------------------------------

/** One requirement row — typed lifecycle fields, never the raw `desired_state` JSONB. */
export const IntegrationRequirementView = z
  .object({
    requirementId: z.string().min(1),
    capability: z.string().min(1),
    plane: IntegrationPlaneRead,
    direction: IntegrationDirectionRead,
    sourceKind: IntegrationRequirementSourceKindRead,
    sourceRevisionId: z.string().min(1),
    sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    policyVersion: z.string().min(1),
    criticality: IntegrationCriticalityRead,
    status: IntegrationRequirementStatusRead,
    supersededBy: z.string().min(1).nullable(),
    createdAt: z.coerce.date(),
  })
  .strict();
export type IntegrationRequirementView = z.infer<typeof IntegrationRequirementView>;

/** GET .../integration-requirements — the project's requirement lifecycle rows. */
export const IntegrationRequirementsResponse = z
  .object({
    version: z.literal(INTEGRATION_READ_SURFACE_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    requirements: z.array(IntegrationRequirementView),
  })
  .strict();
export type IntegrationRequirementsResponse = z.infer<typeof IntegrationRequirementsResponse>;

// --- Capability nodes (in-9 / in-10 / in-17) ---------------------------------

/** One capability-node row — the per-(requirement, environment) prepare state. */
export const CapabilityNodeView = z
  .object({
    nodeId: z.string().min(1),
    requirementId: z.string().min(1),
    environment: IntegrationEnvironmentRead,
    executorKind: CapabilityNodeExecutorKindRead,
    desiredStateHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    status: CapabilityNodeStatusRead,
    waitReason: z.string().nullable(),
    priority: z.number().int().nonnegative(),
    generation: z.number().int().positive(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .strict();
export type CapabilityNodeView = z.infer<typeof CapabilityNodeView>;

/** GET .../capability-nodes — the project's capability_nodes lifecycle rows. */
export const CapabilityNodesResponse = z
  .object({
    version: z.literal(INTEGRATION_READ_SURFACE_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    capabilityNodes: z.array(CapabilityNodeView),
  })
  .strict();
export type CapabilityNodesResponse = z.infer<typeof CapabilityNodesResponse>;

// --- Integration bindings with the in-15 appEnvHash proof --------------------

/** The exact-generation output-shape entry — a logical env key, NEVER a value. */
export const IntegrationBindingOutputShapeView = z
  .object({
    logicalKey: z.string().min(1).max(128),
    classification: IntegrationBindingEnvClassificationRead,
    required: z.boolean(),
    scopes: z.array(IntegrationBindingEnvScopeRead).min(1),
  })
  .strict();
export type IntegrationBindingOutputShapeView = z.infer<typeof IntegrationBindingOutputShapeView>;

/**
 * The current-generation sealed view of an integration binding — the immutable
 * materialized state at `current_generation`. Carries the in-15 `appEnvHash` PROOF
 * (the content digest of the canonical app-env the materializer sealed) and the
 * logical output SHAPE; NEVER a resolved env value, token, or provider response.
 */
export const IntegrationBindingCurrentGenerationView = z
  .object({
    generation: z.number().int().positive(),
    authGeneration: z.number().int().positive(),
    grantId: z.string().min(1),
    grantGeneration: z.number().int().positive(),
    adapterVersion: z.string().min(1),
    resource: z
      .object({
        externalResourceId: z.string().min(1),
        externalResourceName: z.string().min(1),
      })
      .strict(),
    ownership: IntegrationBindingOwnershipRead,
    teardownPolicy: IntegrationBindingTeardownPolicyRead,
    appEnvHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    outputs: z.array(IntegrationBindingOutputShapeView).min(1),
  })
  .strict();
export type IntegrationBindingCurrentGenerationView = z.infer<typeof IntegrationBindingCurrentGenerationView>;

/** One binding row + its current-generation sealed view (nullable while pending). */
export const IntegrationBindingListItem = z
  .object({
    bindingId: z.string().min(1),
    requirementId: z.string().min(1),
    environment: IntegrationEnvironmentRead,
    providerKind: z.string().min(1),
    connectionId: z.string().min(1),
    currentGenerationNumber: z.number().int().positive().nullable(),
    status: IntegrationBindingStatusRead,
    driftState: IntegrationBindingDriftStateRead,
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    currentGeneration: IntegrationBindingCurrentGenerationView.nullable(),
  })
  .strict();
export type IntegrationBindingListItem = z.infer<typeof IntegrationBindingListItem>;

/** GET .../integration-bindings — the project's bindings + their appEnvHash proof. */
export const IntegrationBindingsResponse = z
  .object({
    version: z.literal(INTEGRATION_READ_SURFACE_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    bindings: z.array(IntegrationBindingListItem),
  })
  .strict();
export type IntegrationBindingsResponse = z.infer<typeof IntegrationBindingsResponse>;

// --- Delivery DAG status (in-17 / in-19) -------------------------------------

/** A sealed binding set entry — refs only, never values. */
export const DeliveryRunBindingRef = z
  .object({
    bindingId: z.string().min(1),
    bindingGeneration: z.number().int().positive(),
  })
  .strict();
export type DeliveryRunBindingRef = z.infer<typeof DeliveryRunBindingRef>;

/** The latest attempt of one stage — current state, not the full attempt history. */
export const DeliveryStageCurrentAttemptView = z
  .object({
    stage: DeliveryStageRead,
    ordinal: z.number().int().nonnegative(),
    latestAttempt: z.number().int().positive(),
    latestStatus: DeliveryStageAttemptStatusRead,
    failureClassification: z.string().nullable(),
    startedAt: z.coerce.date().nullable(),
    completedAt: z.coerce.date().nullable(),
  })
  .strict();
export type DeliveryStageCurrentAttemptView = z.infer<typeof DeliveryStageCurrentAttemptView>;

/** One delivery run + its per-stage progress + the sealed binding set (refs only). */
export const DeliveryRunView = z
  .object({
    deliveryRunId: z.string().min(1),
    authorityDecisionId: z.string().min(1),
    mergeSha: z.string().min(1),
    status: DeliveryRunStatusRead,
    retryAfter: z.coerce.date().nullable(),
    failureClassification: z.string().nullable(),
    stages: z.array(DeliveryStageCurrentAttemptView),
    bindings: z.array(DeliveryRunBindingRef),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    completedAt: z.coerce.date().nullable(),
  })
  .strict();
export type DeliveryRunView = z.infer<typeof DeliveryRunView>;

/** GET .../delivery — the project's delivery-DAG status (in-17/19 live state). */
export const DeliveryDagStatusResponse = z
  .object({
    version: z.literal(INTEGRATION_READ_SURFACE_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    deliveryRuns: z.array(DeliveryRunView),
  })
  .strict();
export type DeliveryDagStatusResponse = z.infer<typeof DeliveryDagStatusResponse>;

// --- Compat-guard catalog ----------------------------------------------------
// The five TOP-LEVEL responses the read surface publishes. The integration-read
// -compat guard renders exactly these and pins their JSON-Schema shape; the
// central `engine/schemaExport/catalog.ts` ALSO registers them so the unified
// byte-exact mirror under `contracts/json/integrations/**` stays in lockstep with
// the Zod source. A stable schemaId is embedded so the committed baseline is
// self-describing.
export interface IntegrationReadContractDescriptor {
  readonly name: string;
  readonly schemaId: string;
  readonly zod: ZodType;
}

export const integrationReadContractCatalog: readonly IntegrationReadContractDescriptor[] = [
  {
    name: "IntegrationLifecycleInventoryResponse",
    schemaId: "tanren.integrations.read.v1.IntegrationLifecycleInventoryResponse",
    zod: IntegrationLifecycleInventoryResponse,
  },
  {
    name: "IntegrationRequirementsResponse",
    schemaId: "tanren.integrations.read.v1.IntegrationRequirementsResponse",
    zod: IntegrationRequirementsResponse,
  },
  {
    name: "CapabilityNodesResponse",
    schemaId: "tanren.integrations.read.v1.CapabilityNodesResponse",
    zod: CapabilityNodesResponse,
  },
  {
    name: "IntegrationBindingsResponse",
    schemaId: "tanren.integrations.read.v1.IntegrationBindingsResponse",
    zod: IntegrationBindingsResponse,
  },
  {
    name: "DeliveryDagStatusResponse",
    schemaId: "tanren.integrations.read.v1.DeliveryDagStatusResponse",
    zod: DeliveryDagStatusResponse,
  },
];

/**
 * Render the published read-surface responses to a `{ schemaId -> JSON Schema }`
 * map. This is the SINGLE chokepoint both the integration-read-compat guard
 * script and the compat unit test feed the classifier from, so the "current"
 * shape they compare against the committed baseline is rendered identically.
 * Mirrors `renderVerificationReadSchemas` in routes/runtimeVerification/contract.ts
 * and `renderContractJsonSchema` in engine/schemaExport/catalog.ts
 * (z.coerce.date() → date-time string).
 */
export function renderIntegrationReadSchemas(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const descriptor of integrationReadContractCatalog) {
    out[descriptor.schemaId] = z.toJSONSchema(descriptor.zod, {
      target: "draft-2020-12",
      unrepresentable: "any",
      override: (ctx) => {
        if (ctx.zodSchema instanceof z.ZodDate) {
          ctx.jsonSchema.type = "string";
          ctx.jsonSchema.format = "date-time";
        }
      },
    }) as Record<string, unknown>;
  }
  return out;
}
