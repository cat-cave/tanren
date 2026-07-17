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
import { createHash, randomUUID } from "node:crypto";
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
  provider: string | null;
  claimOwner: string | null;
  claimExpiresAt: Date | null;
  canonicalPayloadHash: string | null;
  signatureAlgo: string | null;
  signatureKeyVersion: string | null;
  deliverySignedAt: Date | null;
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
  provider?: string | null;
  claim_owner?: string | null;
  claim_expires_at?: Date | string | null;
  canonical_payload_hash?: string | null;
  signature_algo?: string | null;
  signature_key_version?: string | null;
  delivery_signed_at?: Date | string | null;
}

function dateOrNull(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
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
    provider: row.provider ?? null,
    claimOwner: row.claim_owner ?? null,
    claimExpiresAt: dateOrNull(row.claim_expires_at),
    canonicalPayloadHash: row.canonical_payload_hash ?? null,
    signatureAlgo: row.signature_algo ?? null,
    signatureKeyVersion: row.signature_key_version ?? null,
    deliverySignedAt: dateOrNull(row.delivery_signed_at),
  };
}

export interface PersistWebhookEventInput {
  sourceId: string;
  orgId: string;
  eventType: string;
  deliveryId: string | null;
  payload: unknown;
  provider?: string;
  signatureAlgo?: string | null;
  signatureKeyVersion?: string | null;
  deliverySignedAt?: Date | null;
}

export class WebhookEventLineageError extends Error {
  constructor() {
    super("webhook event org does not match an active inbox source");
    this.name = "WebhookEventLineageError";
  }
}

const RETURN_COLS = `id, source_id, org_id, event_type, delivery_id, payload, status, attempts, last_error,
 provider, claim_owner, claim_expires_at, canonical_payload_hash, signature_algo, signature_key_version,
 delivery_signed_at`;

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function canonicalPayloadHash(payload: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex")}`;
}

export interface WebhookClaimInput {
  id: string;
  workerId: string;
  leaseMs: number;
}

export interface PersistWebhookEventResult {
  event: WebhookEvent;
  inserted: boolean;
}

