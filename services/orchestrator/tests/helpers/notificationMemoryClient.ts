// Tiny in-memory pg substitute that pattern-matches the SQL emitted by the
// notification stores (targets, routes, dispatch log). Mirrors the
// EntityMemoryClient approach used for product entities.

interface StubResult {
  rowCount: number;
  rows: ReadonlyArray<Record<string, unknown>>;
}

const CANONICAL_LIST_FOR_ORG_ROUTE_ORDER = "ORDER BY r.event_name, r.target_id, r.id";

export class NotificationMemoryClient {
  readonly queries: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
  readonly targets: Map<string, Record<string, unknown>> = new Map();
  readonly routes: Map<string, Record<string, unknown>> = new Map();
  readonly dispatches: Array<Record<string, unknown>> = [];
  // Monday
  now: Date = new Date("2026-01-05T12:00:00Z");

  async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<StubResult> {
    this.queries.push({ sql, params });
    const trimmed = sql.trim();

    if (trimmed.startsWith("INSERT INTO notification_targets")) {
      return this.insertTarget(params);
    }
    if (trimmed.startsWith("UPDATE notification_targets")) {
      return this.updateTarget(trimmed, params);
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
    if (trimmed.startsWith("UPDATE notification_routes")) {
      return this.updateRoute(trimmed, params);
    }
    if (trimmed.startsWith("DELETE FROM notification_routes")) {
      return this.deleteRoute(params);
    }
    // getForOrg: a single route resolved by id, org-scoped through the target join.
    // Must come BEFORE the generic `FROM notification_routes r` listForOrg branch
    // (which throws unless the SQL ends with the canonical ORDER BY).
    if (
      trimmed.startsWith("SELECT") &&
      trimmed.includes("FROM notification_routes r") &&
      trimmed.includes("WHERE r.id = $1")
    ) {
      const id = String(params[0]);
      const orgId = String(params[1]);
      const route = this.routes.get(id);
      if (route === undefined) return { rowCount: 0, rows: [] };
      const target = this.targets.get(String(route.target_id));
      if (target === undefined || target.org_id !== orgId) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [route] };
    }
    // Two production queries share `FROM notification_routes r JOIN
    // notification_targets t`. Mirror each shape EXACTLY rather than folding
    // them into one branch: listForOrgEvent filters by `AND r.event_name =
    // $2` and ships no ORDER BY; listForOrg returns every org route ordered
    // by (event_name, target_id, id). Folding them previously masked the
    // missing production ORDER BY — the fake returned Map insertion order,
    // which happened to look deterministic.
    if (
      trimmed.startsWith("SELECT") &&
      trimmed.includes("FROM notification_routes r") &&
      trimmed.includes("AND r.event_name = $2")
    ) {
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
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM notification_routes r")) {
      if (!trimmed.endsWith(CANONICAL_LIST_FOR_ORG_ROUTE_ORDER)) {
        throw new Error(
          `NotificationMemoryClient: listForOrg query must end with ${CANONICAL_LIST_FOR_ORG_ROUTE_ORDER}`,
        );
      }
      const orgId = String(params[0]);
      const rows: Array<Record<string, unknown>> = [];
      for (const route of this.routes.values()) {
        const target = this.targets.get(String(route.target_id));
        if (target === undefined) continue;
        if (target.org_id !== orgId) continue;
        rows.push(route);
      }
      rows.sort(
        (a, b) =>
          String(a.event_name).localeCompare(String(b.event_name)) ||
          String(a.target_id).localeCompare(String(b.target_id)) ||
          String(a.id).localeCompare(String(b.id)),
      );
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
        org_id: params[5],
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
      base_url: params[6],
      label: params[7],
      enabled: params[8],
      weekend_mute: params[9],
      created_at: this.now,
      updated_at: this.now,
    };
    this.targets.set(String(row.id), row);
    return { rowCount: 1, rows: [row] };
  }

  private updateTarget(sql: string, params: ReadonlyArray<unknown>): StubResult {
    // Last two params are always id + org_id (store builds dynamic SET first).
    const id = String(params.at(-2));
    const orgId = String(params.at(-1));
    const existing = this.targets.get(id);
    if (existing === undefined || existing.org_id !== orgId) {
      return { rowCount: 0, rows: [] };
    }
    let paramIdx = 0;
    if (sql.includes("weekend_mute =")) {
      existing.weekend_mute = params[paramIdx++];
    }
    if (sql.includes("enabled =")) {
      existing.enabled = params[paramIdx++];
    }
    existing.updated_at = this.now;
    this.targets.set(id, existing);
    return { rowCount: 1, rows: [existing] };
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

  private updateRoute(sql: string, params: ReadonlyArray<unknown>): StubResult {
    // Dynamic SET first, then id + org_id as the last two params (store builds the
    // SET clause in enabled → min_severity order, matching the checks below).
    const id = String(params.at(-2));
    const orgId = String(params.at(-1));
    const route = this.routes.get(id);
    if (route === undefined) return { rowCount: 0, rows: [] };
    const target = this.targets.get(String(route.target_id));
    if (target === undefined || target.org_id !== orgId) return { rowCount: 0, rows: [] };
    let paramIdx = 0;
    if (sql.includes("enabled =")) {
      route.enabled = params[paramIdx++];
    }
    if (sql.includes("min_severity =")) {
      route.min_severity = params[paramIdx++];
    }
    route.updated_at = this.now;
    this.routes.set(id, route);
    return { rowCount: 1, rows: [route] };
  }

  private deleteRoute(params: ReadonlyArray<unknown>): StubResult {
    const id = String(params[0]);
    const orgId = String(params[1]);
    const route = this.routes.get(id);
    if (route === undefined) return { rowCount: 0, rows: [] };
    const target = this.targets.get(String(route.target_id));
    if (target === undefined || target.org_id !== orgId) return { rowCount: 0, rows: [] };
    this.routes.delete(id);
    return { rowCount: 1, rows: [{ id }] };
  }

  private listDispatches(params: ReadonlyArray<unknown>): StubResult {
    const orgId = String(params[0]);
    const filterValues = params.slice(1, -1).map(String);
    const limit = Number(params.at(-1));
    const rows: Array<Record<string, unknown>> = [];

    for (const dispatch of this.dispatches) {
      const payload = dispatch.payload as Record<string, unknown>;
      const target = this.targets.get(String(payload.targetId));
      // notifications.org_id is NOT NULL (0045): the ledger row's own org is the
      // sole scope — no legacy tenant_id NULL-fallback via the target join.
      const orgMatches = dispatch.org_id === orgId;
      if (!orgMatches) continue;
      const hasStatusFilter =
        filterValues.includes("sent") ||
        filterValues.includes("failed") ||
        filterValues.includes("stubbed") ||
        filterValues.includes("skipped") ||
        filterValues.includes("undelivered_no_route");
      if (hasStatusFilter && !filterValues.includes(String(dispatch.status))) continue;
      const eventFilter = filterValues.find(
        (value) => !["sent", "failed", "stubbed", "skipped", "undelivered_no_route"].includes(value),
      );
      if (eventFilter !== undefined && payload.eventName !== eventFilter) continue;
      rows.push({
        id: dispatch.id,
        org_id: dispatch.org_id,
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
