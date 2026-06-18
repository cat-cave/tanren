// §3.6 issue-loop hardening — the DURABLE raw-webhook landing store: the
// `webhook_events` (collapsed baseline 0000) member of the `Repositories` seam.
//
// The §1d webhook receiver runs inside GitHub's ~10s delivery window. The OLD
// receiver did runner allocation + a 120s-budget triage call INLINE and
// 202-swallowed any failure, so a transient blip PERMANENTLY lost the intake
// (GitHub, seeing a 2xx, never re-delivers). This store is the persist-then-202
// seam: the receiver writes the VERIFIED raw delivery here and returns 202 FAST;
// a background processor (see `forge/intake/webhookProcessor.ts`) drains `received`/`failed`
// rows OUT of band — re-driven idempotently by the poller's sweeper.
//
// TIMEOUT-ERADICATION (feedback_no_timeouts_progress_based, BINDING): there is NO
// attempt-count dead-letter budget. A TRANSIENT processing failure (an LLM blip, a
// DB wobble) stays `failed` and the sweeper re-drives it UNBOUNDED — a self-healing
// transient is never lost to a count. Only a POISON failure (a genuinely
// non-recoverable delivery — the source vanished, an unsupported mapping, a
// persistently-invalid spec the quality gate cannot make valid) is parked
// `dead_lettered` (a loud, human-visible terminal). `attempts` survives as an
// OBSERVABILITY counter (how many re-drives a row has seen), NOT a give-up trigger.
//
// A seam member like `InboxStore`: pure SQL on the caller's client (the org-scope
// carrier), so under RLS an org-scoped client sees only that org's rows and an
// off-scope client sees zero.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// The status vocabulary as a zod enum so a raw `string` column is VALIDATED
// (fail-loud on an unknown value) at the read seam rather than `as`-asserted past
// it — the trust-at-boundary doctrine the repositories apply to their rows.
const WebhookEventStatus = z.enum(["received", "processed", "failed", "dead_lettered"]);
export type WebhookEventStatus = z.infer<typeof WebhookEventStatus>;

export interface WebhookEvent {
  id: string;
  sourceId: string;
  orgId: string;
  eventType: string;
  deliveryId: string | null;
  payload: unknown;
  status: WebhookEventStatus;
  attempts: number;
  lastError: string | null;
}

interface WebhookEventRow {
  id: string;
  source_id: string;
  org_id: string;
  event_type: string;
  delivery_id: string | null;
  payload: unknown;
  status: string;
  attempts: number | string;
  last_error: string | null;
}

function mapRow(row: WebhookEventRow): WebhookEvent {
  return {
    id: row.id,
    sourceId: row.source_id,
    orgId: row.org_id,
    eventType: row.event_type,
    deliveryId: row.delivery_id,
    payload: row.payload,
    status: WebhookEventStatus.parse(row.status),
    attempts: typeof row.attempts === "string" ? Number.parseInt(row.attempts, 10) : row.attempts,
    lastError: row.last_error,
  };
}

export interface PersistWebhookEventInput {
  sourceId: string;
  orgId: string;
  eventType: string;
  deliveryId: string | null;
  payload: unknown;
}

const RETURN_COLS = `id, source_id, org_id, event_type, delivery_id, payload, status, attempts, last_error`;

export const WebhookEventStore = {
  // Persist a verified raw delivery as `received`. Called from the receiver hot
  // path — one INSERT, no triage. Returns the durable row the processor re-drives.
  async persist(client: QueryClient, input: PersistWebhookEventInput): Promise<WebhookEvent> {
    const id = `whk_${randomUUID()}`;
    const result = await client.query<WebhookEventRow>(
      `INSERT INTO webhook_events (id, source_id, org_id, event_type, delivery_id, payload, status, attempts)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'received', 0)
       RETURNING ${RETURN_COLS}`,
      [id, input.sourceId, input.orgId, input.eventType, input.deliveryId, JSON.stringify(input.payload ?? {})],
    );
    return mapRow(result.rows[0]!);
  },

  // The sweeper read: pull undriven (`received`/`failed`) rows for one org,
  // oldest-first, capped at `limit`. Org-scoped under RLS by the caller's client.
  async listUndriven(client: QueryClient, limit: number): Promise<WebhookEvent[]> {
    const result = await client.query<WebhookEventRow>(
      `SELECT ${RETURN_COLS} FROM webhook_events
       WHERE status IN ('received','failed')
       ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapRow);
  },

  // Mark a row terminally `processed` (success). Idempotent: a re-drive of an
  // already-processed row is a no-op (the WHERE keeps it from un-terminalizing).
  async markProcessed(client: QueryClient, id: string): Promise<void> {
    await client.query(
      `UPDATE webhook_events SET status = 'processed', last_error = NULL, updated_at = now() WHERE id = $1`,
      [id],
    );
  },

  // Record a processing failure: bump the `attempts` OBSERVABILITY counter, capture
  // the error, and set the terminal status by the failure's NATURE — NOT a count. A
  // POISON failure (`poison: true` — a genuinely non-recoverable delivery the caller
  // classified) parks the row `dead_lettered` (loud terminal — the sweeper no longer
  // re-drives it). A TRANSIENT failure (`poison: false`) stays `failed` so the
  // sweeper re-drives it next interval, UNBOUNDED — a self-healing blip is never lost
  // to an attempt cap. Returns the resulting status.
  async recordFailure(client: QueryClient, id: string, error: string, poison: boolean): Promise<WebhookEventStatus> {
    const result = await client.query<{ status: string }>(
      `UPDATE webhook_events
         SET attempts = attempts + 1,
             last_error = $2,
             status = CASE WHEN $3 THEN 'dead_lettered' ELSE 'failed' END,
             updated_at = now()
       WHERE id = $1
       RETURNING status`,
      [id, error.slice(0, 4000), poison],
    );
    return WebhookEventStatus.parse(result.rows[0]?.status ?? "failed");
  },
} as const;
