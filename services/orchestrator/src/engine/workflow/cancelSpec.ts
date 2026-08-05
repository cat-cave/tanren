// The operator cancel-spec/cancel-run write path — the human-drivable control the
// operator API lacked (the §4 fix-soon leftover from the pre-run audit). An
// operator who decides a spec should NOT proceed (a mis-scoped spec, a dead-end run
// burning credits) cancels it cleanly. Cancelling:
//
//   1. ATOMICALLY transitions the spec to the TERMINAL `cancelled` status (guarded so
//      ONLY a non-terminal spec flips — cancelling an already-terminal spec, incl. an
//      already-`cancelled` one, is a clean IDEMPOTENT no-op, never an error), which
//      FREES the DAG slot: the walker classifies `cancelled` as `terminal_blocked`
//      (like `merged`/`needs_attention`), so it never re-enqueues a cancelled spec.
//   2. Cancels EVERY non-terminal run of the spec (`queued`/`running`/`paused`/
//      `halted`) to the terminal `cancelled` run status, REAPS each run's live
//      `job_queue` rows to the terminal `cancelled` job status, and RELEASES each of
//      their claimed runners through the runner-release seam (the `runners` row flips
//      `released` — the allocator's sweeper + the run-workspace reaper then reclaim the
//      sandbox now the run is terminal, so NO sandbox leaks). NOT "the at-most-one
//      active run": a re-driven spec accumulates `halted` runs, so the set is routinely
//      larger than one and picking a single member cancels the wrong run.
//   3. Does NOT silently cascade-cancel dependents (the human-escalation discipline):
//      each direct dependent that is still live is parked at `needs_attention` (the
//      same terminal escalation a merge conflict / dead-letter uses) and emits a loud
//      `dag.spec.needs_attention` (source `cancelled_ancestor`), so a human DECIDES how
//      to proceed (re-scope the dependent, re-queue the ancestor, or cancel it too) —
//      a dependent is never silently dropped.
//   4. Emits the actor-stamped `spec.cancelled` (+ one `run.cancelled` per cancelled
//      run) audit events, and wakes the DagWalker so the freed slot is picked up.
//
// Org-scoped under RLS (the actor MUST carry the project's org); fail-closed (a
// missing org / an invisible spec is a hard SpecNotFoundError, never a silent skip).

