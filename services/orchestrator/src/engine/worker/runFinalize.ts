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
import { scalarTextOr } from "../data/scalarText.js";
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { PgEventStore } from "../eventStore.js";
import type { ClassifiedRunFailure } from "./runFailureClassifier.js";
import { createLogger } from "../observability/logger.js";
import { isWorkflowFinalized, rawCauseOf } from "../workflow/workflowErrorDisposition.js";
// Re-exported so runExecutor (which already imports finalizeRunRecoverable here)
// gets the logger factory + the WorkflowFinalizedError unwrap WITHOUT separate imports
// (its dependency cap is at 12). `rawCauseOf` lets the worker classify the raw cause.
export { createLogger, rawCauseOf };

const log = createLogger("run-finalize");

// A finalize-path best-effort write (event append / spec park / occupancy read)
// is allowed to FAIL without masking the original run-failure path it runs
// inside — but the failure must NOT be SILENT (silent-fallback hardening, finding
// 8): a swallowed spec-park can leave a spec stuck `in_flight` with a dead run,
// invisible to the operator. Each swallow now logs LOUDLY (run/spec id + cause)
// so a stranded spec is at least surfaced rather than vanishing without trace.
function logFinalizeSwallow(op: string, ids: { runId: string; specId?: string }, error: unknown): void {
  log.error(
    "finalize step failed (best-effort, surfaced)",
    { op, runId: ids.runId, ...(ids.specId !== undefined && ids.specId !== "" && { specId: ids.specId }) },
    error,
  );
}

// RE-DRIVE ↔ ORPHAN-RECONCILER ATOMICITY (apex v35 Bug 1). The worker-level
// force-halt is the §2c safety net for a GENUINELY orphaned slot: a run that died
// (a crash bypassing the workflow's own spec-aware finalize) leaving its spec
// `in_flight` with NO live run. But it MUST NOT fire in the RACE WINDOW of a
// re-drive (#579): the workflow re-drive RELEASES the failed run and ENQUEUES a
// successor run (`run.queued` + `dag.spec.enqueued`), and for a brief window the
// spec occupies a slot while its successor run is still `queued`/`running` (not yet
// "live"). A re-driven spec with a fresh successor run is TRANSITIONING, not
// orphaned — stranding it `no_live_run` is the false positive that bricked the live
// build. So before stranding we check for a SUCCESSOR run: a run for THIS spec,
// distinct from the failing one, still in a startup/live state (`queued`/`running`).
// A successor present ⇒ recognize the queued/enqueued startup state as VALID
// occupancy and SKIP the strand (logged observably). A successor ABSENT ⇒ the slot
// is GENUINELY orphaned (a dead run with no queued successor) and we still strand —
// the safety net is preserved, only the false positive removed.
const SUCCESSOR_RUN_SQL =
  "SELECT 1 FROM runs WHERE spec_id = $1 AND run_id <> $2 AND status IN ('queued', 'running') LIMIT 1";

/** Log that a spec's strand was SKIPPED because a successor run is transitioning it (re-drive). */
function logStrandSkippedForSuccessor(runId: string, specId: string): void {
  log.info("orphan-strand SKIPPED — spec has a fresh successor run (re-drive in flight, not orphaned)", {
    runId,
    specId,
  });
}

/**
 * Force a run that a failed workflow left in a non-recoverable terminal state
 * (`failed`) or still `running` (crash) into a recoverable `halted` outcome so
 * it lands on the recovery surface (`RECOVERABLE_OUTCOMES`). A run the workflow
 * already finalized as recoverable (halted / window_exhausted /
 * retry_budget_exhausted) or terminal-good (`done`) is left untouched.
 *
 * SINGLE-FINALIZE INVARIANT (apex v35): this is the §2c safety net for a GENUINELY
 * orphaned slot ONLY — a run whose workflow finalizer NEVER ran (a crash, the error
 * escaping RAW). `originalError` being a {@link WorkflowFinalizedError} is the EXPLICIT
 * signal that the workflow already finalized this attempt (re-drove → returned normally,
 * so it never reaches here; parked / escalated → re-thrown wrapped): re-finalizing it is
 * the double-finalize that stranded a just-re-driven spec `no_live_run` (#580). So a
 * wrapped error SHORT-CIRCUITS this safety net — keyed off the type, never a timing probe.
 */
