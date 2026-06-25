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
//   - A working child run emits a steady stream of GENUINE WORKER PROGRESS events
//     (writer/checker/auditor turns, run state transitions, gate verdicts, audit
//     findings, merge outcomes) — every probe that observes advancement RESETS the
//     non-advancing streak. A build that takes hours legitimately keeps polling.
//   - A retry-looping worker (the v49 `runners_pkey` case) emits ZERO meaningful
//     events between failed claims — the signature is FLAT across consecutive
//     probes. Identity stasis across `NON_ADVANCE_PROBES_BEFORE_STALL` consecutive
//     probes = STALL → halt LOUD (a `ChildRunStalledError`, surfaced to the derive
//     route boundary as a 504 naming the stalled child project id).
//
// THE SIGNAL IS A WHITELIST, NOT A `MAX(events.id)` SCAN. The naïve query
// `SELECT MAX(id) FROM events WHERE org_id = $1 AND project_id = $2` is DEFEATED by
// the build driver's OWN poll-loop: `driveToConvergence` calls
// `walker.walk(projectId)` every poll cycle (liveBuildDriver.ts), and the
// `EventEmittingDagWalker` writes `dag.drained` / `dag.concurrency.saturated` rows
// on EVERY tick that does not enqueue (walker.ts → `emitDrained` /
// `emitConcurrencySaturated`). With a poll cadence of 15 s against a probe cadence
// of 30 s (the production wire in `routes/templates/createFlow.ts`), two new
// `dag.drained` rows land between every probe — `MAX(events.id)` advances on every
// probe, the streak never accumulates, and the breaker NEVER FIRES in the apex v49
// shape it was built to catch. That is the exact #640-class disguised-heartbeat
// trap the timeout-eradication doctrine forbids
// (`docs/roadmap/timeout-eradication.md` §1, second sub-bullet: "Hang detection
// must key off the absence of ALL signs of life, never off a clock" — equivalent
// here, must key off the absence of all signs of REAL worker life, never off the
// orchestrator's own heartbeats).
//
// The signal is therefore restricted to event-type prefixes that ONLY emit on
// genuine worker / agent forward motion:
//
//   - `task.*` — agent-turn lifecycle (writer/checker/auditor turns; emitted by
//     the worker per real subtask, never on a poll/scheduler tick).
//   - `run.*` — run lifecycle transitions (queued → started → completed/failed/
//     cancelled; emitted only on a real run state change, never on poll/heartbeat).
//   - `gate.*` — gate tier outcomes (started/passed/failed/verdict; emitted from
//     gate execution, never on poll).
//   - `auditor.*` + `audit.*` — auditor findings + posture-gate routing (emitted
//     by the auditor pipeline on real verdicts, never on poll).
//   - `merge.*` — merge queue / merge outcomes (queued/completed/failed/conflict/
//     rebased/retargeted/batch.* etc.; each emitted on a real merge-queue state
//     change, never on poll).
//   - `writer.*` (apex v52/v53, task #24) — writer subtask lifecycle PLUS the new
//     `writer.subtask.progress` events the SSH ActivityWatchdog emits on every
//     probe tick its multi-signal work-signature advances (the cross-layer sign-
//     of-life bridge between the watchdog and this breaker). This is what keeps the
//     breaker streak alive on a legitimately slow writer turn whose only life
//     signal is a workspace count+bytes advance (a `pnpm install` window where
//     codex is silent for minutes while the bash subprocess runs). Each event is
//     emitted from the writer worker, never on a poll/scheduler tick — the
//     watchdog's tick cadence IS the writer's sign-of-life cadence.
//
// SUBTASK-STAGE PROGRESS (apex v56 fix #62) — the writer is NOT the only worker
// emitting genuine forward motion inside a single spec iteration. A spec on the
// `checker.rejected` → triage → `writer.subtask.started/completed` → checker
// → triage → convergence-assess cycle (the standard recovery loop on a hard
// spec like `format-lint-gate`) goes minutes between consecutive `task.*` or
// `writer.*` events, but the per-stage emissions land on every iteration:
//
//   - `checker.*` — checker stage lifecycle (started/completed/failed/verdict/
//     rejected/entity_risk). Emitted from `engine/workflow/subtaskStages.ts` per
//     real subtask check, never on a poll/scheduler tick.
//   - `planner.*` — planner stage lifecycle (started/completed/failed/rerequested/
//     subtasks.emitted). Emitted from `engine/workflow/subtaskLoop.ts` per real
//     planning round.
//   - `triage.*` — triage stage (started/completed/json). Emitted from
//     `engine/workflow/loopStages.ts` per real routing of checker/auditor/demo
//     findings, never on a poll.
//   - `convergence.*` — convergence-assessment stage (started/assessed/stalled/
//     json). Emitted from `engine/workflow/loopStages.ts` per real loop
//     iteration's converge-or-continue decision, never on a poll.
//   - `designOracle.*` — design-oracle stage (started/verdict/json). Emitted from
//     `engine/workflow/designOracleLoopStage.ts` per real oracle invocation.
//
// All five are confirmed ABSENT from `engine/dag/` (the scheduler poll path)
// — they fire only from `engine/workflow/` worker stages, so they cannot be
// faked by the build driver's poll loop. The apex v56 trial halted with a
// false-positive STALL while `format-lint-gate` was actively iterating
// writer→checker→triage rounds — none of those checker/triage hits counted
// as progress without this widening.
//
// EXCLUDED: `dag.*` (the orchestrator's OWN scheduler emissions — the defeat
// class above); `demoRun.*` / `template.*` / `recovery.*` / `cost.*` /
// `usage.*` / `credential.*` / `workspace.*` / `runner.*` / `allocator.*` /
// `release.*` / `notification.*` / `review.*` / `github.*` / `deploy.*` /
// `demo.*` / `hello.*` / `redaction.*` / `benchmark.*` / `ci.*` / `forge.*` /
// `integration.*` / `issue.*` / `spec.*` / `job.*` / `app_env.*` remain off the
// whitelist — under-exclusion (admitting a non-progress family) is recoverable
// (the breaker fires false-positive on a quiet-but-working child, surfaced by
// a follow-up test); over-exclusion is the bug this fix repairs (a stalled
// child is mis-classified as making progress and the breaker never fires, OR
// a working child whose stages don't emit one of the watched prefixes is
// mis-classified as stalled — apex v56 case #62). The 11 prefixes above are
// the confirmed-meaningful set; any future signal-class addition is an
// explicit whitelist decision (`docs/roadmap/timeout-eradication.md`), never
// a regex loosening.
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
//   - `MAX(events.id)` (UNFILTERED): defeated by the build driver's own
//     `walker.walk` poll-loop — the disguised-heartbeat trap above.
//   - `MAX(events.id) WHERE event_type ~ '^(worker progress prefix list)'`: the
//     append-only audit log, RESTRICTED to genuine worker forward motion — cannot
//     be advanced by the orchestrator's poll-loop self-emissions.
//
// The probe is a CADENCE, never a deadline: every probe that observes advancement
// resets, so it never accumulates toward a kill. A working agent runs UNBOUNDED.

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";