import { notifyDagChanged, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { PgEventStore } from "../eventStore.js";
import { ProjectAccessDeniedError, SpecNotFoundError } from "./projectSpecErrors.js";

/** The terminal spec statuses a cancel is a no-op against (already settled). */
const TERMINAL_SPEC_STATUSES = ["merged", "cancelled", "halted", "needs_attention"] as const;

/** A run cancelled as part of the spec cancel, with its runner-release outcome. */
export interface CancelledRun {
  runId: string;
  fromStatus: string;
  runnerId?: string;
  runnerReleased: boolean;
  /**
   * The run's live `job_queue` rows reaped to the terminal `cancelled` job status
   * (ids, in queue order). Empty when the run had no live queue row. Recorded
   * HONESTLY so a surviving claimable row is never silently assumed away — a
   * cancel that leaves one behind is a cancel that a worker restart can undo.
   */
  jobsCancelled: string[];
}

export interface CancelSpecResult {
  specId: string;
  projectId: string;
  /** True when the spec was actually transitioned; false on the idempotent no-op. */
  cancelled: boolean;
  /** The terminal status the spec now holds (`cancelled` on a flip; its prior terminal status on a no-op). */
  status: string;
  /**
   * EVERY non-terminal run cancelled alongside the spec, oldest first. Empty when the
   * spec had none. A LIST, not an optional single run: a re-driven spec accumulates
   * non-terminal (`halted`) runs, and the operator is cancelling the SPEC — every run
   * of it must settle, or the survivors are stranded non-terminal forever (the spec is
   * now terminal, so a second cancel is a documented idempotent no-op).
   */
  runs: CancelledRun[];
  /** Direct dependents parked at `needs_attention` because their ancestor was cancelled. */
  dependentsParked: string[];
}

/**
 * Cancel a spec (and its active run) cleanly. Org-scoped under RLS, idempotent, and
 * fail-closed. Returns the (idempotent) outcome; throws only on a genuinely absent /
 * cross-org-invisible spec (`SpecNotFoundError`) or an actor missing its org
 * (`ProjectAccessDeniedError` — the route's auth gate guarantees an org-carrying actor).
 */
export async function cancelSpec(
  pool: pg.Pool,
  input: { specId: string },
  actor: ActorContext,
): Promise<CancelSpecResult> {
  const orgId = actor.orgId;
  if (orgId === undefined || orgId === null) {
    // The route's org-admin gate guarantees an org-carrying actor; defend the seam.
    throw new ProjectAccessDeniedError(input.specId);
  }
  return runWithOrgScope(pool, orgId, async (client) => {
    // Load the spec under the org scope (RLS: a spec in another org is invisible →
    // SpecNotFoundError, never a leak).
    const specRow = await client.query<{ project_id: string; status: string }>(
      "SELECT project_id, status FROM specs WHERE spec_id = $1",
      [input.specId],
    );
    const found = specRow.rows[0];
    if (found === undefined) {
      throw new SpecNotFoundError(input.specId);
    }
    const projectId = found.project_id;

    // IDEMPOTENT no-op: an already-terminal spec (merged / cancelled / halted /
    // needs_attention) is a clean no-op, NOT an error. Return its current terminal
    // status so a repeated cancel is safely repeatable.
    if ((TERMINAL_SPEC_STATUSES as readonly string[]).includes(found.status)) {
      return {
        specId: input.specId,
        projectId,
        cancelled: false,
        status: found.status,
        runs: [],
        dependentsParked: [],
      };
    }

    // ATOMIC guarded flip: re-check the non-terminal status set IN the UPDATE so a
    // concurrent settle (a merge landing, a second operator cancelling) flips exactly
    // once — the loser matches zero rows and returns the idempotent no-op.
    const flip = await client.query<{ spec_id: string }>(
      `UPDATE specs SET status = 'cancelled'
         WHERE spec_id = $1 AND status NOT IN ('merged', 'cancelled', 'halted', 'needs_attention')
       RETURNING spec_id`,
      [input.specId],
    );
    if (flip.rowCount === 0) {
      // Lost the race — re-read the now-terminal status and return the no-op.
      const after = await client.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [
        input.specId,
      ]);
      const status = after.rows[0]?.status ?? found.status;
      return { specId: input.specId, projectId, cancelled: false, status, runs: [], dependentsParked: [] };
    }

    const eventStore = new PgEventStore(client);

    // Cancel EVERY non-terminal run of the spec + release each claimed runner.
    const runs = await cancelNonTerminalRuns(client, eventStore, {
      specId: input.specId,
      projectId,
      orgId,
      cancelledBy: actor.userId,
    });

    // Park each live direct dependent at `needs_attention` (NEVER a silent cascade-cancel).
    const dependentsParked = await parkLiveDependents(client, eventStore, {
      specId: input.specId,
      projectId,
      orgId,
    });

    // The actor-stamped spec.cancelled audit event. `orgId` is the actor's (validated
    // non-null above) — events.org_id is NOT NULL (v68 fix; AppendEventInput requires
    // explicit orgId rather than the prior derive-from-project subquery).
    await eventStore.append({
      specId: input.specId,
      projectId,
      orgId,
      eventType: "spec.cancelled",
      payload: {
        specId: input.specId,
        fromStatus: found.status,
        cancelledBy: actor.userId,
        dependentsParked,
      },
    });

    // Wake the DagWalker: a freed slot lets a ready sibling enqueue (the cancel removed
    // an in-flight occupant); rides this tx's COMMIT.
    await notifyDagChanged(client, projectId);

    return {
      specId: input.specId,
      projectId,
      cancelled: true,
      status: "cancelled",
      runs,
      dependentsParked,
    };
  });
}

