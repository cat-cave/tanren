// SINGLE-FINALIZE INVARIANT (apex v35): a run attempt is finalized EXACTLY ONCE.
//
// The workflow (`runPlannerLoopWorkflow`) owns the FIRST, spec-aware finalize of a
// thrown run-error (`finalizeWorkflowError`): it re-drives a random/transient fault
// (#579), parks a recoverable infra fault, or escalates a genuine-terminal one — in
// EVERY case it has already set the run's terminal status AND the spec's status. The
// worker's `finalizeRunRecoverable` (`runFinalize.ts`) is the §2c safety net for a
// GENUINELY orphaned slot: a run whose workflow finalizer NEVER ran (a crash bypassing
// the spec-aware finalize), left `running` with its spec `in_flight`.
//
// The historical defect (#580's race): the workflow `catch` ALWAYS re-threw the raw
// error after finalizing — including the re-driven case — so the worker's safety-net
// strand RE-HANDLED an already-finalized run. Whether it then stranded depended on
// TIMING (the `halted` write + the successor enqueue becoming visible before the
// worker's UPDATE/probe) — a timing-sensitive double-finalize that bricked the live
// build (`dag.spec.redriven` then `dag.spec.needs_attention no_live_run` in the same
// second).
//
// The fix is an EXPLICIT signal, not a probe: when the workflow's own finalizer ran,
// the throw it re-raises is wrapped in {@link WorkflowFinalizedError}. The worker
// recognizes the wrapper and SKIPS `finalizeRunRecoverable` (the run is already
// finalized — never re-strand a validly re-driven/parked/escalated spec). A genuine
// orphan throws a RAW error (its finalizer never ran) ⇒ the worker still strands it ⇒
// the safety net is preserved, the false positive eliminated. The re-driven case does
// not even re-throw — the attempt was terminally disposed of (the successor run is the
// continuation), so the workflow returns normally.

/**
 * How the workflow's own error finalizer (`finalizeWorkflowError`) disposed of a
 * thrown run-error. EVERY disposition has already finalized BOTH the run's terminal
 * status AND the spec's status — so the worker must NOT re-finalize (strand) any of them.
 *
 *  - `re_driven` — a retriable random/transient fault (#579): run → `halted`, spec →
 *    `open`, `dag.spec.redriven`. The attempt is terminally disposed of; the walker's
 *    successor run is the continuation. The workflow returns normally (does NOT throw).
 *  - `recoverable_halt` — an ancestor-wait / workspace / usage-limit fault: run halted
 *    (or window_exhausted), spec re-opened or parked. The job still fails (re-thrown
 *    wrapped), but the run is already finalized.
 *  - `escalated` — a genuine-terminal misconfiguration / persistent same-failure: run →
 *    `failed`, spec → `needs_attention`. The job still fails (re-thrown wrapped).
 */
export type WorkflowErrorDisposition = "re_driven" | "recoverable_halt" | "escalated";

/**
 * The EXPLICIT "the workflow already finalized this run attempt" signal. The workflow
 * `catch` wraps the original error in this before re-throwing the dispositions that
 * still fail the job (`recoverable_halt` / `escalated`); the `re_driven` disposition is
 * NOT re-thrown at all (the workflow returns normally). The worker's catch keys off the
 * wrapper to SKIP `finalizeRunRecoverable` — the single-finalize invariant by an
 * explicit type, never a timing-dependent DB probe. The wrapped `cause` carries the raw
 * error forward for job-fail accounting + the internal redacted log.
 */
export class WorkflowFinalizedError extends Error {
  readonly disposition: WorkflowErrorDisposition;
  // The raw original error, preserved for `job_queue.failure_message` + the redacted
  // internal log (NEVER a public event payload). Named `cause` to match the standard
  // Error cause channel; also kept as an explicit field for the worker's classifier.
  override readonly cause: unknown;

  constructor(disposition: WorkflowErrorDisposition, cause: unknown) {
    super(`workflow finalized the run attempt (${disposition})`, { cause });
    this.name = "WorkflowFinalizedError";
    this.disposition = disposition;
    this.cause = cause;
  }
}

/** Type guard: did the workflow's own finalizer already finalize this run attempt? */
export function isWorkflowFinalized(error: unknown): error is WorkflowFinalizedError {
  return error instanceof WorkflowFinalizedError;
}

/**
 * Unwrap a {@link WorkflowFinalizedError} to its raw cause (else the error itself), so
 * the worker's job-fail classification + internal redacted log see the SAME raw error as
 * if the workflow had re-thrown it raw — the public failure vocabulary is unchanged by
 * the wrapper.
 */
export function rawCauseOf(error: unknown): unknown {
  return isWorkflowFinalized(error) ? error.cause : error;
}

/**
 * Resolve the workflow `catch` for a thrown run-error AFTER its own finalizer ran (the
 * SINGLE-FINALIZE invariant). `re_driven` ⇒ the attempt is terminally disposed of (the walker's
 * successor run is the continuation): RETURN the re-driven result normally (built by `reDriven`),
 * NEVER re-throw into the worker's strand path (the #580 double-finalize). Any other disposition
 * still FAILS the job, so re-throw WRAPPED in {@link WorkflowFinalizedError} — the worker fails
 * the job + logs yet SKIPS `finalizeRunRecoverable` (the run is already finalized; a GENUINE orphan
 * throws RAW, so the worker still strands it, #580 safety net preserved). Generic over the result
 * type so the disposition module stays decoupled from `PlannerRunResult`.
 */
export function resolveWorkflowThrow<R>(disposition: WorkflowErrorDisposition, error: unknown, reDriven: () => R): R {
  if (disposition === "re_driven") return reDriven();
  throw new WorkflowFinalizedError(disposition, error);
}