// PROBE CADENCE: how often to consult the child project's event-stream signature.
// A poll INTERVAL (cadence), NOT a deadline — every probe that observes advancement
// RESETS, so it never accumulates toward a kill. Not flagged by the
// timeout-eradication lint (no `_TIMEOUT_MS` / `MAX_..._ATTEMPTS` / iter-poll-tries
// patterns); no `arch-allow` annotation needed.
export const CHILD_PROGRESS_PROBE_CADENCE_MS = 30_000;

// CONSECUTIVE non-advancing probes that constitute a STALL. The signature must
// hold IDENTICAL across this many successive probes (~15 min wall-clock floor at
// the 30s cadence, but the trigger is identity, not duration — a still-flat
// signature at probe N+1 is still flat). Apex v50/v51/v52 evidence: a single
// real Codex writer turn can take 4-8 minutes (multi-step plan + tool calls +
// pnpm install + verification), and even with #21B's `dag.*` exclusion the
// breaker fires before a normal slow turn emits its terminal `task.completed` /
// `task.failed`. v52 specifically: a writer turn ran 6.4 min (21:52:03 →
// 21:58:34) and the breaker fired at 5min flat — premature, while the worker
// was still legitimately working. Bumping 10 → 30 probes pushes the floor to
// ~15 min, well past the empirical p99 for a single Codex writer turn while
// still cleanly catching a genuine "no audit-event ever" stall.
//
// Not flagged by the timeout-eradication lint (same reasoning as the cadence
// above); no `arch-allow` annotation needed.
export const NON_ADVANCE_PROBES_BEFORE_STALL = 30;

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

