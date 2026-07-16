// The control-plane RUN-STATE WRITE endpoints. The data-plane
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
import { scalarTextOr } from "../../engine/data/scalarText.js";
import { Hono, type Context } from "hono";
import { z, ZodError } from "zod";
import { CostRecorder } from "../../engine/costs/recorder.js";
import { PgEventStore } from "../../engine/eventStore.js";
import { RunOutcome, RunStatus } from "../../engine/state/run.js";
import { verifyInternalPeer, type RunStateWriteRouteDeps } from "./internalWriteShared.js";
import { registerRunStateLifecycleRoutes } from "./runStateLifecycleWrites.js";
import { registerRunStateCreateRoutes } from "./runStateCreateWrites.js";

export type { RunStateWriteRouteDeps } from "./internalWriteShared.js";

const appendEventSchema = z.object({
  // run_id / spec_id / project_id are NULLABLE on the events table: a PROJECT-scoped
  // event (the DagWalker's `dag.drained` / `dag.budget.paused` / `dag.concurrency.saturated`)
  // carries only projectId + orgId; an ORG-SCOPED event (F2 per-fragment authoring
  // — fires BEFORE a project exists; v68 fix) carries only orgId. The store's
  // INSERT stamps the explicit orgId directly (replacing the prior
  // `(SELECT org_id FROM projects WHERE project_id = $4)` subquery that landed
  // NULL when given no projectId).
  runId: z.string().min(1).optional(),
  taskId: z.string().optional(),
  specId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  orgId: z.string().min(1),
  eventType: z.string().min(1),
  payload: z.unknown(),
});

const appendPriorEventSchema = appendEventSchema.extend({
  runId: z.string().min(1),
  projectId: z.string().min(1),
  idempotencyKey: z.string().min(1),
});

