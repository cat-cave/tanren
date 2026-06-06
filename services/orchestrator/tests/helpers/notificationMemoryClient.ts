// Tiny in-memory pg substitute that pattern-matches the SQL emitted by the
// notification stores (targets, routes, dispatch log). Mirrors the
// EntityMemoryClient approach used for product entities.

interface StubResult {
  rowCount: number;
  rows: ReadonlyArray<Record<string, unknown>>;
}

export class NotificationMemoryClient {
  readonly queries: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
  readonly targets: Map<string, Record<string, unknown>> = new Map();
  readonly routes: Map<string, Record<string, unknown>> = new Map();
  readonly dispatches: Array<Record<string, unknown>> = [];
  currentOrgId: string | null = null;
  // Monday
  now: Date = new Date("2026-01-05T12:00:00Z");

  async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<StubResult> {
    this.queries.push({ sql, params });
    const trimmed = sql.trim();

    if (trimmed.startsWith("INSERT INTO notification_targets")) {
      return this.insertTarget(params);
    }
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM notification_targets WHERE id = $1")) {
      const row = this.targets.get(String(params[0]));
      return single(row);
    }
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM notification_targets WHERE org_id = $1")) {
      const orgId = String(params[0]);
      const rows = [...this.targets.values()].filter((t) => t.org_id === orgId);
      return { rowCount: rows.length, rows };
    }

    if (trimmed.startsWith("INSERT INTO notification_routes")) {
      return this.insertRoute(params);
    }
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM notification_routes r")) {
      const orgId = String(params[0]);
      const eventName = String(params[1]);
      const rows: Array<Record<string, unknown>> = [];
      for (const route of this.routes.values()) {
        if (route.event_name !== eventName) continue;
        const target = this.targets.get(String(route.target_id));
        if (target === undefined) continue;
        if (target.org_id !== orgId) continue;
        rows.push(route);
      }
      return { rowCount: rows.length, rows };
    }
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM notification_routes WHERE target_id = $1")) {
      const targetId = String(params[0]);
      const rows = [...this.routes.values()].filter((r) => r.target_id === targetId);
      return { rowCount: rows.length, rows };
    }

    if (trimmed.startsWith("INSERT INTO notifications")) {
      this.dispatches.push({
        id: this.dispatches.length + 1,
        channel: params[0],
        payload: JSON.parse(String(params[1])),
        status: params[2],
        attempts: params[3],
        enqueued_at: this.now,
        sent_at: params[4],
        tenant_id: this.currentOrgId,
      });
      return { rowCount: 1, rows: [] };
    }
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM notifications n")) {
      return this.listDispatches(params);
    }

    throw new Error(`NotificationMemoryClient: unhandled SQL: ${trimmed}`);
  }

  private insertTarget(params: ReadonlyArray<unknown>): StubResult {
    const row = {
      id: params[0],
      org_id: params[1],
      scope: params[2],
      user_id: params[3],
      channel_kind: params[4],
      destination: params[5],
      label: params[6],
      enabled: params[7],
      weekend_mute: params[8],
      created_at: this.now,
      updated_at: this.now,
    };
    this.targets.set(String(row.id), row);
    return { rowCount: 1, rows: [row] };
  }

  private insertRoute(params: ReadonlyArray<unknown>): StubResult {
    const row = {
      id: params[0],
      target_id: params[1],
      event_name: params[2],
      enabled: params[3],
      min_severity: params[4],
      created_at: this.now,
      updated_at: this.now,
    };
    this.routes.set(String(row.id), row);
    return { rowCount: 1, rows: [row] };
  }

  private listDispatches(params: ReadonlyArray<unknown>): StubResult {
    const orgId = String(params[0]);
    const filterValues = params.slice(1, -1).map(String);
    const limit = Number(params.at(-1));
    const rows: Array<Record<string, unknown>> = [];

    for (const dispatch of this.dispatches) {
      const payload = dispatch.payload as Record<string, unknown>;
      const target = this.targets.get(String(payload.targetId));
      const orgMatches = dispatch.tenant_id === orgId || target?.org_id === orgId;
      if (!orgMatches) continue;
      const hasStatusFilter =
        filterValues.includes("sent") ||
        filterValues.includes("failed") ||
        filterValues.includes("stubbed") ||
        filterValues.includes("skipped");
      if (hasStatusFilter && !filterValues.includes(String(dispatch.status))) continue;
      const eventFilter = filterValues.find((value) => !["sent", "failed", "stubbed", "skipped"].includes(value));
      if (eventFilter !== undefined && payload.eventName !== eventFilter) continue;
      rows.push({
        id: dispatch.id,
        org_id: dispatch.tenant_id ?? target?.org_id ?? null,
        channel: dispatch.channel,
        status: dispatch.status,
        attempts: dispatch.attempts,
        enqueued_at: dispatch.enqueued_at,
        sent_at: dispatch.sent_at,
        event_name: payload.eventName ?? null,
        target_id: payload.targetId ?? null,
        severity: payload.severity ?? null,
        title: payload.title ?? null,
        reason: payload.reason ?? null,
        layering: payload.layering ?? null,
        target_channel_kind: target?.channel_kind ?? null,
        target_destination: target?.destination ?? null,
        target_label: target?.label ?? null,
      });
    }

    rows.sort((a, b) => Number(b.id) - Number(a.id));
    return { rowCount: rows.length, rows: rows.slice(0, limit) };
  }
}

function single(row: Record<string, unknown> | undefined): StubResult {
  if (row === undefined) return { rowCount: 0, rows: [] };
  return { rowCount: 1, rows: [row] };
}
