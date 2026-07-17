import { z } from "zod";

// Mission-complete WAVE-1 integration event vocabulary FREEZE (in-3).
//
// The typed, versioned event names the Integration Lifecycle Engine emits, frozen
// here EXACTLY from the integrations spec's "Typed event vocabulary" list
// (docs/roadmap/mission-complete/nodes/integrations-engine-surfaces-phasing-risks.md
// §3). Downstream consumer nodes (in-3 emitters and the in-9..22 lifecycle nodes)
// build against these frozen names + strict payloads; a barrier pre-flight owns
// the freeze so the consumers touch zero shared vocabulary.
//
// Payload discipline (spec §3): payloads carry IDs, generations, hashes, key
// NAMES, provider receipt IDs, and correlation IDs — NEVER tokens, wrapped
// tokens, provider bodies, or sensitive message text. Every field is therefore
// `public` (see sensitivityRules.integrationVocabulary.ts). Envelope columns
// (org_id / project_id / spec_id / run_id) are stamped by the EventStore and are
// never duplicated in the payload. Enum vocabularies mirror the exact CHECK
// constraints established by migration 0043 (the integration lifecycle schema).

const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const Id = z.string().min(1).max(256);
const ProviderKind = z.string().min(1).max(128);
const KeyName = z.string().min(1).max(256);
const Generation = z.number().int().min(1);
const Attempt = z.number().int().min(0);

const Plane = z.enum(["control", "product"]);
const Direction = z.enum(["inbound", "outbound", "bidirectional"]);
const Criticality = z.enum(["merge_required", "release_required", "best_effort"]);
const Environment = z.enum(["test", "preview", "production"]);
const SourceKind = z.enum(["behavior_revision", "design_contract"]);
const ReconcilePhase = z.enum([
  "discover",
  "authorize",
  "select",
  "provision",
  "bind",
  "observe",
  "materialize",
  "reconcile",
  "teardown",
]);
const Ownership = z.enum(["created", "adopted", "shared"]);

// ---------------------------------------------------------------------------
// integration.requirement.*
// ---------------------------------------------------------------------------

export const IntegrationRequirementDerivedPayload = z
  .object({
    requirementId: Id,
    capability: z.string().min(1).max(128),
    plane: Plane,
    direction: Direction,
    criticality: Criticality,
    sourceKind: SourceKind,
    sourceRevisionId: Id,
    desiredStateHash: Sha256Digest,
  })
  .strict();

export const IntegrationRequirementSupersededPayload = z
  .object({
    requirementId: Id,
    supersededByRequirementId: Id,
  })
  .strict();

// ---------------------------------------------------------------------------
// integration.reconcile.* — durable saga phase transitions.
// ---------------------------------------------------------------------------

const ReconcileBase = z
  .object({
    reconciliationId: Id,
    requirementId: Id,
    phase: ReconcilePhase,
    attempt: Attempt,
  })
  .strict();

export const IntegrationReconcileStartedPayload = ReconcileBase;
export const IntegrationReconcileRetryScheduledPayload = ReconcileBase;
export const IntegrationReconcileFixedPointPayload = ReconcileBase;
export const IntegrationReconcileStateUnknownPayload = ReconcileBase;

// ---------------------------------------------------------------------------
// integration.resource.* — discovery / selection / creation / adoption.
// ---------------------------------------------------------------------------

export const IntegrationResourceDiscoveredPayload = z
  .object({
    requirementId: Id,
    providerKind: ProviderKind,
    resourceCount: z.number().int().min(0),
  })
  .strict();

export const IntegrationResourceSelectedPayload = z
  .object({
    requirementId: Id,
    providerKind: ProviderKind,
    externalResourceId: Id,
  })
  .strict();

export const IntegrationResourceProvisionedPayload = z
  .object({
    requirementId: Id,
    providerKind: ProviderKind,
    externalResourceId: Id,
    ownership: Ownership,
  })
  .strict();

export const IntegrationResourceAdoptedPayload = z
  .object({
    requirementId: Id,
    providerKind: ProviderKind,
    externalResourceId: Id,
  })
  .strict();

// ---------------------------------------------------------------------------
// integration.binding.* — the immutable, proof-bearing binding lifecycle.
// ---------------------------------------------------------------------------

export const IntegrationBindingCommittedPayload = z
  .object({
    bindingId: Id,
    requirementId: Id,
    environment: Environment,
    generation: Generation,
    desiredStateHash: Sha256Digest,
  })
  .strict();

export const IntegrationBindingMaterializedPayload = z
  .object({
    bindingId: Id,
    environment: Environment,
    generation: Generation,
    keys: z.array(KeyName).max(256),
  })
  .strict();

export const IntegrationBindingDriftedPayload = z
  .object({
    bindingId: Id,
    environment: Environment,
    generation: Generation,
    driftState: z.literal("drifted"),
  })
  .strict();

// ---------------------------------------------------------------------------
// integration.grant.* — least-privilege consent lifecycle (no secret values).
// ---------------------------------------------------------------------------

export const IntegrationGrantRequestedPayload = z
  .object({
    requirementId: Id,
    providerKind: ProviderKind,
    plane: Plane,
    environment: Environment,
    capabilities: z.array(z.string().min(1).max(128)).max(128),
    operations: z.array(z.string().min(1).max(128)).max(256),
    scopes: z.array(z.string().min(1).max(128)).max(256),
  })
  .strict();

