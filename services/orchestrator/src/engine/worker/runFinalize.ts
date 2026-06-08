// The worker's failure-path run finalizers, extracted from `runExecutor.ts`
// (file-size cap). Each forces a run the workflow left in a non-terminal /
// non-recoverable state into a recoverable terminal state + emits the matching
// `run.*` event, under the run's org scope.
//
// When a remote `RunStateWriter` is wired AND the run has an org,
// the finalize + event route through the control-plane endpoints (the data plane
// writes no tenant tables directly); otherwise they run the SAME in-process
// org-scoped writes as before (the DEFAULT, behavior-identical, reversible). The
// finalize guard (`status IN (...)`) is applied either way, so a retry is a
// no-op — exactly-once preserved.

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
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
  // When a remote writer is wired AND the run has an org, route
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
      // NEVER-STRAND (finding #3): a worker-level force-halt (a crash the workflow's
      // own spec-aware finalize never reached) must not leave the spec at `in_flight`
      // with a dead run. Park it at `needs_attention` (guarded so the workflow's
      // earlier park / a merged spec is a no-op) so the slot frees + the operator can
      // requeue it. Best-effort — never mask the original failure path.
      if (result.specId !== undefined && result.specId !== "") {
        await parkStrandedSpecRemote(pool, writer, orgId, result.specId, result.projectId ?? "", runId, message).catch(
          () => {},
        );
      }
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
      const specId = String(row.spec_id ?? "");
      const projectId = String(row.project_id ?? "");
      // Mirror the workflow's recoverable-finalize: emit run.failed so the
      // timeline/notifications surface the worker-level failure. Best-effort —
      // never let an event write mask the original error path. PgEventStore is
      // handed the in-scope client so its INSERT joins this transaction.
      await new PgEventStore(client)
        .append({
          runId,
          specId,
          projectId,
          eventType: "run.failed",
          payload: { status: "halted", message },
        })
        .catch(() => {});
      // NEVER-STRAND (finding #3): park the spec at `needs_attention` (guarded so a
      // merged spec or the workflow's earlier park is a no-op) so a worker-level
      // force-halt frees the DAG slot + the operator can requeue it — the spec is
      // never left `in_flight` with a dead run.
      if (specId !== "") {
        await parkStrandedSpecInProcess(client, specId, projectId, runId, message).catch(() => {});
      }
    }
  });
}

/** The reason a worker-level force-halt parks the spec (one parked-state message). */
function strandMessage(runId: string, message: string): string {
  return `run ${runId} force-halted by the worker (${message}); the spec cannot self-heal — requeue after addressing the cause`;
}

/** The `dag.spec.needs_attention` payload a worker-level strand emits (source `strand`). */
function strandNeedsAttentionPayload(runId: string, specId: string, message: string) {
  return {
    source: "strand" as const,
    specId,
    reason: "no_live_run" as const,
    terminalRuns: [{ runId, status: "halted" }],
    attempts: 1,
    message: strandMessage(runId, message),
  };
}

/**
 * Park a worker-force-halted run's spec at `needs_attention` over the control plane.
 * The guarded `setSpecStatus` (`notFromStatuses`) makes the flip a no-op when the
 * spec is already `merged` or `needs_attention`. The event is emitted ONLY when the
 * spec was still OCCUPYING a slot (`in_flight`/`review`) — so a spec the workflow's
 * own finalize already parked never gets a DUPLICATE `dag.spec.needs_attention` event
 * (the worker-level park is a safety net for crashes that bypass the workflow finalize).
 */
async function parkStrandedSpecRemote(
  pool: pg.Pool,
  writer: RunStateWriter,
  orgId: string,
  specId: string,
  projectId: string,
  runId: string,
  message: string,
): Promise<void> {
  // Read the current status FIRST: only an occupying spec (in_flight/review) is a
  // genuine strand. A spec already parked/merged/open means another finalize handled
  // it — flip nothing, emit nothing (no double-escalate).
  const occupying = await runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [specId]);
    return result.rows[0]?.status === "in_flight" || result.rows[0]?.status === "review";
  }).catch(() => false);
  if (!occupying) return;
  await writer.setSpecStatus({
    specId,
    orgId,
    status: "needs_attention",
    notFromStatuses: ["merged", "needs_attention"],
  });
  await runWithJobOrgId(orgId, () =>
    writer
      .append({
        runId,
        specId,
        projectId,
        eventType: "dag.spec.needs_attention",
        payload: strandNeedsAttentionPayload(runId, specId, message),
      })
      .catch(() => {}),
  );
}

/**
 * Park a worker-force-halted run's spec at `needs_attention` in-process (the
 * single-role path). The guarded UPDATE (`status NOT IN ('merged','needs_attention')`)
 * makes it a no-op when the spec is already terminal — idempotent with the workflow's
 * earlier park. The event append joins the in-scope transaction (org-scoped client).
 */
async function parkStrandedSpecInProcess(
  client: pg.PoolClient,
  specId: string,
  projectId: string,
  runId: string,
  message: string,
): Promise<void> {
  // Park ONLY an occupying spec (`in_flight`/`review`) — a guarded flip that RETURNS
  // the row only when it moved. A spec already parked/merged/open matches zero rows,
  // so the event is NOT emitted (idempotent with the workflow's own park — no
  // duplicate `dag.spec.needs_attention`).
  const flipped = await client.query(
    `UPDATE specs SET status = 'needs_attention'
       WHERE spec_id = $1 AND status IN ('in_flight', 'review') RETURNING spec_id`,
    [specId],
  );
  if (flipped.rowCount === 0) return;
  await new PgEventStore(client)
    .append({
      runId,
      specId,
      projectId,
      eventType: "dag.spec.needs_attention",
      payload: strandNeedsAttentionPayload(runId, specId, message),
    })
    .catch(() => {});
}

/**
 * Run a run-finalize body (UPDATE + best-effort event append) under the run's
 * org scope when the org is known, else under the EXPLICIT cross-org SYSTEM scope
 * (BYPASSRLS). Centralizes the org-scoping the two worker failure-path finalizers
 * share: a known org opens a `SET LOCAL app.current_org_id = <org>` transaction;
 * a null-org (legacy/unscoped, or a context load that itself failed before the
 * org was resolved) opens a `runWithSystemScope` transaction so the finalize +
 * its `PgEventStore(client)` write still land — never the implicit bare-pool
 * fallback (which under the `tanren_app` RLS role would silently deny the write).
 */
async function withRunFinalizeScope(
  pool: pg.Pool,
  orgId: string | null,
  body: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  if (orgId === null) {
    await runWithSystemScope(pool, (client) => body(client));
    return;
  }
  await runWithOrgScope(pool, orgId, (client) => body(client));
}