/**
 * Cancel EVERY non-terminal run of the spec, REAP each run's live `job_queue` rows, and
 * release each of their claimed runners.
 *
 * NOT "the at-most-one active run" — that premise was false, and it made the documented
 * way to stop a runaway run report success without stopping it. Three faults in one
 * predicate:
 *
 *   1. `halted` is NON-TERMINAL and ACCUMULATES. `allowedRunTransitions` has
 *      `halted: ["running", "cancelled"]`, and the run-failure boundary re-drives a
 *      transient fault by reopening the spec and starting a SUCCESSOR run — leaving the
 *      predecessor `halted` forever. A spec re-driven a few times therefore has many
 *      matching rows. Observed live: SEVEN — six `halted` plus the one `running`.
 *   2. `ORDER BY run_id LIMIT 1` then picked one of them ARBITRARILY. `runs.run_id` is a
 *      `text` id with a random suffix, so its lexicographic order carries no relation to
 *      recency or liveness. The live run was selected only by luck. Observed: the cancel
 *      returned `cancelled: true` naming a DAY-OLD `halted` run while the actually-
 *      executing run kept burning credits for another six minutes.
 *   3. `paused` was MISSING from the predicate although it is non-terminal, and
 *      `state/run.ts` states "the operator-cancel path is the only `paused`-terminal
 *      exit". The sole documented exit did not select the status it was the exit for.
 *
 * And the operator gets no second attempt: the caller flips the SPEC terminal in this
 * same transaction, so a retried cancel is an idempotent no-op. One wrong pick is
 * permanent.
 *
 * Cancelling the SET is the honest shape rather than picking a better single row: the
 * operator is cancelling the spec, so every run of it must settle. There is no reason to
 * choose. The status set is exactly the non-terminal half of the run state machine, and
 * the ordering is `started_at` — a real recency signal, and a deterministic lock order.
 */
async function cancelNonTerminalRuns(
  client: pg.PoolClient,
  eventStore: PgEventStore,
  ctx: { specId: string; projectId: string; orgId: string; cancelledBy: string },
): Promise<CancelledRun[]> {
  // Lock ALL of them before flipping, so a concurrent worker transition can't race the
  // cancel (FOR UPDATE serializes the two — the loser observes the now-`cancelled` row).
  // A spec with no non-terminal run is a clean skip. `ORDER BY started_at, run_id` gives
  // a deterministic lock order (no deadlock against a concurrent cancel) and a stable,
  // oldest-first result.
  const active = await client.query<{ run_id: string; status: string }>(
    `SELECT run_id, status FROM runs
       WHERE spec_id = $1 AND status IN ('queued', 'running', 'paused', 'halted')
       ORDER BY started_at ASC, run_id ASC
       FOR UPDATE`,
    [ctx.specId],
  );

  const cancelled: CancelledRun[] = [];
  for (const row of active.rows) {
    const fromStatus = row.status;
    await client.query("UPDATE runs SET status = 'cancelled' WHERE run_id = $1", [row.run_id]);

    // REAP the run's live `job_queue` rows to the terminal `cancelled` job status.
    //
    // WITHOUT this the cancel is NOT DURABLE. `runs.status` is not on the claim path:
    // `JobQueue.claim` selects purely on `task_kind` + `status = 'queued'`, and the
    // lease reaper (`reapExpiredLeases`) requeues ANY `running` row whose lease lapsed —
    // neither joins the owning run. So a cancelled run's queue row survives the cancel,
    // the worker that dies/restarts while holding it lets its lease lapse, the reaper
    // returns it to `queued`, and the next claim RESURRECTS the cancelled run. The
    // DagWalker's terminal-status guard never sees it: the walker gates ENQUEUE, and
    // this row was already enqueued.
    //
    // Flipping the row terminal closes both doors at once: `cancelled` is not `queued`
    // (never claimed) and not `running` (never reaped), and it is a legal transition
    // from every live status (see engine/state/job.ts). `leased_until = NULL` drops the
    // lease so the row also leaves the reaper's partial index.
    const reaped = await client.query<{ id: string }>(
      `UPDATE job_queue
          SET status = 'cancelled', ended_at = now(), leased_until = NULL
        WHERE run_id = $1 AND status IN ('queued', 'claimed', 'running')
      RETURNING id::text AS id`,
      [row.run_id],
    );
    // `job_queue.id` is a bigserial rendered as text: sort NUMERICALLY but via BigInt,
    // since an id past Number.MAX_SAFE_INTEGER would compare wrong under `Number()`.
    const jobsCancelled = reaped.rows
      .map((jobRow) => jobRow.id)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));

    // Release the run's claimed runner (the allocator-release seam's DB side: flip the
    // `runners` row `released`). The sweeper/reaper reclaim the sandbox now the run is
    // terminal. A run with no claimed runner (e.g. a still-`queued` run that never
    // allocated, or a long-`halted` one whose runner went back to the pool) releases
    // nothing — recorded honestly (runnerReleased: false), never a silent assumed-released.
    const runnerRow = await client.query<{ runner_id: string }>(
      "SELECT runner_id FROM runners WHERE run_id = $1 AND status = 'claimed' LIMIT 1",
      [row.run_id],
    );
    const runnerId = runnerRow.rows[0]?.runner_id;
    let runnerReleased = false;
    if (runnerId !== undefined) {
      await client.query("UPDATE runners SET status = 'released', released_at = now() WHERE runner_id = $1", [
        runnerId,
      ]);
      runnerReleased = true;
    }

    // One `run.cancelled` per run. The event is already per-run, so the payload shape is
    // unchanged — a consumer sees N events instead of silently missing N-1 cancellations.
    //
    // `appendIfAbsent`, not `append`: `run.cancelled` is covered by the partial unique
    // index `events_run_terminal_unique (run_id, event_type)`, so a duplicate INSERT
    // raises and would roll back the WHOLE cancel — spec flip, every run flip, every
    // runner release. Cancelling N runs multiplies that exposure by N, so the at-most-once
    // insert matters more here than it did on the single-run path. Both NOTIFYs still fire
    // on the landing path, so the SSE/dispatcher behaviour is unchanged; a `false` return
    // means this run's terminal event was already recorded, which does not change the fact
    // that this transaction flipped the run.
    await eventStore.appendIfAbsent({
      runId: row.run_id,
      specId: ctx.specId,
      projectId: ctx.projectId,
      orgId: ctx.orgId,
      eventType: "run.cancelled",
      payload: {
        runId: row.run_id,
        fromStatus,
        cancelledBy: ctx.cancelledBy,
        ...(runnerId === undefined ? {} : { runnerId }),
        runnerReleased,
        jobsCancelled,
      },
    });

    cancelled.push({ runId: row.run_id, fromStatus, runnerId, runnerReleased, jobsCancelled });
  }

  return cancelled;
}

