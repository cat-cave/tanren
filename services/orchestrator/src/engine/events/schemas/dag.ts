import { z } from "zod";

// DagWalker events (autonomy-engine.md §1a). The DagWalker is a per-project
// background SCHEDULER over the existing run executor: on startup and on every
// run.*-terminal / merge.completed notification for the project it loads the spec
// DAG, computes the ready set (pending specs whose dependencies are all DONE),
// and enqueues up to the governed concurrency headroom of ready specs via the
// existing createQueuedRunFromSpec path. These events make that autonomous
// scheduling decision VISIBLE — every spec the walker auto-enqueues, every time
// the DAG drains, and every time the walker pauses for lack of budget headroom.
//
// Milestones are LABELS, never gates: the walker never pauses at a milestone
// boundary, so there is no milestone event here — only the real scheduling
// outcomes (enqueued / drained / budget-paused).

// dag.spec.enqueued: the walker auto-selected a ready spec and enqueued a run for
// it through createQueuedRunFromSpec (the SAME path an operator's manual trigger
// uses). Carries the new run id + the spec it was created from, the readiness
// reason (deps satisfied), and the live in-flight count vs. the governed ceiling
// at enqueue time, so the timeline shows exactly why the walker chose to run it.
export const DagSpecEnqueuedPayload = z
  .object({
    specId: z.string(),
    runId: z.string(),
    // The dependency spec ids that were all DONE, making this spec ready. Empty
    // for a root spec (no dependencies).
    satisfiedDependsOn: z.array(z.string()),
    // The in-flight run count BEFORE this enqueue and the governed ceiling, so an
    // operator can see the headroom the walker scheduled into.
    inFlightBefore: z.number().int().nonnegative(),
    concurrencyCeiling: z.number().int().positive(),
  })
  .strict();
export type DagSpecEnqueuedPayload = z.infer<typeof DagSpecEnqueuedPayload>;

// dag.drained: a walker tick found NO more work to do for the project — every
// spec is either done or in-flight, and no pending spec is ready. The DAG is
// fully scheduled; the walker idles until the next run-terminal notification
// re-triggers it (e.g. an in-flight spec finishing unblocks a dependent).
export const DagDrainedPayload = z
  .object({
    // The spec-count breakdown at drain time, so the timeline shows WHY there was
    // nothing to enqueue (all done, vs. some still in-flight, vs. some blocked).
    doneCount: z.number().int().nonnegative(),
    inFlightCount: z.number().int().nonnegative(),
    // pending specs still blocked on an unfinished dependency (not ready yet).
    blockedCount: z.number().int().nonnegative(),
  })
  .strict();
export type DagDrainedPayload = z.infer<typeof DagDrainedPayload>;

// dag.budget.paused: the walker had ready specs to enqueue but stopped because
// the project's in-flight count is already at the governed concurrency ceiling
// (the headroom is zero). This is the Phase-1 throttle: budget enforcement
// proper fires DOWNSTREAM inside the run (window_exhausted halt), and the walker
// re-evaluates on the next run-terminal notification when a slot frees.
export const DagBudgetPausedPayload = z
  .object({
    // How many ready specs the walker could not enqueue because no slot was free.
    readyHeldBack: z.number().int().nonnegative(),
    inFlightCount: z.number().int().nonnegative(),
    concurrencyCeiling: z.number().int().positive(),
  })
  .strict();
export type DagBudgetPausedPayload = z.infer<typeof DagBudgetPausedPayload>;