export const WebhookEventStore = {
  // Persist a verified raw delivery as `received`. Called from the receiver hot
  // path — one INSERT, no triage. A provider delivery id is a durable idempotency
  // key: a conflict returns the existing row and never creates a second delivery.
  async persist(client: QueryClient, input: PersistWebhookEventInput): Promise<WebhookEvent> {
    return (await WebhookEventStore.persistWithOutcome(client, input)).event;
  },

  async persistWithOutcome(client: QueryClient, input: PersistWebhookEventInput): Promise<PersistWebhookEventResult> {
    const id = `whk_${randomUUID()}`;
    const provider = input.provider ?? "github";
    const storedPayload = input.payload ?? {};
    const result = await client.query<WebhookEventRow>(
      `INSERT INTO webhook_events
          (id, source_id, org_id, event_type, delivery_id, provider, payload, status, attempts,
           canonical_payload_hash, signature_algo, signature_key_version, delivery_signed_at)
       SELECT $1, s.id, s.org_id, $4, $5, $6, $7::jsonb, 'received', 0, $8, $9, $10, $11
         FROM inbox_sources s
        WHERE s.id = $2 AND s.org_id = $3 AND s.enabled = 'true' AND s.state = 'active'
          AND (s.project_id IS NULL OR EXISTS (
            SELECT 1 FROM projects p WHERE p.project_id = s.project_id AND p.org_id = s.org_id
          ))
       ON CONFLICT DO NOTHING
       RETURNING ${RETURN_COLS}`,
      [
        id,
        input.sourceId,
        input.orgId,
        input.eventType,
        input.deliveryId,
        provider,
        JSON.stringify(storedPayload),
        canonicalPayloadHash(storedPayload),
        input.signatureAlgo ?? null,
        input.signatureKeyVersion ?? null,
        input.deliverySignedAt ?? null,
      ],
    );
    const inserted = result.rows[0];
    if (inserted !== undefined) return { event: mapRow(inserted), inserted: true };

    if (input.deliveryId !== null) {
      const duplicate = await client.query<WebhookEventRow>(
        `SELECT ${RETURN_COLS}
           FROM webhook_events
          WHERE org_id = $1 AND source_id = $2 AND provider = $3 AND delivery_id = $4
          LIMIT 1`,
        [input.orgId, input.sourceId, provider, input.deliveryId],
      );
      const existing = duplicate.rows[0];
      if (existing !== undefined) return { event: mapRow(existing), inserted: false };
    }
    throw new WebhookEventLineageError();
  },

  // The sweeper read: pull undriven (`received`/`failed`) rows for one org,
  // oldest-first, capped at `limit`. Org-scoped under RLS by the caller's client.
  async listUndriven(client: QueryClient, limit: number): Promise<WebhookEvent[]> {
    const result = await client.query<WebhookEventRow>(
      `SELECT ${RETURN_COLS} FROM webhook_events
       WHERE status IN ('received','failed')
         AND (claim_owner IS NULL OR claim_expires_at <= now())
       ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapRow);
  },

  // Claim one processable row with a lease-CAS. PostgreSQL's row lock makes the
  // UPDATE atomic: a live claim fails the WHERE clause for every concurrent loser;
  // only an empty or expired claim can be taken over.
  async claim(client: QueryClient, input: WebhookClaimInput): Promise<WebhookEvent | undefined> {
    if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
      throw new RangeError("webhook claim lease must be a positive finite duration");
    }
    const result = await client.query<WebhookEventRow>(
      `UPDATE webhook_events
          SET claim_owner = $2,
              claim_expires_at = now() + ($3::bigint * interval '1 millisecond'),
              updated_at = now()
        WHERE id = $1
          AND status IN ('received','failed')
          AND (claim_owner IS NULL OR claim_expires_at <= now())
       RETURNING ${RETURN_COLS}`,
      [input.id, input.workerId, input.leaseMs],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  // Mark a row terminally `processed` (success). Idempotent: a re-drive of an
  // already-processed row is a no-op. A worker id, when supplied, prevents a
  // stale worker from completing a claim that another worker reclaimed.
  async complete(client: QueryClient, id: string, workerId?: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE webhook_events
          SET status = 'processed', last_error = NULL, claim_owner = NULL, claim_expires_at = NULL, updated_at = now()
        WHERE id = $1
          AND status IN ('received','failed')
          AND ($2::text IS NULL OR claim_owner = $2)`,
      [id, workerId ?? null],
    );
    return (result.rowCount ?? 0) === 1;
  },

  async markProcessed(client: QueryClient, id: string, workerId?: string): Promise<void> {
    await WebhookEventStore.complete(client, id, workerId);
  },

  // Release only the caller's live claim. The row remains received/failed for a
  // later sweep; no attempt cap is involved.
  async release(client: QueryClient, id: string, workerId: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE webhook_events
          SET claim_owner = NULL, claim_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND claim_owner = $2`,
      [id, workerId],
    );
    return (result.rowCount ?? 0) === 1;
  },

  // Record a processing failure: bump the `attempts` OBSERVABILITY counter, capture
  // the error, and set the terminal status by the failure's NATURE — NOT a count. A
  // POISON failure (`poison: true` — a genuinely non-recoverable delivery the caller
  // classified) parks the row `dead_lettered` (loud terminal — the sweeper no longer
  // re-drives it). A TRANSIENT failure (`poison: false`) stays `failed` so the
  // sweeper re-drives it next interval, UNBOUNDED — a self-healing blip is never lost
  // to an attempt cap. Returns the resulting status.
  async recordFailure(
    client: QueryClient,
    id: string,
    error: string,
    poison: boolean,
    workerId?: string,
  ): Promise<WebhookEventStatus> {
    const result = await client.query<{ status: string }>(
      `UPDATE webhook_events
         SET attempts = attempts + 1,
             last_error = $2,
             status = CASE WHEN $3 THEN 'dead_lettered' ELSE 'failed' END,
             claim_owner = NULL,
             claim_expires_at = NULL,
             updated_at = now()
       WHERE id = $1 AND ($4::text IS NULL OR claim_owner = $4)
       RETURNING status`,
      [id, error.slice(0, 4000), poison, workerId ?? null],
    );
    return WebhookEventStatus.parse(result.rows[0]?.status ?? "failed");
  },
} as const;
