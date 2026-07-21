// The read-only evidence side of in-22. Seven explicitly org-scoped readers
// expose the durable links that the attester joins; none can use a mutable
// current-binding pointer or an unscoped client.

import { runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import type pg from "pg";
import { parseIntegrationRequirement } from "../../contracts/integrationRequirement.js";

export type EvidenceCoordinate = {
  readonly orgId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly specId: string;
  readonly deliveryRunId: string;
  readonly mergeSha: string;
  readonly deploymentId: string;
};

export type SealedIntegrationCoordinate = {
  readonly requirementId: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly behaviorRevisionId: string;
  readonly grantId: string;
  readonly grantGeneration: number;
  /** Nullable at the attester boundary; a missing value is rejected before sealing. */
  readonly channelTemplateDigest: string | null;
  readonly observer: string;
  readonly provider: string;
};

export type RuntimeAttachment = {
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly deploySha: string;
  readonly attachedAt: Date;
};

export type DeploymentEvidence = {
  readonly deploymentId: string;
  /** The source SHA the verified live deployment says was actually released. */
  readonly verifiedSourceRef: string;
  readonly verifiedAt: Date;
};

export type BehaviorVerdictEvidence = { readonly behaviorVerdictId: string };

export type IndependentObservation = {
  readonly correlationId: string;
  readonly causeOrdinal: number;
  readonly providerReceiptId: string;
  readonly observationId: string;
  readonly observer: string;
  readonly provider: string;
  readonly cursor: string;
  readonly occurrenceCount: number;
  readonly classification: string;
  readonly observedAt: Date;
};

export type GrantEvidence = { readonly status: string; readonly generation: number };

export interface IntegrationEvidenceReaders {
  /** 1. The delivery row and authoritative merge event share one exact merge SHA. */
  readAuthorizedDelivery(input: EvidenceCoordinate): Promise<boolean>;
  /** 2. Release-required requirement → sealed generation → behavior coordinate. */
  readSealedCoordinates(input: EvidenceCoordinate): Promise<readonly SealedIntegrationCoordinate[]>;
  /** 3. Pre-deploy generation attachment rows. */
  readRuntimeAttachments(input: EvidenceCoordinate): Promise<readonly RuntimeAttachment[]>;
  /** 4. The verified live deployment itself resolves to the authorized SHA. */
  readDeployment(input: EvidenceCoordinate): Promise<readonly DeploymentEvidence[]>;
  /** 5. Post-merge passed behavior verdicts. */
  readBehaviorVerdicts(
    input: EvidenceCoordinate,
    behaviorRevisionId: string,
  ): Promise<readonly BehaviorVerdictEvidence[]>;
  /** 6. The one independent provider observation, joined to its immutable row. */
  readIndependentObservations(
    input: EvidenceCoordinate,
    coordinate: SealedIntegrationCoordinate,
  ): Promise<readonly IndependentObservation[]>;
  /** 7. The generation's grant remains active; revoked is a durable redacted refusal. */
  readGrant(input: EvidenceCoordinate, coordinate: SealedIntegrationCoordinate): Promise<GrantEvidence | undefined>;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export class PgIntegrationEvidenceReaders implements IntegrationEvidenceReaders {
  public constructor(private readonly pool: pg.Pool) {}

  public async readAuthorizedDelivery(input: EvidenceCoordinate): Promise<boolean> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT dr.id FROM delivery_runs dr
          WHERE dr.org_id = $1 AND dr.project_id = $2 AND dr.id = $3 AND dr.merge_sha = $4
            AND EXISTS (
              SELECT 1 FROM events e
               WHERE e.org_id = $1 AND e.project_id = $2 AND e.run_id = $5
                 AND e.event_type = 'merge.completed' AND e.payload->>'mergeSha' = $4
            )`,
        [input.orgId, input.projectId, input.deliveryRunId, input.mergeSha, input.runId],
      );
      return result.rows.length === 1;
    });
  }

  public async readSealedCoordinates(input: EvidenceCoordinate): Promise<readonly SealedIntegrationCoordinate[]> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{
        requirement_id: unknown;
        binding_id: unknown;
        binding_generation: unknown;
        behavior_revision_id: unknown;
        grant_id: unknown;
        grant_generation: unknown;
        external_resource_id: unknown;
        desired_state: unknown;
      }>(
        `SELECT r.id AS requirement_id, drb.binding_id, drb.binding_generation, bir.behavior_revision_id,
                generation.grant_id, generation.grant_generation, generation.external_resource_id, r.desired_state
           FROM delivery_run_bindings drb
           JOIN integration_binding_generations generation
             ON generation.org_id = drb.org_id AND generation.project_id = drb.project_id
            AND generation.binding_id = drb.binding_id AND generation.generation = drb.binding_generation
           JOIN integration_requirements r
             ON r.org_id = generation.org_id AND r.project_id = generation.project_id
            AND r.id = generation.requirement_id
           JOIN behavior_integration_requirements bir
             ON bir.org_id = r.org_id AND bir.project_id = r.project_id AND bir.requirement_id = r.id
            AND bir.relation_role = 'requires'
          WHERE drb.org_id = $1 AND drb.project_id = $2 AND drb.delivery_run_id = $3
            AND r.plane = 'product' AND r.status = 'active' AND r.criticality = 'release_required'
          ORDER BY r.id, bir.behavior_revision_id, drb.binding_id, drb.binding_generation`,
        [input.orgId, input.projectId, input.deliveryRunId],
      );
      const coordinates: SealedIntegrationCoordinate[] = [];
      for (const row of result.rows) {
        if (!nonBlank(row.requirement_id) || !nonBlank(row.binding_id) || !positiveInt(row.binding_generation))
          return [];
        if (!nonBlank(row.behavior_revision_id) || !nonBlank(row.grant_id) || !positiveInt(row.grant_generation))
          return [];
        if (!nonBlank(row.external_resource_id)) return [];
        const requirement = parseIntegrationRequirement(row.desired_state);
        if (!requirement.ok || !requirement.requirement.expectedEffect.independent) return [];
        const effect = requirement.requirement.expectedEffect;
        coordinates.push({
          requirementId: row.requirement_id,
          bindingId: row.binding_id,
          bindingGeneration: row.binding_generation,
          behaviorRevisionId: row.behavior_revision_id,
          grantId: row.grant_id,
          grantGeneration: row.grant_generation,
          channelTemplateDigest: digest(`${row.external_resource_id}\u0000${effect.templateDigest ?? ""}`),
          observer: effect.provider,
          provider: effect.provider,
        });
      }
      return coordinates;
    });
  }

  public async readRuntimeAttachments(input: EvidenceCoordinate): Promise<readonly RuntimeAttachment[]> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{
        binding_id: unknown;
        binding_generation: unknown;
        deploy_sha: unknown;
        attached_at: unknown;
      }>(
        `SELECT binding_id, binding_generation, deploy_sha, attached_at FROM integration_runtime_attachments
          WHERE org_id = $1 AND project_id = $2 AND delivery_run_id = $3 ORDER BY binding_id, binding_generation`,
        [input.orgId, input.projectId, input.deliveryRunId],
      );
      return result.rows.flatMap((row) =>
        nonBlank(row.binding_id) &&
        positiveInt(row.binding_generation) &&
        nonBlank(row.deploy_sha) &&
        validDate(row.attached_at)
          ? [
              {
                bindingId: row.binding_id,
                bindingGeneration: row.binding_generation,
                deploySha: row.deploy_sha,
                attachedAt: row.attached_at,
              },
            ]
          : [],
      );
    });
  }

  public async readDeployment(input: EvidenceCoordinate): Promise<readonly DeploymentEvidence[]> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{
        deployment_id: unknown;
        verified_source_ref: unknown;
        verified_at: unknown;
      }>(
        `SELECT verified.payload->>'deploymentId' AS deployment_id,
                verified.payload->>'sourceRef' AS verified_source_ref,
                verified.ts AS verified_at
           FROM events verified
          WHERE verified.org_id = $1 AND verified.project_id = $2 AND verified.run_id = $3
            AND verified.event_type = 'deploy.verified' AND verified.payload->>'deploymentId' = $4
            AND verified.payload->>'sourceRef' = $5`,
        [input.orgId, input.projectId, input.runId, input.deploymentId, input.mergeSha],
      );
      return result.rows.flatMap((row) =>
        row.deployment_id === input.deploymentId &&
        nonBlank(row.verified_source_ref) &&
        row.verified_source_ref === input.mergeSha &&
        validDate(row.verified_at)
          ? [
              {
                deploymentId: input.deploymentId,
                verifiedSourceRef: row.verified_source_ref,
                verifiedAt: row.verified_at,
              },
            ]
          : [],
      );
    });
  }

  public async readBehaviorVerdicts(
    input: EvidenceCoordinate,
    behaviorRevisionId: string,
  ): Promise<readonly BehaviorVerdictEvidence[]> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{ id: unknown }>(
        `SELECT verdict.id FROM behavior_verification_runs run
           JOIN behavior_verdicts verdict
             ON verdict.org_id = run.org_id AND verdict.project_id = run.project_id AND verdict.run_id = run.id
          WHERE run.org_id = $1 AND run.project_id = $2 AND run.run_id = $3
            AND run.purpose = 'post_merge_production' AND run.status = 'completed'
            AND verdict.behavior_revision_id = $4 AND verdict.outcome = 'passed'
          ORDER BY verdict.id`,
        [input.orgId, input.projectId, input.runId, behaviorRevisionId],
      );
      return result.rows.flatMap((row) => (nonBlank(row.id) ? [{ behaviorVerdictId: row.id }] : []));
    });
  }

  public async readIndependentObservations(
    input: EvidenceCoordinate,
    coordinate: SealedIntegrationCoordinate,
  ): Promise<readonly IndependentObservation[]> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{
        payload: unknown;
        observation_id: unknown;
        observer: unknown;
        provider: unknown;
        provider_object_hash: unknown;
        cursor: unknown;
        occurrence_count: unknown;
        classification: unknown;
        created_at: unknown;
      }>(
        `SELECT event.payload, observation.observation_id, observation.observer, observation.provider,
                observation.provider_object_hash, observation.cursor, observation.occurrence_count,
                observation.classification, observation.created_at
           FROM events event
           JOIN behavior_effect_observations observation
             ON observation.org_id = event.org_id AND observation.project_id = event.project_id
            AND observation.trigger_id_hash = event.payload->>'correlationId'
          WHERE event.org_id = $1 AND event.project_id = $2 AND event.run_id = $3
            AND event.event_type = 'behavior.effect.observed'
            AND event.payload->>'behaviorRevisionId' = $4 AND event.payload->>'deliveryRunId' = $5
            AND event.payload->>'shardId' = $6`,
        [
          input.orgId,
          input.projectId,
          input.runId,
          coordinate.behaviorRevisionId,
          input.deliveryRunId,
          `a3:${coordinate.bindingId}:${String(coordinate.bindingGeneration)}`,
        ],
      );
      return result.rows.flatMap((row) => observationFrom(row, coordinate));
    });
  }

  public async readGrant(
    input: EvidenceCoordinate,
    coordinate: SealedIntegrationCoordinate,
  ): Promise<GrantEvidence | undefined> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{ status: unknown; current_generation: unknown }>(
        `SELECT grant.status, grant.current_generation FROM org_integration_grants grant
           JOIN integration_binding_generations generation
             ON generation.org_id = grant.org_id AND generation.connection_id = grant.connection_id
            AND generation.grant_id = grant.id
          WHERE generation.org_id = $1 AND generation.project_id = $2 AND generation.binding_id = $3
            AND generation.generation = $4 AND grant.id = $5`,
        [input.orgId, input.projectId, coordinate.bindingId, coordinate.bindingGeneration, coordinate.grantId],
      );
      const row = result.rows[0];
      return row !== undefined && nonBlank(row.status) && positiveInt(row.current_generation)
        ? { status: row.status, generation: row.current_generation }
        : undefined;
    });
  }
}

function observationFrom(
  row: {
    payload: unknown;
    observation_id: unknown;
    observer: unknown;
    provider: unknown;
    provider_object_hash: unknown;
    cursor: unknown;
    occurrence_count: unknown;
    classification: unknown;
    created_at: unknown;
  },
  coordinate: SealedIntegrationCoordinate,
): readonly IndependentObservation[] {
  const payload = record(row.payload);
  if (!payload || !nonBlank(payload["correlationId"]) || !nonBlank(payload["providerReceiptId"])) return [];
  if (!nonBlank(row.observation_id) || !nonBlank(row.observer) || !nonBlank(row.provider)) return [];
  if (!nonBlank(row.provider_object_hash) || !nonBlank(row.cursor) || !positiveInt(row.occurrence_count)) return [];
  if (!nonBlank(row.classification) || !(row.created_at instanceof Date)) return [];
  if (row.observer !== coordinate.observer || row.provider !== coordinate.provider) return [];
  if (payload["providerReceiptId"] !== row.provider_object_hash || !DIGEST.test(row.provider_object_hash)) return [];
  const causeOrdinal = payload["causeOrdinal"];
  if (!nonnegativeInt(causeOrdinal)) return [];
  return [
    {
      correlationId: payload["correlationId"],
      causeOrdinal,
      providerReceiptId: row.provider_object_hash,
      observationId: row.observation_id,
      observer: row.observer,
      provider: row.provider,
      cursor: row.cursor,
      occurrenceCount: row.occurrence_count,
      classification: row.classification,
      observedAt: row.created_at,
    },
  ];
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonnegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}