export async function finalizeRunRecoverable(
  pool: pg.Pool,
  writer: RunStateWriter | undefined,
  runId: string,
  // The PUBLIC-SAFE classified failure (code + stage + a FIXED safe summary). The
  // worker classifies the raw caught error BEFORE calling here so the public
  // `run.failed` + `dag.spec.needs_attention` events never carry the raw string;
  // the raw detail lives off the public path (job_queue.failure_message + a log).
  failure: ClassifiedRunFailure,
  orgId: string | null,
  // The ORIGINAL caught error (the wrapper or the raw cause). A `WorkflowFinalizedError`
  // means the workflow already finalized the run+spec ⇒ skip this safety-net strand.
  originalError?: unknown,
): Promise<void> {
  // SINGLE-FINALIZE: the workflow already finalized this attempt (run AND spec) ⇒ the
  // safety net must NOT re-finalize/re-strand it. A genuine orphan throws RAW ⇒ proceed.
  if (isWorkflowFinalized(originalError)) {
    log.info("orphan-finalize SKIPPED — the workflow already finalized this run attempt", {
      runId,
      disposition: originalError.disposition,
    });
    return;
  }
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
            payload: { status: "halted", failureCode: failure.code, stage: failure.stage, message: failure.summary },
          })
          .catch((error: unknown) => logFinalizeSwallow("run.failed append (remote)", { runId }, error)),
      );
      // NEVER-STRAND (finding #3): a worker-level force-halt (a crash the workflow's
      // own spec-aware finalize never reached) must not leave the spec at `in_flight`
      // with a dead run. Park it at `needs_attention` (guarded so the workflow's
      // earlier park / a merged spec is a no-op) so the slot frees + the operator can
      // requeue it. Best-effort — but a park FAILURE is LOGGED LOUDLY (a stranded
      // spec must never vanish silently), not swallowed.
      if (result.specId !== undefined && result.specId !== "") {
        await parkStrandedSpecRemote(
          pool,
          writer,
          orgId,
          result.specId,
          result.projectId ?? "",
          runId,
          failure.summary,
        ).catch((error: unknown) =>
          logFinalizeSwallow("stranded-spec park (remote)", { runId, specId: result.specId }, error),
        );
      }
    }
    return;
  }
  // RLS R2 cohort-3 (worker failure-path finalizer): when the run's org is known
  // (resolved from its execution context), run the finalize UPDATE + the
  // run.failed event in ONE org-scoped transaction so both writes carry org
  // context (`SET LOCAL app.current_org_id = <orgId>`). The catch path previously
  // ran with NO ambient scope; this establishes one. A system / null-org job
  // (org_id NULL) — or a context load that itself failed — falls back to the pool,
  // the pre-cohort-3 behavior. Inert in R1; RLS-correct in R3.
  await withRunFinalizeScope(pool, orgId, async (client) => {
    const updated = await client.query(
      "UPDATE runs SET status = 'halted', outcome = 'halted', ended_at = now() WHERE run_id = $1 AND status IN ('running', 'queued', 'failed') RETURNING run_id, spec_id, project_id",
      [runId],
    );
    const row = updated.rows[0] as { spec_id?: unknown; project_id?: unknown } | undefined;
    if (row !== undefined) {
      const specId = scalarTextOr(row.spec_id, "");
      const projectId = scalarTextOr(row.project_id, "");
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
          payload: { status: "halted", failureCode: failure.code, stage: failure.stage, message: failure.summary },
        })
        .catch((error: unknown) => logFinalizeSwallow("run.failed append (in-process)", { runId }, error));
      // NEVER-STRAND (finding #3): park the spec at `needs_attention` (guarded so a
      // merged spec or the workflow's earlier park is a no-op) so a worker-level
      // force-halt frees the DAG slot + the operator can requeue it — the spec is
      // never left `in_flight` with a dead run. A park FAILURE is LOGGED LOUDLY (a
      // stranded spec must never vanish silently), not swallowed.
      if (specId !== "") {
        await parkStrandedSpecInProcess(client, specId, projectId, runId, failure.summary).catch((error: unknown) =>
          logFinalizeSwallow("stranded-spec park (in-process)", { runId, specId }, error),
        );
      }
    }
  });
}

