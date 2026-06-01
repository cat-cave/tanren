// Plane-split P3: the control-plane RUN-STATE WRITE endpoints. The data-plane
// worker POSTs its tenant run-state writes here over mTLS instead of writing the
// control DB directly:
//
//   - POST /internal/append-event   — append one timeline event
//   - POST /internal/record-cost    — insert one cost_records row (+ cost.resolved)
//   - POST /internal/reconcile-cost — apportion a run's cost_records (run-end back-fill)
//   - POST /internal/finalize-run   — finalize a run (UPDATE runs, guarded)
//
// Each endpoint, like the claim endpoint, authenticates the mTLS peer FIRST (401
// before any DB work), then performs the SAME org-scoped write the worker did
// in-process — only now server-side, under the CONTROL PLANE's DB access. The
// write runs inside `runWithOrgScope(pool, orgId, …)` so it carries
// `app.current_org_id` and the enforced RLS policy admits exactly the run's own
// rows. WHAT GETS WRITTEN IS UNCHANGED — same columns/values, same exactly-once
// (the finalize `fromStatuses` guard makes a retry a no-op).
//
// The endpoints REUSE the worker's own store logic (`PgEventStore`,
// `CostRecorder`) so there is one source of truth for the write shape. They live
// ONLY on the internal mTLS listener, never the public API.

import { runWithOrgScope } from "@tanren/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { CostRecorder } from "../../engine/costs/recorder.js";
import { PgEventStore } from "../../engine/eventStore.js";
import { verifyInternalPeer, type RunStateWriteRouteDeps } from "./internalWriteShared.js";
import { registerRunStateLifecycleRoutes } from "./runStateLifecycleWrites.js";

export type { RunStateWriteRouteDeps } from "./internalWriteShared.js";

const appendEventSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().optional(),
  specId: z.string(),
  projectId: z.string(),
  orgId: z.string().min(1),
  eventType: z.string().min(1),
  payload: z.unknown(),
});

const recordCostSchema = z.object({
  context: z
    .object({
      runId: z.string().min(1),
      taskId: z.string(),
      specId: z.string(),
      projectId: z.string(),
      cli: z.string(),
      model: z.string(),
      authRef: z.string(),
      runtimeSeconds: z.number().optional(),
      ccusageCostUsd: z.number().nullable().optional(),
      userId: z.string().nullable().optional(),
    })
    .passthrough(),
  orgId: z.string().min(1),
  tokens: z.record(z.string(), z.unknown()),
  rawUsage: z.record(z.string(), z.unknown()),
});

const reconcileCostSchema = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  totalCostUsd: z.number(),
  basis: z.enum(["ccusage", "credits"]),
});

const finalizeRunSchema = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  status: z.string().min(1),
  outcome: z.string().min(1),
  fromStatuses: z.array(z.string().min(1)).min(1),
});

/**
 * Build the internal run-state-write routes. Mounted on the mTLS-only internal
 * listener alongside the claim endpoint. Every write runs under
 * `runWithOrgScope(pool, orgId, …)` — the same org scope the worker used
 * in-process — so the persisted rows are byte-for-byte the direct path's.
 */
export function createInternalRunStateWriteRoutes(deps: RunStateWriteRouteDeps): Hono {
  const app = new Hono();

  const authnPeer = (c: Context): boolean => verifyInternalPeer(deps.verifier, c);

  app.post("/internal/append-event", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = appendEventSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_append_event", issues: parsed.error.issues }, 400);
    }
    const { orgId, taskId, ...event } = parsed.data;
    await runWithOrgScope(deps.pool, orgId, async (client) => {
      // The SAME PgEventStore.append the worker ran — only the client (and thus
      // the DB access) is the control plane's, scoped to the run's org.
      await new PgEventStore(client).append({
        runId: event.runId,
        ...(taskId === undefined ? {} : { taskId }),
        specId: event.specId,
        projectId: event.projectId,
        // The event name + payload are validated by the store's own registry parser.
        eventType: event.eventType as never,
        payload: event.payload as never,
      });
    });
    return c.body(null, 204);
  });

  app.post("/internal/record-cost", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = recordCostSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_record_cost", issues: parsed.error.issues }, 400);
    }
    const { orgId, context, tokens, rawUsage } = parsed.data;
    const recorded = await runWithOrgScope(deps.pool, orgId, async (client) => {
      const eventStore = new PgEventStore(client);
      // The SAME CostRecorder.record — cost_records INSERT + cost.resolved event,
      // both in this org scope, identical to the worker's in-process write.
      return new CostRecorder(client, eventStore).record(context as never, tokens as never, rawUsage);
    });
    return c.json(recorded);
  });

  app.post("/internal/reconcile-cost", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = reconcileCostSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_reconcile_cost", issues: parsed.error.issues }, 400);
    }
    const { runId, orgId, totalCostUsd, basis } = parsed.data;
    const result = await runWithOrgScope(deps.pool, orgId, async (client) => {
      // The SAME apportion the worker ran in-process — the run's cost_records
      // SELECT + per-row UPDATEs, in this org scope, only now server-side under
      // the control plane's DB access. The worker already resolved the dollar
      // total + basis (credit/ccusage precedence), so this just applies it.
      return new CostRecorder(client, new PgEventStore(client)).applyReconcile(runId, totalCostUsd, basis);
    });
    return c.json(result);
  });

  app.post("/internal/finalize-run", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = finalizeRunSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_finalize_run", issues: parsed.error.issues }, 400);
    }
    const { runId, orgId, status, outcome, fromStatuses } = parsed.data;
    const result = await runWithOrgScope(deps.pool, orgId, async (client) => {
      // The SAME guarded finalize UPDATE the worker ran — `status = ANY(...)` is
      // the `status IN (...)` guard, so a retry against an already-finalized run
      // matches no row (exactly-once: no duplicate finalize, no duplicate event).
      const updated = await client.query(
        `UPDATE runs SET status = $2, outcome = $3, ended_at = now()
         WHERE run_id = $1 AND status = ANY($4::text[])
         RETURNING spec_id, project_id`,
        [runId, status, outcome, fromStatuses],
      );
      const row = updated.rows[0] as { spec_id?: unknown; project_id?: unknown } | undefined;
      if (row === undefined) {
        return { updated: false };
      }
      return { updated: true, specId: String(row.spec_id ?? ""), projectId: String(row.project_id ?? "") };
    });
    return c.json(result);
  });

  // Plane-split P3c: the run/spec/task lifecycle write endpoints (set-run-status,
  // set-run-pr-url, set-spec-status, supersede-queued-planner-task, insert-task,
  // update-task). Kept in a sibling module so this file stays under the 500-line
  // cap; they share the same authn + `runWithOrgScope` + fixed-SQL contract.
  registerRunStateLifecycleRoutes(app, deps);

  return app;
}