/**
 * Build the live signal off the events table for one (org, child project).
 *
 * The signal is `MAX(events.id)` for the child project, RESTRICTED to event-type
 * prefixes that represent genuine worker / agent FORWARD MOTION:
 * `task.*`, `run.*`, `gate.*`, `auditor.*` + `audit.*`, `merge.*`, `writer.*`,
 * and the subtask-stage families `checker.*`, `planner.*`, `triage.*`,
 * `convergence.*`, `designOracle.*` (apex v56 fix #62 — see the module-header
 * comment for the SUBTASK-STAGE PROGRESS rationale).
 *
 * The `dag.*` family is EXCLUDED — the build driver's own poll loop
 * (`driveToConvergence` calls `walker.walk(projectId)` every poll cycle) writes
 * `dag.drained` / `dag.concurrency.saturated` rows on every tick against an
 * in_flight-but-stuck spec (the apex v49 shape: `progressing >= 1`, nothing
 * pending, NOT deadlocked). Counting those as "progress" would defeat the whole
 * breaker — the streak would reset every probe and the loop would keep polling
 * forever. The exact #640-class disguised-heartbeat trap the timeout-eradication
 * doctrine forbids (`docs/roadmap/timeout-eradication.md` §1, second sub-bullet:
 * "Hang detection must key off the absence of ALL signs of life, never off a
 * clock"). The worker's organic emissions (task turns, run state transitions,
 * gate outcomes, auditor verdicts, merge events) cannot be faked by the poll
 * loop; those are the real life-signs.
 *
 * Implementation:
 *   - Reads org-scoped (the `events` table is RLS-guarded; the existing reader
 *     pattern under `engine/templates/creation/liveRecovery.ts` uses the same
 *     `runWithOrgScope(pool, orgId, …)` seam, so the breaker rides identical RLS).
 *   - `id` is `bigserial` on the schema (`db/src/schema.ts: events.id`).
 *   - The query uses `ORDER BY id DESC LIMIT 1` (instead of `MAX(id)`) so a
 *     covering index can satisfy the row lookup without a full scan; the
 *     `event_type` filter excludes the poll-loop self-emissions before the limit.
 *     On the existing `events_org_project_ts(org_id, project_id, ts)` index the
 *     planner falls back to an index scan + filter, which is the correct order of
 *     magnitude for the row counts a single child template-build generates
 *     (typically dozens, never thousands, before the build either converges or
 *     stalls).
 */
export function buildChildRunProgressSignal(pool: pg.Pool, orgId: string, childProjectId: string): ChildRunStallSignal {
  return {
    probe: async () =>
      runWithOrgScope(pool, orgId, async (client) => {
        // `ORDER BY id DESC LIMIT 1` over `(org_id, project_id)` with the
        // worker-progress allowlist filter. Cast to text so the bigserial
        // round-trips through pg as a JS string (avoiding the silent precision
        // loss node-postgres applies to bare BIGINT) — parsed to a `bigint` here
        // so the identity comparison in `driveToConvergence` is exact.
        const res = await client.query<{ max_id: string | null }>(
          `SELECT id::text AS max_id FROM events
           WHERE org_id = $1 AND project_id = $2
             AND event_type LIKE ANY($3::text[])
           ORDER BY id DESC
           LIMIT 1`,
          [orgId, childProjectId, [...WORKER_PROGRESS_EVENT_PREFIXES]],
        );
        const raw = res.rows[0]?.max_id ?? null;
        return raw === null ? undefined : BigInt(raw);
      }),
  };
}

/**
 * The whitelisted event-type prefixes — events that represent genuine worker /
 * agent forward motion. The orchestrator's own scheduler emissions (`dag.*`) are
 * deliberately ABSENT; see the module-header comment above for the full
 * justification + the inclusion/exclusion rationale.
 *
 * Exported (not just `const`) so the conformance test can assert the exact set
 * the production path uses — drift between docs and the lived filter is the
 * defect class this fix repairs.
 */
export const WORKER_PROGRESS_EVENT_PREFIXES: readonly string[] = [
  "task.%",
  "run.%",
  "gate.%",
  "auditor.%",
  "audit.%",
  "merge.%",
  // apex v52/v53 fix #24: writer.* (incl. writer.subtask.progress emitted by the SSH activity
  // watchdog on every tick its multi-signal work-signature advances) bridges the
  // sign-of-life primitive to the breaker signature, so a slow writer turn whose only
  // life signal is a pnpm-install workspace advance still keeps the breaker streak alive.
  "writer.%",
  // apex v56 fix #62: subtask-stage lifecycle families. A spec iterating on the
  // checker.rejected → triage → writer.subtask → convergence-assess loop (e.g. the
  // format-lint-gate spec on the v56 trial) emits these per real subtask round but
  // can go minutes between consecutive `task.*`/`writer.*` hits. All five are
  // emitted only from `engine/workflow/` stages, never from the orchestrator's
  // poll loop (`engine/dag/` is the defeat surface for the dag.* exclusion);
  // see the module-header SUBTASK-STAGE PROGRESS block for the audit.
  "checker.%",
  "planner.%",
  "triage.%",
  "convergence.%",
  "designOracle.%",
] as const;
