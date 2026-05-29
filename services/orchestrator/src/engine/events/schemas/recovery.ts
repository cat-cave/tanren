import { z } from "zod";

// P2B-0008 recovery-lineage events. Every operator-initiated recovery action
// against a halted run persists a typed lineage record here so the run-detail
// history shows the halt → recover chain. The events table is the lineage home
// (append-only, run/spec/project-scoped) — no separate lineage table needed.
//
// `action` is the recovery kind the operator picked; `outcome` records whether
// the action was routed/queued/blocked. Free-text prose (steering notes,
// reasons) is operator-authored and public per the sensitivity heuristic.

export const RecoveryAction = z.enum([
  "revise_spec",
  "replan_with_steering",
  "rollback_to_commit",
  "open_inspection_thread",
]);
export type RecoveryAction = z.infer<typeof RecoveryAction>;

// revise_spec: the operator chose to revise the failing spec. The action does
// not mutate the spec itself (the P2B-0003 edit form does that) — it records
// the intent and routes the operator there.
export const RecoveryReviseRoutedPayload = z
  .object({
    runId: z.string(),
    specId: z.string(),
    action: z.literal("revise_spec"),
    editHref: z.string(),
  })
  .strict();

// replan_with_steering: re-invoke the planner with the operator's steering note
// appended to the spec. Records the new run id the replan was queued under.
export const RecoveryReplanQueuedPayload = z
  .object({
    runId: z.string(),
    specId: z.string(),
    action: z.literal("replan_with_steering"),
    steeringNote: z.string(),
    replanRunId: z.string(),
    plannerTaskId: z.string(),
  })
  .strict();

// rollback_to_commit: reset the workspace to a known-good commit and re-queue.
// Destructive, so it carries the explicit operator confirmation flag and the
// target commit. Never fires without `confirmed: true`.
export const RecoveryRollbackQueuedPayload = z
  .object({
    runId: z.string(),
    specId: z.string(),
    action: z.literal("rollback_to_commit"),
    commitSha: z.string(),
    confirmed: z.literal(true),
    replanRunId: z.string(),
  })
  .strict();

// open_inspection_thread: create a Forge thread bound to the run with read
// access to the auditor/writer disagreement history. Read-only — opening the
// thread triggers no state change by itself.
export const RecoveryInspectionOpenedPayload = z
  .object({
    runId: z.string(),
    specId: z.string(),
    action: z.literal("open_inspection_thread"),
    threadId: z.string(),
  })
  .strict();
