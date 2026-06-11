import { randomUUID } from "node:crypto";
import type pg from "pg";
import { requireRow } from "../data/pgRows.js";
import {
  type NotificationDeliveryRow,
  type NotificationRouteCreateInput,
  type NotificationRouteRow,
  type NotificationTargetCreateInput,
  type NotificationTargetRow,
  NotificationDeliveryRow as NotificationDeliveryRowSchema,
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
  base_url: unknown;
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

interface RawDeliveryRow {
  id: unknown;
  org_id: unknown;
  channel: unknown;
  status: unknown;
  attempts: unknown;
  enqueued_at: unknown;
  sent_at: unknown;
  event_name: unknown;
  target_id: unknown;
  severity: unknown;
  title: unknown;
  reason: unknown;
  layering: unknown;
  target_channel_kind: unknown;
  target_label: unknown;
}

const TARGET_COLUMNS = `
  id, org_id, scope, user_id, channel_kind, destination, base_url, label,
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
    baseUrl: nullableString(raw.base_url),
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

function decodeDeliveryRow(raw: RawDeliveryRow): NotificationDeliveryRow {
  const targetId = stringOrNull(raw.target_id);
  return NotificationDeliveryRowSchema.parse({
    id: Number(raw.id),
    orgId: stringOrNull(raw.org_id),
    channel: raw.channel,
    status: raw.status,
    attempts: Number(raw.attempts),
    enqueuedAt: raw.enqueued_at,
    sentAt: raw.sent_at,
    eventName: stringOrNull(raw.event_name),
    targetId,
    severity: stringOrNull(raw.severity),
    title: stringOrNull(raw.title),
    reason: stringOrNull(raw.reason),
    layering: stringOrNull(raw.layering),
    target:
      targetId === null || raw.target_channel_kind === null
        ? null
        : {
            id: targetId,
            channelKind: raw.target_channel_kind,
            label: raw.target_label,
          },
  });
}

export const NotificationTargetStore = {
  async create(client: QueryClient, input: NotificationTargetCreateInput): Promise<NotificationTargetRow> {
    const parsed = NotificationTargetCreateInputSchema.parse(input);
    const id = parsed.id ?? `notif_target_${randomUUID()}`;
    const result = await client.query<RawTargetRow>(
      `INSERT INTO notification_targets
         (id, org_id, scope, user_id, channel_kind, destination, base_url, label, enabled, weekend_mute)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${TARGET_COLUMNS}`,
      [
        id,
        parsed.orgId,
        parsed.scope,
        parsed.userId,
        parsed.channelKind,
        parsed.destination,
        parsed.baseUrl,
        parsed.label,
        parsed.enabled ? 1 : 0,
        parsed.weekendMute ? 1 : 0,
      ],
    );
    return decodeTargetRow(requireRow(result.rows[0], "notification target insert"));
  },

  async get(client: QueryClient, id: string): Promise<NotificationTargetRow | undefined> {
    const result = await client.query<RawTargetRow>(
      `SELECT ${TARGET_COLUMNS} FROM notification_targets WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return decodeTargetRow(row);
  },

  async listForOrg(client: QueryClient, orgId: string): Promise<NotificationTargetRow[]> {
    const result = await client.query<RawTargetRow>(
      `SELECT ${TARGET_COLUMNS} FROM notification_targets WHERE org_id = $1 ORDER BY scope, channel_kind, label`,
      [orgId],
    );
    return result.rows.map((row) => decodeTargetRow(row));
  },
} as const;

export const NotificationRouteStore = {
  async create(client: QueryClient, input: NotificationRouteCreateInput): Promise<NotificationRouteRow> {
    const parsed = NotificationRouteCreateInputSchema.parse(input);
    const id = parsed.id ?? `notif_route_${randomUUID()}`;
    const result = await client.query<RawRouteRow>(
      `INSERT INTO notification_routes
         (id, target_id, event_name, enabled, min_severity)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${ROUTE_COLUMNS}`,
      [id, parsed.targetId, parsed.eventName, parsed.enabled ? 1 : 0, parsed.minSeverity],
    );
    return decodeRouteRow(requireRow(result.rows[0], "notification route insert"));
  },

  // Returns every route across all targets in the org, for a single event.
  // The dispatcher uses this to evaluate the matrix against an incoming
  // event without joining at query time.
  async listForOrgEvent(
    client: QueryClient,
    args: { orgId: string; eventName: string },
  ): Promise<NotificationRouteRow[]> {
    const result = await client.query<RawRouteRow>(
      `SELECT ${qualifiedRouteColumns()}
         FROM notification_routes r
         JOIN notification_targets t ON r.target_id = t.id
        WHERE t.org_id = $1 AND r.event_name = $2`,
      [args.orgId, args.eventName],
    );
    return result.rows.map((row) => decodeRouteRow(row));
  },

  async listForTarget(client: QueryClient, targetId: string): Promise<NotificationRouteRow[]> {
    const result = await client.query<RawRouteRow>(
      `SELECT ${ROUTE_COLUMNS} FROM notification_routes WHERE target_id = $1 ORDER BY event_name`,
      [targetId],
    );
    return result.rows.map((row) => decodeRouteRow(row));
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
  orgId: string;
  channel: string;
  payload: unknown;
  status: DispatchStatus;
  attempts: number;
  sentAt: Date | null;
}

export interface NotificationDeliveryListFilters {
  orgId: string;
  limit: number;
  eventName?: string;
  status?: DispatchStatus;
}

export const NotificationDispatchLog = {
  async record(client: QueryClient, input: DispatchLogInput): Promise<void> {
    if (input.orgId.length === 0) {
      throw new Error("notification dispatch log requires an orgId");
    }
    await client.query(
      `INSERT INTO notifications (channel, payload, status, attempts, sent_at, tenant_id)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6)`,
      [input.channel, JSON.stringify(input.payload), input.status, input.attempts, input.sentAt, input.orgId],
    );
  },

  async listForOrg(client: QueryClient, filters: NotificationDeliveryListFilters): Promise<NotificationDeliveryRow[]> {
    const params: unknown[] = [filters.orgId];
    const where = ["(n.tenant_id = $1 OR (n.tenant_id IS NULL AND t.id IS NOT NULL))"];

    if (filters.eventName !== undefined) {
      params.push(filters.eventName);
      where.push(`n.payload->>'eventName' = $${params.length}`);
    }
    if (filters.status !== undefined) {
      params.push(filters.status);
      where.push(`n.status = $${params.length}`);
    }

    params.push(filters.limit);
    const result = await client.query<RawDeliveryRow>(
      `SELECT
          n.id,
          COALESCE(n.tenant_id, t.org_id) AS org_id,
          n.channel,
          n.status,
          n.attempts,
          n.enqueued_at,
          n.sent_at,
          n.payload->>'eventName' AS event_name,
          n.payload->>'targetId' AS target_id,
          n.payload->>'severity' AS severity,
          n.payload->>'title' AS title,
          n.payload->>'reason' AS reason,
          n.payload->>'layering' AS layering,
          t.channel_kind AS target_channel_kind,
          t.label AS target_label
         FROM notifications n
         LEFT JOIN notification_targets t
           ON t.id = n.payload->>'targetId'
          AND t.org_id = $1
        WHERE ${where.join(" AND ")}
        ORDER BY n.enqueued_at DESC, n.id DESC
        LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => decodeDeliveryRow(row));
  },
} as const;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// base_url is a nullable text column: a stored NULL (or a legacy empty string)
// means "use the deploy default" and must decode to `null` so the Zod
// `.url().nullable()` accepts it; any non-empty value is a real http(s) URL.
function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
