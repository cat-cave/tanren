import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, projects, specs } from "./schemaCore.js";
import { integrationBindingGenerations, integrationBindings } from "./schemaIntegrationBindings.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { integrationRequirements } from "./schemaIntegrationRequirements.js";
import {
  authorityDecisionsReference,
  behaviorRevisionsReference,
  behaviorVerdictsReference,
  casArtifactsReference,
  proofUnitsReference,
} from "./schemaSpineReferences.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

export const integrationReconciliations = pgTable(
  "integration_reconciliations",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    requirementId: text("requirement_id").notNull(),
    bindingId: text("binding_id"),
    bindingGeneration: integer("binding_generation"),
    phase: text("phase").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    claimOwner: text("claim_owner"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    progressSignature: text("progress_signature"),
    retryAfter: timestamp("retry_after", { withTimezone: true }),
    failureClassification: text("failure_classification"),
    compensationState: jsonb("compensation_state")
      .notNull()
      .default(sql`'{}'::jsonb`),
    observedState: jsonb("observed_state")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "integration_reconciliations_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.requirementId],
      foreignColumns: [integrationRequirements.orgId, integrationRequirements.projectId, integrationRequirements.id],
      name: "integration_reconciliations_requirement_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.bindingId, table.bindingGeneration],
      foreignColumns: [
        integrationBindingGenerations.orgId,
        integrationBindingGenerations.bindingId,
        integrationBindingGenerations.generation,
      ],
      name: "integration_reconciliations_binding_generation_fk",
    }),
    uniqueIndex("integration_reconciliations_idempotency_unique").on(table.orgId, table.idempotencyKey),
    index("integration_reconciliations_org_id").on(table.orgId),
    index("integration_reconciliations_claimable").on(table.orgId, table.status, table.retryAfter, table.id),
    check(
      "integration_reconciliations_phase_check",
      sql`${table.phase} IN ('discover','authorize','select','provision','bind','observe','materialize','reconcile','teardown')`,
    ),
    check("integration_reconciliations_request_fingerprint_check", sql`${table.requestFingerprint} ~ ${digestPattern}`),
    check(
      "integration_reconciliations_progress_signature_check",
      sql`${table.progressSignature} IS NULL OR ${table.progressSignature} ~ ${digestPattern}`,
    ),
    check(
      "integration_reconciliations_binding_generation_check",
      sql`(${table.bindingId} IS NULL AND ${table.bindingGeneration} IS NULL) OR (${table.bindingId} IS NOT NULL AND ${table.bindingGeneration} >= 1)`,
    ),
    check(
      "integration_reconciliations_claim_check",
      sql`(${table.claimOwner} IS NULL AND ${table.claimExpiresAt} IS NULL) OR (${table.claimOwner} IS NOT NULL AND ${table.claimExpiresAt} IS NOT NULL)`,
    ),
    check(
      "integration_reconciliations_status_check",
      sql`${table.status} IN ('pending','claimed','retry_scheduled','succeeded','fixed_point','state_unknown','needs_attention')`,
    ),
    check("integration_reconciliations_attempt_check", sql`${table.attempt} >= 0`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const integrationResourceSnapshots = pgTable(
  "integration_resource_snapshots",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    requirementId: text("requirement_id").notNull(),
    bindingId: text("binding_id"),
    bindingGeneration: integer("binding_generation"),
    providerKind: text("provider_kind").notNull(),
    externalResourceId: text("external_resource_id").notNull(),
    providerCursor: text("provider_cursor"),
    providerEtag: text("provider_etag"),
    observedStateHash: text("observed_state_hash").notNull(),
    sanitizedSnapshot: jsonb("sanitized_snapshot").notNull(),
    health: text("health").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "integration_resource_snapshots_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.requirementId],
      foreignColumns: [integrationRequirements.orgId, integrationRequirements.projectId, integrationRequirements.id],
      name: "integration_resource_snapshots_requirement_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.bindingId, table.bindingGeneration],
      foreignColumns: [
        integrationBindingGenerations.orgId,
        integrationBindingGenerations.bindingId,
        integrationBindingGenerations.generation,
      ],
      name: "integration_resource_snapshots_binding_generation_fk",
    }),
    uniqueIndex("integration_resource_snapshots_observation_unique").on(
      table.orgId,
      table.providerKind,
      table.externalResourceId,
      table.observedStateHash,
    ),
    index("integration_resource_snapshots_org_id").on(table.orgId),
    index("integration_resource_snapshots_org_requirement").on(table.orgId, table.requirementId),
    check("integration_resource_snapshots_hash_check", sql`${table.observedStateHash} ~ ${digestPattern}`),
    check(
      "integration_resource_snapshots_binding_generation_check",
      sql`(${table.bindingId} IS NULL AND ${table.bindingGeneration} IS NULL) OR (${table.bindingId} IS NOT NULL AND ${table.bindingGeneration} >= 1)`,
    ),
    check(
      "integration_resource_snapshots_health_check",
      sql`${table.health} IN ('unknown','healthy','degraded','missing')`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const deliveryRuns = pgTable(
  "delivery_runs",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    authorityDecisionId: text("authority_decision_id").notNull(),
    mergeSha: text("merge_sha").notNull(),
    status: text("status").notNull().default("pending"),
    claimOwner: text("claim_owner"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    retryAfter: timestamp("retry_after", { withTimezone: true }),
    failureClassification: text("failure_classification"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "delivery_runs_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.authorityDecisionId],
      foreignColumns: [authorityDecisionsReference.orgId, authorityDecisionsReference.id],
      name: "delivery_runs_authority_decision_fk",
    }),
    uniqueIndex("delivery_runs_project_id_unique").on(table.orgId, table.projectId, table.id),
    uniqueIndex("delivery_runs_authority_decision_unique").on(table.orgId, table.authorityDecisionId),
    index("delivery_runs_org_id").on(table.orgId),
    index("delivery_runs_claimable").on(table.orgId, table.status, table.retryAfter, table.id),
    check(
      "delivery_runs_status_check",
      sql`${table.status} IN ('pending','claimed','running','completed','degraded','needs_attention')`,
    ),
    check(
      "delivery_runs_claim_check",
      sql`(${table.claimOwner} IS NULL AND ${table.claimExpiresAt} IS NULL) OR (${table.claimOwner} IS NOT NULL AND ${table.claimExpiresAt} IS NOT NULL)`,
    ),
    check(
      "delivery_runs_completed_check",
      sql`(${table.status} = 'completed' AND ${table.completedAt} IS NOT NULL) OR (${table.status} <> 'completed' AND ${table.completedAt} IS NULL)`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

/** Exact binding-generation membership of a delivery run — replaces JSON authority. */
export const deliveryRunBindings = pgTable(
  "delivery_run_bindings",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    deliveryRunId: text("delivery_run_id").notNull(),
    bindingId: text("binding_id").notNull(),
    bindingGeneration: integer("binding_generation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.deliveryRunId, table.bindingId, table.bindingGeneration] }),
    uniqueIndex("delivery_run_bindings_set_unique").on(
      table.orgId,
      table.projectId,
      table.deliveryRunId,
      table.bindingId,
      table.bindingGeneration,
    ),
    foreignKey({
      columns: [table.orgId, table.projectId, table.deliveryRunId],
      foreignColumns: [deliveryRuns.orgId, deliveryRuns.projectId, deliveryRuns.id],
      name: "delivery_run_bindings_run_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.bindingId, table.bindingGeneration],
      foreignColumns: [
        integrationBindingGenerations.orgId,
        integrationBindingGenerations.bindingId,
        integrationBindingGenerations.generation,
      ],
      name: "delivery_run_bindings_binding_generation_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.bindingId],
      foreignColumns: [integrationBindings.orgId, integrationBindings.id],
      name: "delivery_run_bindings_binding_fk",
    }),
    index("delivery_run_bindings_org_id").on(table.orgId),
    check("delivery_run_bindings_generation_check", sql`${table.bindingGeneration} >= 1`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const deliveryStageAttempts = pgTable(
  "delivery_stage_attempts",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    deliveryRunId: text("delivery_run_id").notNull(),
    stage: text("stage").notNull(),
    ordinal: integer("ordinal").notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(),
    claimOwner: text("claim_owner"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    failureClassification: text("failure_classification"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.deliveryRunId],
      foreignColumns: [deliveryRuns.orgId, deliveryRuns.id],
      name: "delivery_stage_attempts_run_fk",
    }),
    uniqueIndex("delivery_stage_attempts_stage_attempt_unique").on(
      table.orgId,
      table.deliveryRunId,
      table.stage,
      table.attempt,
    ),
    index("delivery_stage_attempts_org_id").on(table.orgId),
    index("delivery_stage_attempts_org_run").on(table.orgId, table.deliveryRunId, table.ordinal),
    check(
      "delivery_stage_attempts_stage_check",
      sql`${table.stage} IN ('reconcile_binding','mint_lease','materialize_env','attach_runtime','deploy','verify_deploy','stimulate','observe','record_evidence')`,
    ),
    check(
      "delivery_stage_attempts_status_check",
      sql`${table.status} IN ('pending','claimed','running','succeeded','retry_scheduled','failed')`,
    ),
    check("delivery_stage_attempts_ordinal_check", sql`${table.ordinal} >= 0`),
    check("delivery_stage_attempts_attempt_check", sql`${table.attempt} >= 1`),
    check(
      "delivery_stage_attempts_claim_check",
      sql`(${table.claimOwner} IS NULL AND ${table.claimExpiresAt} IS NULL) OR (${table.claimOwner} IS NOT NULL AND ${table.claimExpiresAt} IS NOT NULL)`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

export const integrationValidationProofs = pgTable(
  "integration_validation_proofs",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    id: text("id").notNull(),
    projectId: text("project_id").notNull(),
    specId: text("spec_id").notNull(),
    behaviorRevisionId: text("behavior_revision_id").notNull(),
    behaviorVerdictId: text("behavior_verdict_id").notNull(),
    proofUnitDigest: text("proof_unit_digest").notNull(),
    requirementId: text("requirement_id").notNull(),
    bindingId: text("binding_id").notNull(),
    bindingGeneration: integer("binding_generation").notNull(),
    deliveryRunId: text("delivery_run_id").notNull(),
    deploymentId: text("deployment_id").notNull(),
    deploySha: text("deploy_sha").notNull(),
    probeVersion: text("probe_version").notNull(),
    correlationId: text("correlation_id").notNull(),
    triggerDigest: text("trigger_digest").notNull(),
    sanitizedObservation: jsonb("sanitized_observation").notNull(),
    providerReceiptId: text("provider_receipt_id").notNull(),
    providerReceiptAt: timestamp("provider_receipt_at", { withTimezone: true }).notNull(),
    verdict: text("verdict").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    signature: text("signature").notNull(),
    freshUntil: timestamp("fresh_until", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "integration_validation_proofs_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.specId],
      foreignColumns: [specs.orgId, specs.specId],
      name: "integration_validation_proofs_spec_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.behaviorRevisionId],
      foreignColumns: [behaviorRevisionsReference.orgId, behaviorRevisionsReference.id],
      name: "integration_validation_proofs_behavior_revision_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.behaviorVerdictId],
      foreignColumns: [behaviorVerdictsReference.orgId, behaviorVerdictsReference.id],
      name: "integration_validation_proofs_behavior_verdict_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.proofUnitDigest],
      foreignColumns: [proofUnitsReference.orgId, proofUnitsReference.proofUnitDigest],
      name: "integration_validation_proofs_proof_unit_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.requirementId],
      foreignColumns: [integrationRequirements.orgId, integrationRequirements.projectId, integrationRequirements.id],
      name: "integration_validation_proofs_requirement_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.bindingId, table.bindingGeneration],
      foreignColumns: [
        integrationBindingGenerations.orgId,
        integrationBindingGenerations.bindingId,
        integrationBindingGenerations.generation,
      ],
      name: "integration_validation_proofs_binding_generation_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.deliveryRunId, table.bindingId, table.bindingGeneration],
      foreignColumns: [
        deliveryRunBindings.orgId,
        deliveryRunBindings.projectId,
        deliveryRunBindings.deliveryRunId,
        deliveryRunBindings.bindingId,
        deliveryRunBindings.bindingGeneration,
      ],
      name: "integration_validation_proofs_delivery_binding_set_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.evidenceDigest],
      foreignColumns: [casArtifactsReference.orgId, casArtifactsReference.digest],
      name: "integration_validation_proofs_evidence_cas_fk",
    }),
    uniqueIndex("integration_validation_proofs_reuse_unique").on(
      table.orgId,
      table.behaviorRevisionId,
      table.bindingId,
      table.bindingGeneration,
      table.deploySha,
      table.probeVersion,
      table.correlationId,
    ),
    index("integration_validation_proofs_org_id").on(table.orgId),
    index("integration_validation_proofs_org_project").on(table.orgId, table.projectId, table.createdAt),
    check("integration_validation_proofs_binding_generation_check", sql`${table.bindingGeneration} >= 1`),
    check("integration_validation_proofs_trigger_digest_check", sql`${table.triggerDigest} ~ ${digestPattern}`),
    check("integration_validation_proofs_evidence_digest_check", sql`${table.evidenceDigest} ~ ${digestPattern}`),
    check("integration_validation_proofs_verdict_check", sql`${table.verdict} IN ('passed','failed','degraded')`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
