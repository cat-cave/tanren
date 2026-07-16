import type pg from "pg";
import type { InboxSourceAttention } from "../forge/inbox/types.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface InboxSourceIdentity {
  id: string;
  orgId: string;
}

/** Atomic compare-and-set writes for source terminal, retry, and recovery state. */
export const InboxSourceLifecycleStore = {
  async markNeedsAttention(
    client: QueryClient,
    source: InboxSourceIdentity,
    attention: InboxSourceAttention,
    discardInvalidConfig = false,
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE inbox_sources
          SET state = 'needs_attention', enabled = 'false',
              config = CASE WHEN $6 THEN 'null'::jsonb ELSE config END,
              attention_code = $3, attention_message = $4,
              attention_observed_at = $5::timestamptz,
              retry_not_before = NULL, updated_at = now()
        WHERE id = $1 AND org_id = $2 AND state = 'active'
       RETURNING id`,
      [source.id, source.orgId, attention.code, attention.message, attention.observedAt, discardInvalidConfig],
    );
    return result.rowCount === 1;
  },

  async scheduleRetry(client: QueryClient, source: InboxSourceIdentity, retryNotBefore: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE inbox_sources
          SET retry_not_before = GREATEST(COALESCE(retry_not_before, '-infinity'::timestamptz), $3::timestamptz),
              updated_at = now()
        WHERE id = $1 AND org_id = $2 AND state = 'active' AND enabled = 'true'
       RETURNING id`,
      [source.id, source.orgId, retryNotBefore],
    );
    return result.rowCount === 1;
  },

  async recover(client: QueryClient, source: InboxSourceIdentity, expectedObservedAt: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE inbox_sources
          SET state = 'active', enabled = 'true', attention_code = NULL,
              attention_message = NULL, attention_observed_at = NULL,
              retry_not_before = NULL, updated_at = now()
        WHERE id = $1 AND org_id = $2 AND state = 'needs_attention'
          AND attention_observed_at = $3::timestamptz
          AND (project_id IS NULL OR EXISTS (
            SELECT 1 FROM projects p WHERE p.project_id = inbox_sources.project_id AND p.org_id = inbox_sources.org_id
          ))
       RETURNING id`,
      [source.id, source.orgId, expectedObservedAt],
    );
    return result.rowCount === 1;
  },
} as const;
