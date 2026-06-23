// Template-creation STEP 3 — the CHILD-RUN PROGRESS PROBE (task #21B; doctrine
// extension of docs/roadmap/timeout-eradication.md).
//
// THE PROBLEM apex v49 surfaced. `driveToConvergence` (liveBuildDriver.ts) polls
// the child template-build project's DAG snapshot forever — the design is correct
// by intent (never a wall-clock kill of a build still making progress). But on v49
// a pre-session tanren-code bug presented as a runner-INSERT retry loop
// (`runners_pkey` collision between the run-executor and the job-reaper), which
// kept the spec perpetually `in_flight` — `tally.progressing >= 1`, NOT
// `isDeadlocked` — so the synchronous derive request hung for ~8 hours with no
// inner-failure circuit breaker.
//
// THE FIX — a PROGRESS / SIGN-OF-LIFE based circuit breaker that watches the child
// project's APPEND-ONLY events stream identity (a `MAX(events.id)` signature). The
// trigger is the IDENTITY of the signal across probes, NEVER elapsed time:
//
//   - A working child run emits a steady stream of events (run.*, gate.*, dag.*,
//     task.*, audit findings) — every probe that observes advancement RESETS the
//     non-advancing streak. A build that takes hours legitimately keeps polling.
//   - A retry-looping worker (the v49 `runners_pkey` case) emits ZERO events
//     between failed claims — the signature is FLAT across consecutive probes.
//     Identity stasis across `NON_ADVANCE_PROBES_BEFORE_STALL` consecutive probes
//     = STALL → halt LOUD (a `ChildRunStalledError`, surfaced to the derive route
//     boundary as a 504 naming the stalled child project id).
//
// WHY THIS SIGNAL beats the obvious alternatives (each verified against the actual
// code path, NOT picked from memory):
//
//   - `job_queue.heartbeat_at`: a worker's claim-loop ticks `heartbeat_at` on each
//     requeue — the #640 lock-file-heartbeat class would defeat it.
//   - `runs.updated_at`: a retry-looping worker updates the row on each requeue —
//     same #640 class defeat.
//   - `runs.status` transitions: do not tick between spec runs inside a multi-spec
//     child build.
//   - `MAX(events.id)`: append-only audit log; emitted ONLY on meaningful work —
//     no call site advances it on a silent failure path.
//
// The probe is a CADENCE, never a deadline: every probe that observes advancement
// resets, so it never accumulates toward a kill. A working agent runs UNBOUNDED.

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";

// PROBE CADENCE: how often to consult the child project's event-stream signature.
// A poll INTERVAL (cadence), NOT a deadline — every probe that observes advancement
// RESETS, so it never accumulates toward a kill.
// arch-allow: timeout-class — probe CADENCE for the child-run progress signature;
// trigger is signal IDENTITY across probes, never elapsed time.
export const CHILD_PROGRESS_PROBE_CADENCE_MS = 30_000;

// CONSECUTIVE non-advancing probes that constitute a STALL. The signature must
// hold IDENTICAL across this many successive probes (~5 min wall-clock floor, but
// the trigger is identity, not duration — a still-flat signature at probe N+1 is
// still flat).
// arch-allow: timeout-class — non-advance streak ceiling; identity-based, not
// elapsed-time-based. Same class as runHeartbeat.ts atRiskThreshold.
export const NON_ADVANCE_PROBES_BEFORE_STALL = 10;

// The child-run progress signal: a single `probe()` call returns the current
// IDENTITY of the child project's append-only event stream. `undefined` means
// "no events yet" (an empty child project, before its DAG has emitted anything);
// successive `undefined` returns ARE a flat signature (and would be a stall if
// the project never starts emitting), but a child project the build driver is
// polling has at minimum `dag.*` events from the very first walk.
export interface ChildRunStallSignal {
  probe: () => Promise<bigint | undefined>;
}

// Thrown by `driveToConvergence` when the child template-build project's
// append-only event stream identity has held flat across
// `NON_ADVANCE_PROBES_BEFORE_STALL` consecutive probes. The error names the
// stalled child project id + the last observed signature value so the derive
// HTTP-boundary handler can surface them directly to the operator. The build
// driver wraps this in `TemplateBuildFailedError(cause: this)`; the route layer
// walks the `cause` chain to recognize the stall.
export class ChildRunStalledError extends Error {
  readonly childProjectId: string;
  readonly lastSignatureValue: bigint | undefined;
  readonly nonAdvancingProbes: number;
  constructor(childProjectId: string, lastSignature: bigint | undefined, nonAdvancingProbes: number) {
    super(
      `child template-build project ${childProjectId} STALLED — no audit-event ` +
        `progress across ${String(nonAdvancingProbes)} consecutive ` +
        `${String(CHILD_PROGRESS_PROBE_CADENCE_MS / 1000)}s probes ` +
        `(last events.id=${String(lastSignature ?? "none")}). ` +
        `The child run is alive in the DB (lease may still tick) but produces no ` +
        `meaningful forward motion — likely retry-looping on a runner-INSERT or ` +
        `similarly silent failure. Loud halt; never a wall-clock kill.`,
    );
    this.name = "ChildRunStalledError";
    this.childProjectId = childProjectId;
    this.lastSignatureValue = lastSignature;
    this.nonAdvancingProbes = nonAdvancingProbes;
  }
}

// Build the LIVE progress signal over the events table for one (org, child project).
// Reads `MAX(events.id)` org-scoped (the `events` table is RLS-guarded; the existing
// reader pattern under engine/templates/creation/liveRecovery.ts uses the SAME
// `runWithOrgScope(pool, orgId, …)` seam, so the breaker rides identical RLS).
// `id` is `bigserial` on the schema (db/src/schema.ts: `events.id`); the
// `events_org_project_ts` index (db/src/schema.ts) supports the projection
// efficiently — the planner uses the index to find the max id per (org, project).
export function buildChildRunProgressSignal(pool: pg.Pool, orgId: string, childProjectId: string): ChildRunStallSignal {
  return {
    probe: async () =>
      runWithOrgScope(pool, orgId, async (client) => {
        // `MAX(id)` over `(org_id, project_id)`. Cast to text so the bigserial
        // round-trips through pg as a JS string (avoiding the silent precision loss
        // node-postgres applies to bare BIGINT) — parsed to a `bigint` here so the
        // identity comparison in `driveToConvergence` is exact.
        const res = await client.query<{ max_id: string | null }>(
          `SELECT MAX(id)::text AS max_id FROM events
           WHERE org_id = $1 AND project_id = $2`,
          [orgId, childProjectId],
        );
        const raw = res.rows[0]?.max_id ?? null;
        return raw === null ? undefined : BigInt(raw);
      }),
  };
}
