/**
 * in-14: SQL persistence for the BindingMaterializer. Writes the immutable
 * `integration_binding_generations` row, the exact-generation
 * `integration_binding_env` output shape, and advances the stable
 * `integration_bindings` current-generation pointer. Every statement runs on the
 * caller-provided org-scoped client (RLS gates the tenant rows) and inside the
 * caller's transaction, so a partial materialization never persists.
 *
 * The provisioned `project_app_env` rows are written by the materializer via the
 * existing `AppEnvironmentStore.upsert` (the FK requires the matching
 * `integration_binding_env` row to already exist — this module writes that first).
 */

import { z } from "zod";
import type { IntegrationQueryClient } from "../repositories/integrationQuery.js";

export type BindingEnvironment = "test" | "preview" | "production";
export type BindingOwnership = "created" | "adopted" | "shared";
export type BindingTeardownPolicy = "delete" | "retain";

/** The immutable generation payload persisted for one materialization. */
export interface BindingGenerationRecord {
  readonly orgId: string;
  readonly projectId: string;
  readonly requirementId: string;
  readonly environment: BindingEnvironment;
  readonly bindingId: string;
  readonly generation: number;
  readonly providerKind: string;
  readonly connectionId: string;
  readonly authGeneration: number;
  readonly grantId: string;
  readonly grantGeneration: number;
  readonly adapterVersion: string;
  readonly externalResourceId: string;
  readonly externalResourceName: string;
  readonly ownership: BindingOwnership;
  readonly teardownPolicy: BindingTeardownPolicy;
  readonly desiredStateHash: string;
  readonly status: "pending" | "ready";
}

/** One row of the exact-generation output shape (never a value). */
export interface BindingEnvRecord {
  readonly key: string;
  readonly classification: "secret" | "non_secret";
  readonly required: boolean;
  readonly scopes: readonly string[];
}

const CurrentGenerationRow = z.object({
  current_generation: z.coerce.number().int().positive(),
  desired_state_hash: z.string(),
});

const MaxGenerationRow = z.object({ max_generation: z.coerce.number().int().nonnegative().nullable() });

export const BindingMaterializerStore = {
  /**
   * Ensure the stable `integration_bindings` row exists so the generation FK is
   * satisfiable. Create-if-absent only — the current-generation pointer and
   * status are advanced in {@link advanceBindingCurrentGeneration} after the
   * generation lands. A pre-existing row (different lineage) is left untouched.
   */
  async ensureBindingRow(client: IntegrationQueryClient, record: BindingGenerationRecord): Promise<void> {
    await client.query(
      `INSERT INTO integration_bindings
         (org_id, id, project_id, requirement_id, environment, provider_kind,
          connection_id, current_generation, status, drift_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'pending', 'unknown')
       ON CONFLICT (org_id, id) DO NOTHING`,
      [
        record.orgId,
        record.bindingId,
        record.projectId,
        record.requirementId,
        record.environment,
        record.providerKind,
        record.connectionId,
      ],
    );
  },

  /**
   * The stable binding's current generation and that generation's content hash,
   * or `undefined` when the binding has no materialized generation yet. Drives
   * idempotency: a re-materialize whose computed hash equals this one is a no-op.
   */
  async loadCurrentGeneration(
    client: IntegrationQueryClient,
    orgId: string,
    projectId: string,
    bindingId: string,
  ): Promise<{ generation: number; desiredStateHash: string } | undefined> {
    const result = await client.query(
      `SELECT b.current_generation, g.desired_state_hash
         FROM integration_bindings b
         JOIN integration_binding_generations g
           ON g.org_id = b.org_id AND g.project_id = b.project_id
          AND g.binding_id = b.id AND g.generation = b.current_generation
        WHERE b.org_id = $1 AND b.project_id = $2 AND b.id = $3
          AND b.current_generation IS NOT NULL`,
      [orgId, projectId, bindingId],
    );
    const raw = result.rows[0];
    if (raw === undefined) return undefined;
    const row = CurrentGenerationRow.parse(raw);
    return { generation: row.current_generation, desiredStateHash: row.desired_state_hash };
  },

  /** The highest generation number ever minted for this binding (0 when none). */
  async maxGeneration(
    client: IntegrationQueryClient,
    orgId: string,
    projectId: string,
    bindingId: string,
  ): Promise<number> {
    const result = await client.query(
      `SELECT max(generation) AS max_generation
         FROM integration_binding_generations
        WHERE org_id = $1 AND project_id = $2 AND binding_id = $3`,
      [orgId, projectId, bindingId],
    );
    const row = MaxGenerationRow.parse(result.rows[0] ?? { max_generation: null });
    return row.max_generation ?? 0;
  },

  /** Insert the immutable generation payload. */
  async insertGeneration(client: IntegrationQueryClient, record: BindingGenerationRecord): Promise<void> {
    await client.query(
      `INSERT INTO integration_binding_generations
         (org_id, project_id, requirement_id, environment, binding_id, generation,
          provider_kind, connection_id, auth_generation, grant_id, grant_generation,
          adapter_version, external_resource_id, external_resource_name, ownership,
          teardown_policy, desired_state_hash, status, drift_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, 'unknown')`,
      [
        record.orgId,
        record.projectId,
        record.requirementId,
        record.environment,
        record.bindingId,
        record.generation,
        record.providerKind,
        record.connectionId,
        record.authGeneration,
        record.grantId,
        record.grantGeneration,
        record.adapterVersion,
        record.externalResourceId,
        record.externalResourceName,
        record.ownership,
        record.teardownPolicy,
        record.desiredStateHash,
        record.status,
      ],
    );
  },

  /** Insert one exact-generation output-shape row. */
  async insertBindingEnv(
    client: IntegrationQueryClient,
    coords: { orgId: string; projectId: string; bindingId: string; generation: number },
    output: BindingEnvRecord,
  ): Promise<void> {
    await client.query(
      `INSERT INTO integration_binding_env
         (org_id, project_id, binding_id, binding_generation, key, classification,
          required, scopes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[])`,
      [
        coords.orgId,
        coords.projectId,
        coords.bindingId,
        coords.generation,
        output.key,
        output.classification,
        output.required ? 1 : 0,
        output.scopes,
      ],
    );
  },

  /**
   * Advance the stable binding to the freshly-minted generation and mark it
   * ready. A materialized binding always has a real external resource (the
   * generation's `ready` status check guarantees it), so this is the point the
   * binding becomes live.
   */
  async advanceBindingCurrentGeneration(
    client: IntegrationQueryClient,
    orgId: string,
    bindingId: string,
    generation: number,
  ): Promise<void> {
    await client.query(
      `UPDATE integration_bindings
          SET current_generation = $3, status = 'ready', drift_state = 'in_sync',
              updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [orgId, bindingId, generation],
    );
  },
} as const;
