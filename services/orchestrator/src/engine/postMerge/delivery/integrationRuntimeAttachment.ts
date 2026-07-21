// Durable, pre-deploy attachment evidence for the exact production integration
// generations sealed by the delivery DAG. This is NOT another probe: it makes
// in-19's existing binding seal byte-resolvable to the authorized merge SHA.

import { runWithJobOrgId, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { EventStore } from "../../eventStore.js";
import type { DeliveryLineage } from "./stageModel.js";

export interface IntegrationRuntimeAttachmentRecorder {
  record(input: {
    readonly lineage: DeliveryLineage;
    readonly deliveryRunId: string;
    readonly token: string;
  }): Promise<void>;
}

/**
 * Writes the immutable attachment rows while the live delivery claim is held,
 * then emits their idempotent public event. A missing claim or malformed merge
 * coordinate throws loudly; the delivery stage subsequently degrades instead
 * of letting a deployment proceed with an unresolvable binding chain.
 */
export class PgIntegrationRuntimeAttachmentRecorder implements IntegrationRuntimeAttachmentRecorder {
  public constructor(
    private readonly pool: pg.Pool,
    private readonly events: EventStore,
  ) {}

  public async record(input: {
    readonly lineage: DeliveryLineage;
    readonly deliveryRunId: string;
    readonly token: string;
  }): Promise<void> {
    if (!/^[0-9a-f]{40}$/iu.test(input.lineage.mergeSha)) {
      throw new Error("integration runtime attachment requires a 40-character authorized merge SHA");
    }
    const attachments = await runWithOrgScope(this.pool, input.lineage.orgId, async (client) => {
      const result = await client.query<{
        binding_id: string;
        binding_generation: number;
        keys: string[];
      }>(
        `INSERT INTO integration_runtime_attachments
           (org_id, project_id, delivery_run_id, binding_id, binding_generation, deploy_sha)
         SELECT $1, $2, $3, drb.binding_id, drb.binding_generation, $4
           FROM delivery_run_bindings drb
          WHERE drb.org_id = $1 AND drb.project_id = $2 AND drb.delivery_run_id = $3
            AND EXISTS (
              SELECT 1 FROM delivery_runs dr
               WHERE dr.org_id = $1 AND dr.id = $3 AND dr.claim_owner = $5 AND dr.status = 'running'
            )
         ON CONFLICT (org_id, delivery_run_id, binding_id, binding_generation) DO NOTHING`,
        [input.lineage.orgId, input.lineage.projectId, input.deliveryRunId, input.lineage.mergeSha, input.token],
      );
      if ((result.rowCount ?? 0) === 0) {
        const claim = await client.query<{ id: string }>(
          `SELECT id FROM delivery_runs
            WHERE org_id = $1 AND id = $2 AND claim_owner = $3 AND status = 'running'`,
          [input.lineage.orgId, input.deliveryRunId, input.token],
        );
        if (claim.rows[0] === undefined) throw new Error("delivery claim was lost before integration attachment");
      }
      const rows = await client.query<{
        binding_id: string;
        binding_generation: number;
        keys: string[];
      }>(
        `SELECT attachment.binding_id, attachment.binding_generation,
                ARRAY(
                  SELECT env.key FROM integration_binding_env env
                   WHERE env.org_id = attachment.org_id AND env.project_id = attachment.project_id
                     AND env.binding_id = attachment.binding_id
                     AND env.binding_generation = attachment.binding_generation
                   ORDER BY env.key
                ) AS keys
           FROM integration_runtime_attachments attachment
          WHERE attachment.org_id = $1 AND attachment.project_id = $2 AND attachment.delivery_run_id = $3
            AND attachment.deploy_sha = $4
          ORDER BY attachment.binding_id, attachment.binding_generation`,
        [input.lineage.orgId, input.lineage.projectId, input.deliveryRunId, input.lineage.mergeSha],
      );
      return rows.rows.map((row) => ({
        bindingId: row.binding_id,
        bindingGeneration: row.binding_generation,
        keys: row.keys,
      }));
    });
    if (attachments.length === 0) return;
    const append = this.events.appendPriorIfAbsent;
    if (append === undefined) throw new Error("integration runtime attachment requires an idempotent event store");
    for (const attachment of attachments) {
      await runWithJobOrgId(input.lineage.orgId, () =>
        append({
          runId: input.lineage.runId,
          specId: input.lineage.specId,
          projectId: input.lineage.projectId,
          orgId: input.lineage.orgId,
          eventType: "integration.runtime.attached",
          idempotencyKey: `integration.runtime.attached:${input.deliveryRunId}:${attachment.bindingId}:${attachment.bindingGeneration}`,
          payload: {
            bindingId: attachment.bindingId,
            environment: "production",
            generation: attachment.bindingGeneration,
            deliveryRunId: input.deliveryRunId,
            deploySha: input.lineage.mergeSha,
            keys: [...attachment.keys],
          },
        }),
      );
    }
  }
}