// The reason a worker-level force-halt parks the spec (one parked-state message).
// `summary` is the PUBLIC-SAFE classified failure summary (never the raw caught-error
// string) — this is a public `dag.spec.needs_attention.message`, so it must not leak.
function strandMessage(runId: string, summary: string): string {
  return `run ${runId} force-halted by the worker (${summary}); the spec cannot self-heal — requeue after addressing the cause`;
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
  // Read the spec status + check for a SUCCESSOR run in ONE org-scoped read:
  //  - `occupying`: only an `in_flight`/`review` spec is a candidate strand. A spec
  //    already parked/merged/open means another finalize handled it — skip.
  //  - `hasSuccessor` (apex v35 Bug 1): a re-drive (#579) RELEASES the failed run and
  //    ENQUEUES a successor run, briefly leaving the spec occupying a slot while the
  //    successor is still `queued`/`running`. Such a spec is TRANSITIONING, not
  //    orphaned — DO NOT strand it. Only a slot with NO live successor is genuinely
  //    orphaned (the safety net's true target).
  // FAIL-CLOSED on a read FAILURE toward stranding the occupying spec (a genuinely
  // stranded spec must never vanish), but treat an unreadable successor as ABSENT so
  // the genuine-orphan strand still fires; `setSpecStatus`'s `notFromStatuses` guard
  // keeps the park a safe no-op if the spec is not actually a strand.
  const slot = await runWithOrgScope(pool, orgId, async (client) => {
    const specStatus = await client.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [specId]);
    const occupying = specStatus.rows[0]?.status === "in_flight" || specStatus.rows[0]?.status === "review";
    const successor = await client.query(SUCCESSOR_RUN_SQL, [specId, runId]);
    return { occupying, hasSuccessor: (successor.rowCount ?? 0) > 0 };
  }).catch((error: unknown) => {
    logFinalizeSwallow(
      "occupancy/successor read (remote, fail-closed → attempting guarded park)",
      { runId, specId },
      error,
    );
    return { occupying: true, hasSuccessor: false };
  });
  if (!slot.occupying) return;
  if (slot.hasSuccessor) {
    logStrandSkippedForSuccessor(runId, specId);
    return;
  }
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
      .catch((error: unknown) =>
        logFinalizeSwallow("dag.spec.needs_attention append (remote)", { runId, specId }, error),
      ),
  );
}

/**
 * Park a worker-force-halted run's spec at `needs_attention` in-process (the
 * single-role path). The guarded UPDATE (`status NOT IN ('merged','needs_attention')`)
 * makes it a no-op when the spec is already terminal — idempotent with the workflow's
 * earlier park. The event append joins the in-scope transaction (org-scoped client).
 */
export async function parkStrandedSpecInProcess(
  client: pg.PoolClient,
  specId: string,
  projectId: string,
  runId: string,
  message: string,
): Promise<void> {
  // RE-DRIVE ↔ ORPHAN ATOMICITY (apex v35 Bug 1): if a SUCCESSOR run is already
  // queued/running for this spec, the spec is TRANSITIONING (a re-drive enqueued a
  // new run), NOT orphaned — skip the strand entirely (the successor's own finalize
  // governs it). Only a slot with NO live successor is genuinely orphaned.
  const successor = await client.query(SUCCESSOR_RUN_SQL, [specId, runId]);
  if ((successor.rowCount ?? 0) > 0) {
    logStrandSkippedForSuccessor(runId, specId);
    return;
  }
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
    .catch((error: unknown) =>
      logFinalizeSwallow("dag.spec.needs_attention append (in-process)", { runId, specId }, error),
    );
}

/**
 * Run a run-finalize body (UPDATE + best-effort event append) under the run's
 * org scope when the org is known, else under the EXPLICIT cross-org SYSTEM scope
 * (BYPASSRLS). Centralizes the org-scoping the two worker failure-path finalizers
 * share: a known org opens a `SET LOCAL app.current_org_id = <org>` transaction;
 * a null-org (a system / null-org job, or a context load that itself failed before the
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
