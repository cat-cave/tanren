// The worker's failure-path run finalizers, extracted from `runExecutor.ts`
// (file-size cap). Each forces a run the workflow left in a non-terminal /
// non-recoverable state into a recoverable terminal state + emits the matching
// `run.*` event, under the run's org scope.
//
// Plane-split P3: when a remote `RunStateWriter` is wired AND the run has an org,
// the finalize + event route through the control-plane endpoints (the data plane
// writes no tenant tables directly); otherwise they run the SAME in-process
// org-scoped writes as before (the DEFAULT, behavior-identical, reversible). The
// finalize guard (`status IN (...)`) is applied either way, so a retry is a
// no-op — exactly-once preserved.

import { runWithJobOrgId, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { PgEventStore } from "../eventStore.js";

/**
 * Force a run that a failed workflow left in a non-recoverable terminal state
 * (`failed`) or still `running` (crash) into a recoverable `halted` outcome so
 * it lands on the recovery surface (`RECOVERABLE_OUTCOMES`). A run the workflow
 * already finalized as recoverable (halted / window_exhausted /
 * retry_budget_exhausted) or terminal-good (`done`) is left untouched.
 */
export async function finalizeRunRecoverable(
  pool: pg.Pool,
  writer: RunStateWriter | undefined,
  runId: string,
  message: string,
  orgId: string | null,
): Promise<void> {
  // Plane-split P3: when a remote writer is wired AND the run has an org, route
  // the finalize (UPDATE runs → halted) + the run.failed event through the
  // control-plane endpoints. The finalize endpoint applies the SAME
  // `status IN ('running','queued','failed')` guard server-side (exactly-once),
  // and emits the event only when a row moved — identical to the direct path.
  if (writer !== undefined && orgId !== null) {
    const result = await writer.finalizeRun({
      runId,
      orgId,
      status: "halted",
      outcome: "halted",
      fromStatuses: ["running", "queued", "failed"],
    });
    if (result.updated) {
      // The event append carries the run's org via the per-job org-id scope (the
      // remote writer reads `getJobOrgId()` to scope the server-side INSERT).
      await runWithJobOrgId(orgId, () =>
        writer
          .append({
            runId,
            specId: result.specId ?? "",
            projectId: result.projectId ?? "",
            eventType: "run.failed",
            payload: { status: "halted", message },
          })
          .catch(() => {}),
      );
    }
    return;
  }
  // RLS R2 cohort-3 (worker failure-path finalizer): when the run's org is known
  // (resolved from its execution context), run the finalize UPDATE + the
  // run.failed event in ONE org-scoped transaction so both writes carry org
  // context (`SET LOCAL app.current_org_id = <orgId>`). The catch path previously
  // ran with NO ambient scope; this establishes one. A legacy/unscoped run
  // (org_id NULL) — or a context load that itself failed — falls back to the pool,
  // the pre-cohort-3 behavior. Inert in R1; RLS-correct in R3.
  await withRunFinalizeScope(pool, orgId, async (client) => {
    const updated = await client.query(
      "UPDATE runs SET status = 'halted', outcome = 'halted', ended_at = now() WHERE run_id = $1 AND status IN ('running', 'queued', 'failed') RETURNING run_id, spec_id, project_id",
      [runId],
    );
    const row = updated.rows[0] as { spec_id?: unknown; project_id?: unknown } | undefined;
    if (row !== undefined) {
      // Mirror the workflow's recoverable-finalize: emit run.failed so the
      // timeline/notifications surface the worker-level failure. Best-effort —
      // never let an event write mask the original error path. PgEventStore is
      // handed the in-scope client so its INSERT joins this transaction.
      await new PgEventStore(client)
        .append({
          runId,
          specId: String(row.spec_id ?? ""),
          projectId: String(row.project_id ?? ""),
          eventType: "run.failed",
          payload: { status: "halted", message },
        })
        .catch(() => {});
    }
  });
}

/**
 * Run a run-finalize body (UPDATE + best-effort event append) under the run's
 * org scope when the org is known, else on the pool (the pre-cohort-3 fallback).
 * Centralizes the org-scoping the two worker failure-path finalizers share: a
 * known org opens a `SET LOCAL app.current_org_id = <org>` transaction and hands
 * the body the scoped client; a null org hands it the pool verbatim so behavior
 * is identical to before the cohort.
 */
async function withRunFinalizeScope(
  pool: pg.Pool,
  orgId: string | null,
  body: (client: pg.Pool | pg.PoolClient) => Promise<void>,
): Promise<void> {
  if (orgId === null) {
    await body(pool);
    return;
  }
  await runWithOrgScope(pool, orgId, (client) => body(client));
}