const recordCostSchema = z.object({
  context: z
    .object({
      runId: z.string().min(1),
      taskId: z.string(),
      specId: z.string(),
      projectId: z.string(),
      orgId: z.string().min(1),
      cli: z.string(),
      model: z.string(),
      authRef: z.string(),
      runtimeSeconds: z.number().optional(),
      // The provider's OWN authoritative per-call charge (OpenRouter's
      // `usage.cost`), threaded through the control-plane record path exactly like
      // ccusageCostUsd so a real captured figure sets `provider_response` real
      // spend server-side. Populated for a managed OpenRouter run (the generation-id
      // capture in the run worker); null otherwise (BYOK / non-managed).
      realProviderCostUsd: z.number().nullable().optional(),
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

// Structural shape: required + non-empty (a MISSING field is a 400 caller error,
// pre-DB). The status/outcome VOCABULARY is then validated against the canonical
// `RunStatus`/`RunOutcome` enums at the route (below) so a present-yet-non-enum
// value the de-privileged data plane sends is a CONTROLLED 422 `invalid_run_state`
// — never relayed to the DB to explode there as an opaque 500 from a CHECK
// constraint (the no-deferred-500 boundary: validate at the trust boundary).
const finalizeRunSchema = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  status: z.string().min(1),
  outcome: z.string().min(1),
  fromStatuses: z.array(z.string().min(1)).min(1),
});

/**
 * Validate the finalize-run state vocabulary against the canonical
 * `RunStatus`/`RunOutcome` enums. Returns the offending field + value when any of
 * `status` / `outcome` / a `fromStatuses` entry is not a known enum member, so the
 * route can return a controlled 422 `invalid_run_state` rather than handing an
 * arbitrary string to the DB to explode against the CHECK constraint as a 500.
 */
function invalidRunState(parsed: z.infer<typeof finalizeRunSchema>): { field: string; value: string } | undefined {
  if (!RunStatus.safeParse(parsed.status).success) {
    return { field: "status", value: parsed.status };
  }
  if (!RunOutcome.safeParse(parsed.outcome).success) {
    return { field: "outcome", value: parsed.outcome };
  }
  const badFrom = parsed.fromStatuses.find((s) => !RunStatus.safeParse(s).success);
  if (badFrom !== undefined) {
    return { field: "fromStatuses", value: badFrom };
  }
  return undefined;
}

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
    const { orgId, runId, taskId, specId, projectId, ...event } = parsed.data;
    try {
      await runWithOrgScope(deps.pool, orgId, async (client) => {
        // The SAME PgEventStore.append the worker ran — only the client (and thus
        // the DB access) is the control plane's, scoped to the run's org. run /
        // spec / project are passed only when present: a project-scoped event
        // (dag.drained etc.) omits run/spec, and an ORG-SCOPED event (F2 per-fragment
        // authoring; v68 fix) omits projectId too — byte-identical to the direct path.
        await new PgEventStore(client).append({
          ...(runId === undefined ? {} : { runId }),
          ...(taskId === undefined ? {} : { taskId }),
          ...(specId === undefined ? {} : { specId }),
          ...(projectId === undefined ? {} : { projectId }),
          orgId,
          // The event name + payload are validated by the store's own registry parser.
          eventType: event.eventType as never,
          payload: event.payload as never,
        });
      });
    } catch (error) {
      // The route schema admits `payload: unknown`; the store's registry parser is
      // the authoritative per-event-type check (e.g. run.failed now requires a
      // redacted failureCode/stage). A payload that fails THAT parse is a malformed
      // CALLER request, not a control-plane fault — return a controlled 422 with the
      // issues, never a bare 500 (which once masked a stale-payload-shape caller as
      // an opaque "Internal Server Error"). A genuine infra fault still propagates.
      if (error instanceof ZodError) {
        return c.json({ error: "invalid_event_payload", issues: error.issues }, 422);
      }
      throw error;
    }
    return c.body(null, 204);
  });

  app.post("/internal/append-prior-event", async (c) => {
    if (!authnPeer(c)) return c.json({ error: "untrusted_peer" }, 401);
    const parsed = appendPriorEventSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_append_prior_event", issues: parsed.error.issues }, 400);
    }
    const { orgId, runId, taskId, specId, projectId, idempotencyKey, ...event } = parsed.data;
    try {
      const inserted = await runWithOrgScope(deps.pool, orgId, (client) =>
        new PgEventStore(client).appendPriorIfAbsent({
          runId,
          ...(taskId === undefined ? {} : { taskId }),
          ...(specId === undefined ? {} : { specId }),
          projectId,
          orgId,
          eventType: event.eventType as never,
          payload: event.payload as never,
          idempotencyKey,
        }),
      );
      return c.json({ inserted });
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json({ error: "invalid_event_payload", issues: error.issues }, 422);
      }
      throw error;
    }
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
      // both in this org scope, identical to the worker's in-process write. Notional
      // prices from the recorder's default LIVE, self-healing source (seed fallback).
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
    // VOCABULARY gate (mTLS data plane is de-privileged but still a caller): a
    // present-yet-non-enum status/outcome is a controlled 422 at the route, NOT a
    // string relayed to the DB to explode against the CHECK constraint as a 500.
    const invalid = invalidRunState(parsed.data);
    if (invalid !== undefined) {
      return c.json({ error: "invalid_run_state", field: invalid.field, value: invalid.value }, 422);
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
      return { updated: true, specId: scalarTextOr(row.spec_id, ""), projectId: scalarTextOr(row.project_id, "") };
    });
    return c.json(result);
  });

  // the run/spec/task lifecycle write endpoints (set-run-status,
  // set-run-pr-url, set-spec-status, supersede-queued-planner-task, insert-task,
  // update-task). Kept in a sibling module so this file stays under the 500-line
  // cap; they share the same authn + `runWithOrgScope` + fixed-SQL contract.
  registerRunStateLifecycleRoutes(app, deps);

  // Plane-split (autonomy loops): the run/spec CREATE endpoints (create-queued-run,
  // create-spec) the DagWalker / merge coordinator / intake POST instead of writing
  // the runs/specs/tasks/events tables directly. Same authn + the loop's own
  // `createQueuedRunFromSpec` / `createSpec` (org-scoped from the carried actor).
  registerRunStateCreateRoutes(app, deps);

  return app;
}
