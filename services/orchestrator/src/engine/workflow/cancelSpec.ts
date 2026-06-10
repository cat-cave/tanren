// The operator cancel-spec/cancel-run write path — the human-drivable control the
// operator API lacked (the §4 fix-soon leftover from the apex pre-run audit). An
// operator who decides a spec should NOT proceed (a mis-scoped spec, a dead-end run
// burning credits) cancels it cleanly. Cancelling:
//
//   1. ATOMICALLY transitions the spec to the TERMINAL `cancelled` status (guarded so
//      ONLY a non-terminal spec flips — cancelling an already-terminal spec, incl. an
//      already-`cancelled` one, is a clean IDEMPOTENT no-op, never an error), which
//      FREES the DAG slot: the walker classifies `cancelled` as `terminal_blocked`
//      (like `merged`/`needs_attention`), so it never re-enqueues a cancelled spec.
//   2. Cancels the spec's ACTIVE run (the non-terminal `queued`/`running`/`halted`
//      run, if any) to the terminal `cancelled` run status, and RELEASES that run's
//      claimed runner through the runner-release seam (the `runners` row flips
//      `released` — the allocator's sweeper + the run-workspace reaper then reclaim
//      the sandbox now the run is terminal, so NO sandbox leaks).
//   3. Does NOT silently cascade-cancel dependents (the human-escalation discipline):
//      each direct dependent that is still live is parked at `needs_attention` (the
//      same terminal escalation a merge conflict / dead-letter uses) and emits a loud
//      `dag.spec.needs_attention` (source `cancelled_ancestor`), so a human DECIDES how
//      to proceed (re-scope the dependent, re-queue the ancestor, or cancel it too) —
//      a dependent is never silently dropped.
//   4. Emits the actor-stamped `spec.cancelled` (+ `run.cancelled` when a run was
//      cancelled) audit events, and wakes the DagWalker so the freed slot is picked up.
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
}

export interface CancelSpecResult {
  specId: string;
  projectId: string;
  /** True when the spec was actually transitioned; false on the idempotent no-op. */
  cancelled: boolean;
  /** The terminal status the spec now holds (`cancelled` on a flip; its prior terminal status on a no-op). */
  status: string;
  /** The active run cancelled alongside the spec (absent when the spec had none). */
  run?: CancelledRun;
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
      return { specId: input.specId, projectId, cancelled: false, status: found.status, dependentsParked: [] };
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
      return { specId: input.specId, projectId, cancelled: false, status, dependentsParked: [] };
    }

    const eventStore = new PgEventStore(client);

    // Cancel the spec's ACTIVE run (if any) + release its claimed runner.
    const run = await cancelActiveRun(client, eventStore, {
      specId: input.specId,
      projectId,
      cancelledBy: actor.userId,
    });

    // Park each live direct dependent at `needs_attention` (NEVER a silent cascade-cancel).
    const dependentsParked = await parkLiveDependents(client, eventStore, {
      specId: input.specId,
      projectId,
    });

    // The actor-stamped spec.cancelled audit event.
    await eventStore.append({
      specId: input.specId,
      projectId,
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
      run,
      dependentsParked,
    };
  });
}

/**
 * Cancel the spec's single ACTIVE run (the non-terminal `queued`/`running`/`halted`
 * run) and release its claimed runner. The guarded UPDATE flips at most one row; a
 * spec with no active run (all runs terminal, or never run) is a clean skip. Releasing
 * the runner flips its `runners` row `released` (the allocator-release seam's DB side)
 * so the sweeper + run-workspace reaper reclaim the sandbox now the run is terminal —
 * NO leaked sandbox.
 */
async function cancelActiveRun(
  client: pg.PoolClient,
  eventStore: PgEventStore,
  ctx: { specId: string; projectId: string; cancelledBy: string },
): Promise<CancelledRun | undefined> {
  // Read the (at most one) active run's id + status BEFORE the flip, locking the row so
  // a concurrent worker transition can't race the cancel (FOR UPDATE serializes the two
  // — the loser observes the now-`cancelled` row). A spec with no active run is a clean
  // skip.
  const active = await client.query<{ run_id: string; status: string }>(
    `SELECT run_id, status FROM runs
       WHERE spec_id = $1 AND status IN ('queued', 'running', 'halted')
       ORDER BY run_id LIMIT 1
       FOR UPDATE`,
    [ctx.specId],
  );
  const row = active.rows[0];
  if (row === undefined) {
    return undefined;
  }
  const fromStatus = row.status;
  await client.query("UPDATE runs SET status = 'cancelled' WHERE run_id = $1", [row.run_id]);

  // Release the run's claimed runner (the allocator-release seam's DB side: flip the
  // `runners` row `released`). The sweeper/reaper reclaim the sandbox now the run is
  // terminal. A run with no claimed runner (e.g. a still-`queued` run that never
  // allocated) releases nothing — recorded honestly (runnerReleased: false), never a
  // silent assumed-released.
  const runnerRow = await client.query<{ runner_id: string }>(
    "SELECT runner_id FROM runners WHERE run_id = $1 AND status = 'claimed' LIMIT 1",
    [row.run_id],
  );
  const runnerId = runnerRow.rows[0]?.runner_id;
  let runnerReleased = false;
  if (runnerId !== undefined) {
    await client.query("UPDATE runners SET status = 'released', released_at = now() WHERE runner_id = $1", [runnerId]);
    runnerReleased = true;
  }

  await eventStore.append({
    runId: row.run_id,
    specId: ctx.specId,
    projectId: ctx.projectId,
    eventType: "run.cancelled",
    payload: {
      runId: row.run_id,
      fromStatus,
      cancelledBy: ctx.cancelledBy,
      ...(runnerId === undefined ? {} : { runnerId }),
      runnerReleased,
    },
  });

  return { runId: row.run_id, fromStatus, runnerId, runnerReleased };
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
  ctx: { specId: string; projectId: string },
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
