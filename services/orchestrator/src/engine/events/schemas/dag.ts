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

// dag.spec.speculative (autonomy-engine.md §2c): the walker started a dependent
// SPECULATIVELY — it crossed the configured speculation threshold while one or
// more of its ancestors are not yet MERGED. The dependent's PR bases on a
// speculative integration branch (main + the unmerged ancestors' branches merged
// in DAG order); its MERGE still waits for those ancestors to genuinely merge.
// This event names the unmerged ancestors + the threshold so the timeline shows
// exactly what prospective merged world the dependent built against.
export const DagSpecSpeculativePayload = z
  .object({
    specId: z.string(),
    runId: z.string(),
    // The ancestors that have crossed the threshold but are NOT yet merged — the
    // members of the speculative integration branch the dependent bases on.
    unmergedAncestors: z.array(z.string()).min(1),
    // The configured speculation threshold that admitted this early start.
    threshold: z.enum(["conservative", "moderate", "aggressive"]),
    // The integration branch ref the dependent's PR bases on (the prospective
    // merged world). Present so the timeline links the dependent to its base.
    integrationBranch: z.string(),
  })
  .strict();
export type DagSpecSpeculativePayload = z.infer<typeof DagSpecSpeculativePayload>;

// dag.spec.speculation_held (autonomy-engine.md §2c open decision §6): a dependent
// WOULD be ready under the threshold, but its unmerged-ancestor DEPTH exceeds the
// configured cap. Rather than silently truncating the integration stack (the "no
// silent caps" rule), the walker HOLDS the spec until enough ancestors merge and
// records WHY here. The walker re-evaluates on the next ancestor-merge notification.
export const DagSpecSpeculationHeldPayload = z
  .object({
    specId: z.string(),
    // The full unmerged-ancestor stack the spec would have needed (its depth).
    unmergedAncestors: z.array(z.string()).min(1),
    depth: z.number().int().positive(),
    // The configured max integration depth the stack exceeded.
    depthCap: z.number().int().positive(),
  })
  .strict();
export type DagSpecSpeculationHeldPayload = z.infer<typeof DagSpecSpeculationHeldPayload>;

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
