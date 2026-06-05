import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  type NotificationRouteCreateInput,
  type NotificationRouteRow,
  type NotificationTargetCreateInput,
  type NotificationTargetRow,
  NotificationRouteCreateInput as NotificationRouteCreateInputSchema,
  NotificationRouteRow as NotificationRouteRowSchema,
  NotificationTargetCreateInput as NotificationTargetCreateInputSchema,
  NotificationTargetRow as NotificationTargetRowSchema,
} from "./schemas.js";

// repository layer for `notification_targets` and
// `notification_routes`, plus the dispatch log writer for the existing
// `notifications` table (now repurposed as a dispatch ledger — see
// docs/operator-guide/notifications.md).

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

interface RawTargetRow {
  id: unknown;
  org_id: unknown;
  scope: unknown;
  user_id: unknown;
  channel_kind: unknown;
  destination: unknown;
  label: unknown;
  enabled: unknown;
  weekend_mute: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface RawRouteRow {
  id: unknown;
  target_id: unknown;
  event_name: unknown;
  enabled: unknown;
  min_severity: unknown;
  created_at: unknown;
  updated_at: unknown;
}

const TARGET_COLUMNS = `
  id, org_id, scope, user_id, channel_kind, destination, label,
  enabled, weekend_mute, created_at, updated_at
`;

const ROUTE_COLUMNS = `
  id, target_id, event_name, enabled, min_severity, created_at, updated_at
`;

function decodeTargetRow(raw: RawTargetRow): NotificationTargetRow {
  return NotificationTargetRowSchema.parse({
    id: raw.id,
    orgId: raw.org_id,
    scope: raw.scope,
    userId: raw.user_id,
    channelKind: raw.channel_kind,
    destination: raw.destination,
    label: raw.label,
    enabled: raw.enabled === 1 || raw.enabled === true,
    weekendMute: raw.weekend_mute === 1 || raw.weekend_mute === true,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  });
}

function decodeRouteRow(raw: RawRouteRow): NotificationRouteRow {
  return NotificationRouteRowSchema.parse({
    id: raw.id,
    targetId: raw.target_id,
    eventName: raw.event_name,
    enabled: raw.enabled === 1 || raw.enabled === true,
    minSeverity: raw.min_severity,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  });
}

export const NotificationTargetStore = {
  async create(client: QueryClient, input: NotificationTargetCreateInput): Promise<NotificationTargetRow> {
    const parsed = NotificationTargetCreateInputSchema.parse(input);
    const id = parsed.id ?? `notif_target_${randomUUID()}`;
    const result = await client.query(
      `INSERT INTO notification_targets
         (id, org_id, scope, user_id, channel_kind, destination, label, enabled, weekend_mute)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${TARGET_COLUMNS}`,
      [
        id,
        parsed.orgId,
        parsed.scope,
        parsed.userId,
        parsed.channelKind,
        parsed.destination,
        parsed.label,
        parsed.enabled ? 1 : 0,
        parsed.weekendMute ? 1 : 0,
      ],
    );
    return decodeTargetRow(result.rows[0] as RawTargetRow);
  },

  async get(client: QueryClient, id: string): Promise<NotificationTargetRow | undefined> {
    const result = await client.query(`SELECT ${TARGET_COLUMNS} FROM notification_targets WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return decodeTargetRow(row as RawTargetRow);
  },

  async listForOrg(client: QueryClient, orgId: string): Promise<NotificationTargetRow[]> {
    const result = await client.query(
      `SELECT ${TARGET_COLUMNS} FROM notification_targets WHERE org_id = $1 ORDER BY scope, channel_kind, label`,
      [orgId],
    );
    return result.rows.map((row) => decodeTargetRow(row as RawTargetRow));
  },
} as const;

export const NotificationRouteStore = {
  async create(client: QueryClient, input: NotificationRouteCreateInput): Promise<NotificationRouteRow> {
    const parsed = NotificationRouteCreateInputSchema.parse(input);
    const id = parsed.id ?? `notif_route_${randomUUID()}`;
    const result = await client.query(
      `INSERT INTO notification_routes
         (id, target_id, event_name, enabled, min_severity)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${ROUTE_COLUMNS}`,
      [id, parsed.targetId, parsed.eventName, parsed.enabled ? 1 : 0, parsed.minSeverity],
    );
    return decodeRouteRow(result.rows[0] as RawRouteRow);
  },

  // Returns every route across all targets in the org, for a single event.
  // The dispatcher uses this to evaluate the matrix against an incoming
  // event without joining at query time.
  async listForOrgEvent(
    client: QueryClient,
    args: { orgId: string; eventName: string },
  ): Promise<NotificationRouteRow[]> {
    const result = await client.query(
      `SELECT ${qualifiedRouteColumns()}
         FROM notification_routes r
         JOIN notification_targets t ON r.target_id = t.id
        WHERE t.org_id = $1 AND r.event_name = $2`,
      [args.orgId, args.eventName],
    );
    return result.rows.map((row) => decodeRouteRow(row as RawRouteRow));
  },

  async listForTarget(client: QueryClient, targetId: string): Promise<NotificationRouteRow[]> {
    const result = await client.query(
      `SELECT ${ROUTE_COLUMNS} FROM notification_routes WHERE target_id = $1 ORDER BY event_name`,
      [targetId],
    );
    return result.rows.map((row) => decodeRouteRow(row as RawRouteRow));
  },
} as const;

function qualifiedRouteColumns(): string {
  return ROUTE_COLUMNS.split(",")
    .map((column) => `r.${column.trim()}`)
    .join(", ");
}

// Dispatch log writer. The `notifications` table is a dispatch ledger:
// each call to publish() — successful, failed, or
// stubbed — appends one row here. The dispatcher writes through this
// helper so the audit trail is consistent regardless of channel.
export type DispatchStatus = "sent" | "failed" | "stubbed" | "skipped";

export interface DispatchLogInput {
  channel: string;
  payload: unknown;
  status: DispatchStatus;
  attempts: number;
  sentAt: Date | null;
}

export const NotificationDispatchLog = {
  async record(client: QueryClient, input: DispatchLogInput): Promise<void> {
    await client.query(
      `INSERT INTO notifications (channel, payload, status, attempts, sent_at)
       VALUES ($1, $2::jsonb, $3, $4, $5)`,
      [input.channel, JSON.stringify(input.payload), input.status, input.attempts, input.sentAt],
    );
  },
} as const;
