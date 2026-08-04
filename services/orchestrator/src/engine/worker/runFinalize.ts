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

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { applyFinalizeRunWithEvent, applyUpdateSpecWithEvent } from "./runStateLifecycleSql.js";
import type { ClassifiedRunFailure } from "./runFailureClassifier.js";
import { createLogger } from "../observability/logger.js";
import { isWorkflowFinalized, rawCauseOf } from "../workflow/workflowErrorDisposition.js";
import {
  attributionAsk,
  decideRunDisposition,
  redriveBackoffSeconds,
  type RunDisposition,
} from "../workflow/runFinalizeAuthority.js";
import { causeFields, preconditionFields } from "../workflow/redriveEventFields.js";
import {
  type OrphanConsecutiveReadResult,
  readOrphanConsecutive,
  resolveOrphanConsecutive,
} from "./orphanConsecutiveReader.js";

// Re-export so tests + existing callers keep their imports pointed at `runFinalize`.
export { readOrphanConsecutive };
export type { OrphanConsecutiveReadResult };
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
  // Build the `run.failed` event payload ONCE so both paths use the SAME shape.
  // Task #48 Site C/D: the finalize UPDATE + the `run.failed` event INSERT are
  // now ATOMIC (one org-scoped transaction) — the prior split was vulnerable to
  // a crash/DB failure between them stranding the row `halted` with no
  // `run.failed` event. The `.catch(logFinalizeSwallow)` for the event-append
  // is REMOVED: atomicity replaces best-effort. A throw inside the seam now
  // rolls back the row UPDATE too, so a transient hiccup is naturally idempotent
  // (the next attempt re-tries the whole pair); the partial unique index
  // `events_run_terminal_unique` + `appendIfAbsent` dedup any retried commit.
  const runOrgId = orgId ?? (await loadRunOrgId(pool, runId, log));
  if (runOrgId === undefined) return;
  const runFailedEvent = (specId: string, projectId: string) => ({
    runId,
    specId,
    projectId,
    orgId: runOrgId,
    eventType: "run.failed" as const,
    payload: {
      status: "halted",
      failureCode: failure.code,
      stage: failure.stage,
      message: failure.summary,
      ...causeFields(failure),
    },
  });

  // When a remote writer is wired AND the run has an org, route
  // the finalize (UPDATE runs → halted) + the run.failed event through the
  // control-plane endpoints atomically. The finalize endpoint applies the SAME
  // `status IN ('running','queued','failed')` guard server-side (exactly-once),
  // and atomically appends the event when a row moved — identical to the direct path.
  if (writer !== undefined && orgId !== null) {
    // Site C: REMOTE atomic finalize. The atomic seam returns the row's
    // spec/project from RETURNING when the caller passes empty strings on the
    // event (the worker failure-path does not know them ahead of the finalize).
    const result = await writer.finalizeRunWithEvent({
      finalize: { runId, orgId, status: "halted", outcome: "halted", fromStatuses: ["running", "queued", "failed"] },
      event: runFailedEvent("", ""),
    });
    if (result.updated && result.specId !== undefined && result.specId !== "") {
      // NEVER-STRAND (apex v35): a worker-level force-halt (a crash the workflow's own
      // spec-aware finalize never reached) must not leave the spec at `in_flight` with a
      // dead run. RE-DRIVE it (spec → `open`, `dag.spec.redriven`, guarded so the
      // workflow's earlier finalize / a merged spec is a no-op) so the walker re-attempts
      // — or, at the consecutive-same-failure cap, genuine-halt `needs_attention`. The
      // crash is TRANSIENT, never a human-decision. A park FAILURE is LOGGED LOUDLY (a stranded
      // spec must never vanish silently), not swallowed.
      await parkStrandedSpecRemote(pool, writer, orgId, result.specId, result.projectId ?? "", runId, failure).catch(
        (error: unknown) => logFinalizeSwallow("stranded-spec park (remote)", { runId, specId: result.specId }, error),
      );
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
  //
  // Site D: IN-PROCESS atomic finalize. The applier sources spec/project from
  // the runs row's RETURNING when the caller passes empty strings; on a row
  // moved it appends the `run.failed` event in the SAME transaction. No
  // `.catch(logFinalizeSwallow)` — a throw rolls back the whole pair, so the
  // row is never stranded `halted` without its event.
  //
  // The `applyFinalizeRunWithEvent` input carries `orgId` only as a passthrough
  // (it is not used by the applier's row UPDATE — the caller's already-opened
  // org/system scope owns the GUC). The runs row's `org_id` is the truth the
  // event INSERT reads via `(SELECT org_id FROM projects WHERE project_id = $4)`.
  await withRunFinalizeScope(pool, orgId, async (client) => {
    const outcome = await applyFinalizeRunWithEvent(client, {
      finalize: {
        runId,
        // The applier ignores `orgId` (the caller owns the GUC scope above);
        // pass the run's org through verbatim for HTTP-parity, else a sentinel
        // for the system-scope path (the null-org / context-load-failed case).
        orgId: orgId ?? "system",
        status: "halted",
        outcome: "halted",
        fromStatuses: ["running", "queued", "failed"],
      },
      event: runFailedEvent("", ""),
    });
    if (!outcome.updated || outcome.specId === undefined || outcome.specId === "") {
      return;
    }
    const specId = outcome.specId;
    const projectId = outcome.projectId ?? "";
    // NEVER-STRAND (apex v35): RE-DRIVE the orphaned spec (→ `open` + `dag.spec.redriven`,
    // guarded so a merged spec or the workflow's earlier finalize is a no-op) so the walker
    // re-attempts — or genuine-halt at the consecutive-same-failure cap. The spec is never
    // left `in_flight` with a dead run, and a crash is TRANSIENT (re-driven, not parked). A
    // park FAILURE is LOGGED LOUDLY (a stranded spec must never vanish silently), not swallowed.
    await parkStrandedSpecInProcess(client, specId, projectId, runId, runOrgId, failure).catch((error: unknown) =>
      logFinalizeSwallow("stranded-spec park (in-process)", { runId, specId }, error),
    );
  });
}

async function loadRunOrgId(pool: pg.Pool, runId: string, l: typeof log): Promise<string | undefined> {
  const r = await runWithSystemScope(pool, (c) =>
    c.query<{ org_id: string }>("SELECT org_id FROM runs WHERE run_id = $1", [runId]),
  );
  if (r.rows[0]?.org_id === undefined) l.warn("finalizeRunRecoverable: runs row not found — skipping", { runId });
  return r.rows[0]?.org_id;
}

// UNIFIED RUN-FINALIZE (apex v35): a GENUINELY orphaned slot (a crashed run whose
// workflow finalizer never ran) is a CRASH class — TRANSIENT, so it RE-DRIVES (the spec
// returns to `open`, the walker re-enqueues a successor), emitting `dag.spec.redriven`
// rather than the old terminal `no_live_run` strand. A crash is not a human-decision; the
// build must re-attempt it, never park it. The re-drive is bounded by the SAME
// consecutive-same-failure counter the workflow path uses: the orphan reads the spec's
// prior `dag.spec.redriven` events for the current failure code, and at the cap K
// (a spec crashing the SAME way K times) genuine-HALTS to `needs_attention reason:
// persistent_failure`. This folds the old `no_live_run`/`orphaned_marker` strand reasons
// into RE-DRIVE, and the only worker-orphan path to `needs_attention` is the bounded
// persistent-failure escalation — the unified 3-bucket model, applied at the worker too.

/** The `dag.spec.redriven` payload a worker-level orphan re-drive emits (the OBSERVABLE
 * retry). The counter + backoff come from the AUTHORITY's own re-drive disposition rather
 * than being recomputed here, so a precondition block's `consecutiveSameFailure: 0` (a wait
 * is not a strike) and its fixed probe cadence carry through unaltered. */
function orphanRedrivenPayload(
  runId: string,
  specId: string,
  failure: ClassifiedRunFailure,
  redrive: Extract<RunDisposition, { bucket: "re_drive" }>,
) {
  return {
    specId,
    runId,
    failureCode: failure.code,
    stage: failure.stage,
    // The FINE-GRAINED axis the convergence readers key on now (the code stays as the
    // public contract and the fallback signature for rows written before this change).
    ...causeFields(failure),
    consecutiveSameFailure: redrive.consecutiveSameFailure,
    backoffSeconds: redrive.backoffSeconds,
    // Tagged exactly as on the planner path, so BOTH readers exempt the wait.
    ...preconditionFields(redrive.preconditionBlock),
  };
}

/** The `dag.spec.needs_attention` payload a worker-level persistent-failure escalation emits. */
function orphanPersistentPayload(
  runId: string,
  specId: string,
  failure: ClassifiedRunFailure,
  priorSameFixedPoint: number,
) {
  return {
    source: "strand" as const,
    specId,
    reason: "persistent_failure" as const,
    terminalRuns: [{ runId, status: "halted" }],
    attempts: priorSameFixedPoint + 1,
    // A halt is a BUG REPORT: name WHAT broke and WHOSE bug it is, both as structured
    // fields and inline in the ask, so the operator knows which repository to open.
    ...causeFields(failure),
    message:
      `the run reached a FIXED POINT (${failure.cause} / ${failure.code} @ ${failure.stage}: ${failure.summary}) — ` +
      `it crashed the identical way with no new information across re-drives; the spec is genuinely stuck (a bug or ` +
      `mis-spec, not a flake), so a human must intervene. ${attributionAsk(failure.attribution)} ` +
      `Requeue after addressing the cause`,
  };
}

/** Decide the orphan disposition (re-drive while progressing, genuine-halt at a fixed point).
 *
 * Hands the authority the ALREADY-CLASSIFIED failure via the `classified_error` outcome. The
 * previous shape round-tripped the classification back through a synthetic error NAME
 * (code → error-class name → `classifyRunFailure` → code) via an `OrphanFailureProxy` and a
 * `ORPHAN_PROXY_NAME_BY_CODE` table. That hop is LOSSY by construction — it can only carry
 * what the CODE alone determines — so it silently dropped the `cause`, the `attribution`
 * and, critically, the `precondition`: an orphaned run blocked on a missing credential would
 * still have parked. Removing the hop (rather than widening the table) is the fix, and it
 * deletes the table with it. */
function decideOrphan(
  failure: ClassifiedRunFailure,
  priorSameFixedPoint: number,
): Extract<RunDisposition, { bucket: "re_drive" }> | { bucket: "genuine_halt" } {
  const disposition = decideRunDisposition({ kind: "classified_error", failure }, { priorSameFixedPoint });
  if (disposition.bucket === "re_drive") return disposition;
  if (disposition.bucket === "genuine_halt") return { bucket: "genuine_halt" };
  // A `pause_for_capacity` / `converge` bucket is not a park — treat it as the orphan path
  // always has: re-drive the spec (behavior-identical to the prior proxy mapping).
  return {
    bucket: "re_drive",
    failure,
    runOutcome: "halted",
    subReason: failure.code,
    backoffSeconds: redriveBackoffSeconds(priorSameFixedPoint),
    consecutiveSameFailure: priorSameFixedPoint + 1,
  };
}

/**
 * Re-drive (or, at the cap, genuine-halt) a GENUINELY orphaned spec over the control
 * plane. Reads spec occupancy + a SUCCESSOR run + the consecutive-same-failure count in
 * one org-scoped read, then applies the unified disposition: under the cap → spec `open` +
 * `dag.spec.redriven`; at the cap → spec `needs_attention reason:persistent_failure`. A
 * spec with a fresh successor (a re-drive in flight) or not occupying a slot is skipped.
 */
async function parkStrandedSpecRemote(
  pool: pg.Pool,
  writer: RunStateWriter,
  orgId: string,
  specId: string,
  projectId: string,
  runId: string,
  failure: ClassifiedRunFailure,
): Promise<void> {
  // Read spec occupancy + the SUCCESSOR probe + the consecutive-same-failure count in ONE
  // org-scoped read. Both the outer transaction failure AND the inner readOrphanConsecutive
  // failure are surfaced via a `read_failed` discriminant on `consecutive` — NEVER silently
  // zeroed (audit C2 #1, #2). The caller then LOGS LOUDLY + forces a RE-DRIVE (never a
  // genuine-halt on unknown facts). An unreadable successor is treated as ABSENT so the
  // safety net still fires; a fresh successor re-drive is separately guarded above.
  type SlotRead = { occupying: boolean; hasSuccessor: boolean; consecutive: OrphanConsecutiveReadResult };
  const slot: SlotRead = await runWithOrgScope(pool, orgId, async (client): Promise<SlotRead> => {
    const specStatus = await client.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [specId]);
    const occupying = specStatus.rows[0]?.status === "in_flight" || specStatus.rows[0]?.status === "review";
    const successor = await client.query(SUCCESSOR_RUN_SQL, [specId, runId]);
    const consecutive = await readOrphanConsecutive(client, specId, failure);
    return { occupying, hasSuccessor: (successor.rowCount ?? 0) > 0, consecutive };
  }).catch((error: unknown): SlotRead => {
    // Audit C2 #2: the outer transaction blip previously silently returned
    // `consecutive: 0` — indistinguishable from a legitimate no-history. Now the
    // whole read is `read_failed`, so the caller defers escalation this tick.
    logFinalizeSwallow("occupancy/successor read (remote, fail-closed → re-drive)", { runId, specId }, error);
    return { occupying: true, hasSuccessor: false, consecutive: { kind: "read_failed", error } };
  });
  if (!slot.occupying) return;
  if (slot.hasSuccessor) {
    logStrandSkippedForSuccessor(runId, specId);
    return;
  }
  // Audit C2 #1/#2 — read_failed sentinel is normalized via `resolveOrphanConsecutive` +
  // forces RE-DRIVE (never genuine-halt on unknown facts) with a LOUD `log.warn`.
  const consecutive = resolveOrphanConsecutive(slot.consecutive, { runId, specId, orgId });
  const decided = decideOrphan(failure, consecutive);
  // A read failure DEFERS escalation (never a genuine-halt on unknown facts) — force the
  // re-drive shape the authority would have produced at progress.
  const disposition = slot.consecutive.kind === "read_failed" ? decideOrphan(failure, 0) : decided;
  const redrive = disposition.bucket === "re_drive";
  // Task #48 Site E / F: the spec flip + the matching event (`dag.spec.redriven`
  // or `dag.spec.needs_attention`) are now ATOMIC via the writer's
  // `updateSpecWithEvent` seam (one org-scoped transaction server-side).
  const event =
    disposition.bucket === "re_drive"
      ? {
          eventType: "dag.spec.redriven" as const,
          payload: orphanRedrivenPayload(runId, specId, failure, disposition),
        }
      : {
          eventType: "dag.spec.needs_attention" as const,
          payload: orphanPersistentPayload(runId, specId, failure, consecutive),
        };
  await writer.updateSpecWithEvent({
    spec: {
      specId,
      orgId,
      status: redrive ? "open" : "needs_attention",
      notFromStatuses: ["merged", "needs_attention"],
    },
    event: { runId, specId, projectId, orgId, ...event },
  });
}