export const IntegrationGrantLinkedPayload = z
  .object({
    grantId: Id,
    connectionId: Id,
    providerKind: ProviderKind,
    plane: Plane,
    environment: Environment,
  })
  .strict();

export const IntegrationGrantValidatedPayload = z
  .object({
    grantId: Id,
    providerKind: ProviderKind,
    scopes: z.array(z.string().min(1).max(128)).max(256),
  })
  .strict();

export const IntegrationGrantRotatedPayload = z
  .object({
    grantId: Id,
    providerKind: ProviderKind,
    fromGeneration: Generation,
    toGeneration: Generation,
  })
  .strict();

export const IntegrationGrantRevokedPayload = z
  .object({
    grantId: Id,
    providerKind: ProviderKind,
  })
  .strict();

// ---------------------------------------------------------------------------
// integration.runtime.attached — the runtime env generation attached to deploy.
// ---------------------------------------------------------------------------

export const IntegrationRuntimeAttachedPayload = z
  .object({
    bindingId: Id,
    environment: Environment,
    generation: Generation,
    deploymentId: Id,
    keys: z.array(KeyName).max(256),
  })
  .strict();

// ---------------------------------------------------------------------------
// integration.validation.* + stimulus/effect — A3 independent observation.
// ---------------------------------------------------------------------------

export const IntegrationValidationStartedPayload = z
  .object({
    validationId: Id,
    requirementId: Id,
    bindingId: Id,
    generation: Generation,
    correlationId: Id,
  })
  .strict();

export const IntegrationStimulusEmittedPayload = z
  .object({
    validationId: Id,
    correlationId: Id,
    triggerDigest: Sha256Digest,
  })
  .strict();

export const IntegrationEffectObservedPayload = z
  .object({
    validationId: Id,
    correlationId: Id,
    providerReceiptId: Id,
  })
  .strict();

export const IntegrationValidationPassedPayload = z
  .object({
    validationId: Id,
    requirementId: Id,
    bindingId: Id,
    generation: Generation,
    correlationId: Id,
    evidenceDigest: Sha256Digest,
  })
  .strict();

export const IntegrationValidationFailedPayload = z
  .object({
    validationId: Id,
    requirementId: Id,
    bindingId: Id,
    generation: Generation,
    correlationId: Id,
    failureClassification: z.string().min(1).max(200),
  })
  .strict();

// ---------------------------------------------------------------------------
// integration.recovery.enqueued — closed-loop remediation spec enqueue.
// ---------------------------------------------------------------------------

export const IntegrationRecoveryEnqueuedPayload = z
  .object({
    requirementId: Id,
    remediationSpecId: Id,
    reason: z.string().min(1).max(200),
  })
  .strict();

// ---------------------------------------------------------------------------
// integration.teardown.* — ownership-aware destructive lifecycle close.
// ---------------------------------------------------------------------------

export const IntegrationTeardownCompletedPayload = z
  .object({
    bindingId: Id,
    externalResourceId: Id,
    ownership: Ownership,
  })
  .strict();

export const IntegrationTeardownFailedPayload = z
  .object({
    bindingId: Id,
    externalResourceId: Id,
    failureClassification: z.string().min(1).max(200),
  })
  .strict();

export const integrationVocabularyRegistry = {
  "integration.requirement.derived": IntegrationRequirementDerivedPayload,
  "integration.requirement.superseded": IntegrationRequirementSupersededPayload,
  "integration.reconcile.started": IntegrationReconcileStartedPayload,
  "integration.reconcile.retry_scheduled": IntegrationReconcileRetryScheduledPayload,
  "integration.reconcile.fixed_point": IntegrationReconcileFixedPointPayload,
  "integration.reconcile.state_unknown": IntegrationReconcileStateUnknownPayload,
  "integration.resource.discovered": IntegrationResourceDiscoveredPayload,
  "integration.resource.selected": IntegrationResourceSelectedPayload,
  "integration.resource.provisioned": IntegrationResourceProvisionedPayload,
  "integration.resource.adopted": IntegrationResourceAdoptedPayload,
  "integration.binding.committed": IntegrationBindingCommittedPayload,
  "integration.binding.materialized": IntegrationBindingMaterializedPayload,
  "integration.binding.drifted": IntegrationBindingDriftedPayload,
  "integration.grant.requested": IntegrationGrantRequestedPayload,
  "integration.grant.linked": IntegrationGrantLinkedPayload,
  "integration.grant.validated": IntegrationGrantValidatedPayload,
  "integration.grant.rotated": IntegrationGrantRotatedPayload,
  "integration.grant.revoked": IntegrationGrantRevokedPayload,
  "integration.runtime.attached": IntegrationRuntimeAttachedPayload,
  "integration.validation.started": IntegrationValidationStartedPayload,
  "integration.stimulus.emitted": IntegrationStimulusEmittedPayload,
  "integration.effect.observed": IntegrationEffectObservedPayload,
  "integration.validation.passed": IntegrationValidationPassedPayload,
  "integration.validation.failed": IntegrationValidationFailedPayload,
  "integration.recovery.enqueued": IntegrationRecoveryEnqueuedPayload,
  "integration.teardown.completed": IntegrationTeardownCompletedPayload,
  "integration.teardown.failed": IntegrationTeardownFailedPayload,
} as const satisfies Record<string, z.ZodTypeAny>;
