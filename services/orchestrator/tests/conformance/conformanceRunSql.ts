// The run-domain read-SQL handlers for the `Repositories` conformance harness:
// the run-detail summary + project run-list projection (RunStore), the task
// timeline (TaskStore), the event reads (EventStore), and the cost snapshot
// (CostStore). Returns a QueryResult when the collapsed SQL matches one of these
// reads, or `undefined` so the caller falls through to the product-entity
// handlers. Each branch reproduces the store's ordering/filtering against the
// org-scoped record slices, exactly as the real SQL would under RLS.

import type {
  CostRecord,
  EventRecord,
  MemoryDb,
  QueryResult,
  RunRecord,
  RunTaskRecord,
} from "./conformanceMemoryDb.js";

const PHASE_ORDER: Record<string, number> = { plan: 1, write: 2, check: 3, audit: 4, ci: 5 };

export function handleRunReadSql(
  db: MemoryDb,
  orgId: string,
  sql: string,
  params: readonly unknown[],
): QueryResult | undefined {
  const runs = (): RunRecord[] => db.runs.filter((r) => r.org_id === orgId);
  const runTasks = (): RunTaskRecord[] => db.runTasks.filter((t) => t.org_id === orgId);
  const events = (): EventRecord[] => db.events.filter((e) => e.org_id === orgId);
  const costRecords = (): CostRecord[] => db.costRecords.filter((c) => c.org_id === orgId);

  // --- runs (run-detail summary + project run-list projection) ---
  if (/FROM runs r LEFT JOIN specs s/u.test(sql)) {
    return runListProjection(db, runs(), events(), costRecords(), sql, params);
  }
  if (/FROM runs WHERE run_id = \$1 AND org_id = \$2/u.test(sql)) {
    const [runId] = params as [string];
    const rows = runs().filter((r) => r.run_id === runId);
    return { rows, rowCount: rows.length };
  }

  // --- tasks (run-detail timeline) ---
  if (/FROM tasks WHERE run_id = \$1 AND org_id = \$2 ORDER BY CASE kind/u.test(sql)) {
    const [runId] = params as [string];
    const rows = runTasks()
      .filter((t) => t.run_id === runId)
      .sort((a, b) => {
        const ka = PHASE_ORDER[a.kind] ?? 99;
        const kb = PHASE_ORDER[b.kind] ?? 99;
        if (ka !== kb) return ka - kb;
        const ta = a.started_at?.getTime() ?? Number.NEGATIVE_INFINITY;
        const tb = b.started_at?.getTime() ?? Number.NEGATIVE_INFINITY;
        if (ta !== tb) return ta - tb;
        return a.task_id.localeCompare(b.task_id);
      });
    return { rows, rowCount: rows.length };
  }

  // --- events (SSE delta: id > sinceId as decimal text / ::bigint) ---
  if (
    /FROM events WHERE run_id = \$1 AND org_id = \$3 AND id > \$2(?:::bigint)? ORDER BY id ASC LIMIT 200/u.test(sql)
  ) {
    const [runId, sinceId] = params as [string, string | number];
    const since = BigInt(String(sinceId));
    const rows = events()
      .filter((e) => e.run_id === runId && BigInt(e.id) > since)
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
    return { rows, rowCount: rows.length };
  }

  // --- events (recent snapshot + project feed) ---
  if (/FROM events WHERE run_id = \$1 AND org_id = \$3 ORDER BY ts DESC, id DESC LIMIT \$2/u.test(sql)) {
    const [runId, limit] = params as [string, number];
    const rows = events()
      .filter((e) => e.run_id === runId)
      .sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id)
      .slice(0, limit)
      .sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.id - b.id);
    return { rows, rowCount: rows.length };
  }
  if (/FROM events WHERE project_id = \$1 AND org_id = \$2 AND run_id IS NOT NULL/u.test(sql)) {
    const [projectId] = params as [string, string];
    const rows = events()
      .filter((e) => e.project_id === projectId && e.run_id !== null)
      .sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id);
    return { rows, rowCount: rows.length };
  }

  // --- cost_records (SSE delta: id > sinceId as decimal text / ::bigint) ---
  if (
    /FROM cost_records WHERE run_id = \$1 AND org_id = \$3 AND id > \$2(?:::bigint)? ORDER BY id ASC LIMIT 200/u.test(
      sql,
    )
  ) {
    const [runId, sinceId] = params as [string, string | number];
    const since = BigInt(String(sinceId));
    const rows = costRecords()
      .filter((c) => c.run_id === runId && BigInt(c.id) > since)
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
    return { rows, rowCount: rows.length };
  }

  // --- cost_records (run snapshot + paginated) ---
  if (/FROM cost_records WHERE run_id = \$1 AND org_id = \$2/u.test(sql)) {
    const [runId] = params as [string];
    const rows = costRecords()
      .filter((c) => c.run_id === runId)
      .sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime() || a.id - b.id);
    return { rows, rowCount: rows.length };
  }

  return undefined;
}

// selectListForProject: project + org, optional status/spec predicates, with the
// constrained spec-title join and the per-run cost / last-event aggregate subqueries.
function runListProjection(
  db: MemoryDb,
  scopedRuns: RunRecord[],
  scopedEvents: EventRecord[],
  scopedCosts: CostRecord[],
  sql: string,
  params: readonly unknown[],
): QueryResult {
  const [projectId, _orgId, maybeStatus, maybeSpec] = params as [string, string, string?, string?];
  void _orgId;
  // Re-derive which optional predicates were bound from the SQL shape.
  const hasStatus = /r\.status = \$/u.test(sql);
  const hasSpec = /r\.spec_id = \$/u.test(sql);
  let rows = scopedRuns.filter((r) => r.project_id === projectId);
  if (hasStatus) rows = rows.filter((r) => r.status === maybeStatus);
  if (hasSpec) {
    const specVal = hasStatus ? maybeSpec : maybeStatus;
    rows = rows.filter((r) => r.spec_id === specVal);
  }
  rows.sort((a, b) => b.started_at.getTime() - a.started_at.getTime() || a.run_id.localeCompare(b.run_id));
  const projected = rows.map((r) => {
    // Match production: s.spec_id AND s.project_id AND s.org_id = $2.
    const specTitle = db.specs.find((s) => s.spec_id === r.spec_id && s.project_id === r.project_id)?.title ?? null;
    const runCosts = scopedCosts.filter((c) => c.run_id === r.run_id);
    const costTotal =
      runCosts.length === 0
        ? "0"
        : runCosts.some((c) => c.cost_usd === null)
          ? null
          : runCosts.reduce((sum, c) => sum + Number(c.cost_usd), 0).toFixed(2);
    const lastEvent = scopedEvents
      .filter((e) => e.run_id === r.run_id)
      .reduce<Date | null>((max, e) => (max === null || e.ts > max ? e.ts : max), null);
    return {
      run_id: r.run_id,
      spec_id: r.spec_id,
      project_id: r.project_id,
      trigger: r.trigger,
      branch: r.branch,
      status: r.status,
      outcome: r.outcome,
      pr_url: r.pr_url,
      started_at: r.started_at,
      ended_at: r.ended_at,
      spec_title: specTitle,
      cost_total_usd: costTotal,
      last_event_at: lastEvent,
    };
  });
  return { rows: projected, rowCount: projected.length };
}