/**
 * Re-drive (or, at the cap, genuine-halt) a GENUINELY orphaned spec in-process (the
 * single-role path). A SUCCESSOR run present ⇒ skip (a re-drive in flight). Under the cap
 * the spec returns to `open` + `dag.spec.redriven`; at the cap it parks `needs_attention
 * reason:persistent_failure`. The guarded UPDATE is the idempotency boundary.
 */
export async function parkStrandedSpecInProcess(
  client: pg.PoolClient,
  specId: string,
  projectId: string,
  runId: string,
  orgId: string,
  failure: ClassifiedRunFailure,
): Promise<void> {
  // RE-DRIVE ↔ ORPHAN ATOMICITY (apex v35 Bug 1): a fresh queued/running SUCCESSOR run ⇒
  // the spec is TRANSITIONING (a re-drive enqueued it), NOT orphaned — skip entirely.
  const successor = await client.query(SUCCESSOR_RUN_SQL, [specId, runId]);
  if ((successor.rowCount ?? 0) > 0) {
    logStrandSkippedForSuccessor(runId, specId);
    return;
  }
  const consecutiveResult = await readOrphanConsecutive(client, specId, failure);
  // Audit C2 #1 — read_failed sentinel is normalized via `resolveOrphanConsecutive`. A read
  // failure forces a RE-DRIVE this tick (never a genuine-halt on unknown facts) with a
  // LOUD `log.warn`; a genuinely-stuck spec still escalates once the DB recovers.
  const consecutive = resolveOrphanConsecutive(consecutiveResult, { runId, specId, orgId });
  // A read failure DEFERS escalation (never a genuine-halt on unknown facts) — force the
  // re-drive shape the authority would have produced at progress.
  const disposition =
    consecutiveResult.kind === "read_failed" ? decideOrphan(failure, 0) : decideOrphan(failure, consecutive);
  const redrive = disposition.bucket === "re_drive";
  // Task #48 Site G: the guarded spec flip + the matching event are now ATOMIC
  // via `applyUpdateSpecWithEvent` (the in-process mirror of the writer's
  // `updateSpecWithEvent`). The prior split (`UPDATE … RETURNING` + a
  // `.catch(logFinalizeSwallow)` event append) is replaced by ONE applier call
  // that runs the row UPDATE + event INSERT on the SAME caller client —
  // atomicity replaces best-effort.
  //
  // The applier's spec-status guard is `<> ALL`, mirroring `notFromStatuses`.
  // Site G's original guard was POSITIVE (`status IN ('in_flight','review')`) —
  // a spec OUTSIDE the occupying set (open / merged / needs_attention /
  // cancelled) was skipped. Convert to the equivalent NEGATIVE form: a spec
  // NOT in those four states is occupying + writable; both target statuses
  // share the same exclusion list (the same set the original positive
  // `in_flight,review` guard implied).
  const targetStatus = redrive ? "open" : "needs_attention";
  const notFromStatuses = ["open", "merged", "needs_attention", "cancelled"];
  const event =
    disposition.bucket === "re_drive"
      ? {
          eventType: "dag.spec.redriven" as const,
          payload: orphanRedrivenPayload(runId, specId, failure, disposition),
        }
      : {
          eventType: "dag.spec.needs_attention" as const,
          payload: orphanPersistentPayload(runId, specId, failure, consecutive),
        };
  // Sentinel `orgId` for the applier (caller owns the GUC scope); v68: EVENT carries the real org_id.
  await applyUpdateSpecWithEvent(client, {
    spec: { specId, orgId: "in-process", status: targetStatus, notFromStatuses },
    event: { runId, specId, projectId, orgId, ...event },
  });
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
