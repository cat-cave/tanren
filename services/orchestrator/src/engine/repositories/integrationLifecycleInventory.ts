import type pg from "pg";
import { z } from "zod";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

const Count = z.coerce.number().int().nonnegative();

export interface IntegrationLifecycleInventory {
  projectId: string;
  requirements: { total: number; needsAttention: number };
  capabilityNodes: { total: number; awaitingGrant: number; ready: number; needsAttention: number };
  bindings: { total: number; ready: number; drifted: number; needsAttention: number };
  deliveries: { total: number; completed: number; degraded: number; needsAttention: number };
}

interface InventoryRow {
  project_id: string;
  requirement_total: unknown;
  requirement_needs_attention: unknown;
  capability_total: unknown;
  capability_awaiting_grant: unknown;
  capability_ready: unknown;
  capability_needs_attention: unknown;
  binding_total: unknown;
  binding_ready: unknown;
  binding_drifted: unknown;
  binding_needs_attention: unknown;
  delivery_total: unknown;
  delivery_completed: unknown;
  delivery_degraded: unknown;
  delivery_needs_attention: unknown;
}

function count(value: unknown): number {
  return Count.parse(value);
}

export const IntegrationLifecycleInventoryStore = {
  async getForProject(
    client: QueryClient,
    orgId: string,
    projectId: string,
    _actor: ActorRef,
  ): Promise<IntegrationLifecycleInventory | undefined> {
    const result = await client.query<InventoryRow>(
      `SELECT p.project_id,
         (SELECT count(*) FROM integration_requirements r
          WHERE r.org_id = p.org_id AND r.project_id = p.project_id) AS requirement_total,
         (SELECT count(*) FROM integration_requirements r
          WHERE r.org_id = p.org_id AND r.project_id = p.project_id
            AND r.status = 'needs_attention') AS requirement_needs_attention,
         (SELECT count(*) FROM capability_nodes n
          WHERE n.org_id = p.org_id AND n.project_id = p.project_id) AS capability_total,
         (SELECT count(*) FROM capability_nodes n
          WHERE n.org_id = p.org_id AND n.project_id = p.project_id
            AND n.status = 'awaiting_grant') AS capability_awaiting_grant,
         (SELECT count(*) FROM capability_nodes n
          WHERE n.org_id = p.org_id AND n.project_id = p.project_id
            AND n.status = 'ready') AS capability_ready,
         (SELECT count(*) FROM capability_nodes n
          WHERE n.org_id = p.org_id AND n.project_id = p.project_id
            AND n.status = 'needs_attention') AS capability_needs_attention,
         (SELECT count(*) FROM integration_bindings b
          WHERE b.org_id = p.org_id AND b.project_id = p.project_id) AS binding_total,
         (SELECT count(*) FROM integration_bindings b
          WHERE b.org_id = p.org_id AND b.project_id = p.project_id
            AND b.status = 'ready') AS binding_ready,
         (SELECT count(*) FROM integration_bindings b
          WHERE b.org_id = p.org_id AND b.project_id = p.project_id
            AND b.status = 'drifted') AS binding_drifted,
         (SELECT count(*) FROM integration_bindings b
          WHERE b.org_id = p.org_id AND b.project_id = p.project_id
            AND b.status = 'needs_attention') AS binding_needs_attention,
         (SELECT count(*) FROM delivery_runs d
          WHERE d.org_id = p.org_id AND d.project_id = p.project_id) AS delivery_total,
         (SELECT count(*) FROM delivery_runs d
          WHERE d.org_id = p.org_id AND d.project_id = p.project_id
            AND d.status = 'completed') AS delivery_completed,
         (SELECT count(*) FROM delivery_runs d
          WHERE d.org_id = p.org_id AND d.project_id = p.project_id
            AND d.status = 'degraded') AS delivery_degraded,
         (SELECT count(*) FROM delivery_runs d
          WHERE d.org_id = p.org_id AND d.project_id = p.project_id
            AND d.status = 'needs_attention') AS delivery_needs_attention
       FROM projects p
       WHERE p.org_id = $1 AND p.project_id = $2`,
      [orgId, projectId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      projectId: row.project_id,
      requirements: {
        total: count(row.requirement_total),
        needsAttention: count(row.requirement_needs_attention),
      },
      capabilityNodes: {
        total: count(row.capability_total),
        awaitingGrant: count(row.capability_awaiting_grant),
        ready: count(row.capability_ready),
        needsAttention: count(row.capability_needs_attention),
      },
      bindings: {
        total: count(row.binding_total),
        ready: count(row.binding_ready),
        drifted: count(row.binding_drifted),
        needsAttention: count(row.binding_needs_attention),
      },
      deliveries: {
        total: count(row.delivery_total),
        completed: count(row.delivery_completed),
        degraded: count(row.delivery_degraded),
        needsAttention: count(row.delivery_needs_attention),
      },
    };
  },
} as const;