/**
 * Park each LIVE direct dependent of the cancelled spec at `needs_attention` (the
 * human-escalation discipline — never a silent cascade-cancel). A direct dependent is a
 * spec whose `depends_on` array contains the cancelled spec id. Only non-terminal
 * dependents are parked (a guarded flip — an already-terminal dependent is left
 * untouched); each parked dependent emits a loud `dag.spec.needs_attention`
 * (source `cancelled_ancestor`) so a human decides how to proceed.
 */
async function parkLiveDependents(
  client: pg.PoolClient,
  eventStore: PgEventStore,
  ctx: { specId: string; projectId: string; orgId: string },
): Promise<string[]> {
  const parked = await client.query<{ spec_id: string }>(
    `UPDATE specs SET status = 'needs_attention'
       WHERE $1 = ANY(depends_on)
         AND status NOT IN ('merged', 'cancelled', 'halted', 'needs_attention')
     RETURNING spec_id`,
    [ctx.specId],
  );
  const dependentIds = parked.rows.map((row) => row.spec_id);
  for (const dependentId of dependentIds) {
    await eventStore.append({
      specId: dependentId,
      projectId: ctx.projectId,
      orgId: ctx.orgId,
      eventType: "dag.spec.needs_attention",
      payload: {
        source: "cancelled_ancestor",
        specId: dependentId,
        cancelledAncestorSpecId: ctx.specId,
        message:
          `ancestor ${ctx.specId} was cancelled by an operator — this dependent cannot ` +
          `proceed on the cancelled work. Decide how to continue (re-scope this spec, ` +
          `re-queue the ancestor, or cancel this spec too).`,
      },
    });
  }
  return dependentIds;
}
