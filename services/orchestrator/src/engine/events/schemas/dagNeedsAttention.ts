import { z } from "zod";

// GENUINE-HALT escalation reasons (apex v35 — the unified run-finalize authority,
// `runFinalizeAuthority.ts`). `needs_attention` is RESERVED for the three GENUINE-HALT
// classes; a RANDOM/TRANSIENT/internal/crash/orphan fault NEVER rests here — it RE-DRIVES
// (emitting `dag.spec.redriven`). The old slot-occupying strand reasons (`halted_reexec` /
// `orphaned_marker` / `no_live_run`) are GONE: they were transient classes the per-path
// logic mis-parked; their diagnostic detail now rides `dag.spec.redriven.failureCode`.
//   - `misconfiguration` — a structural cause a human must fix (missing/unscoped credential,
//     unresolvable provider mode). Never self-heals on retry, so it escalates immediately.
//   - `persistent_failure` — the run failed the SAME classified way K consecutive times (each
//     transient RE-DRIVEN but never converged): a genuinely STUCK spec (a bug / mis-spec).
//   - `human_decision` — a genuine merge-boundary decision (a HITL hold / changes-requested).
const StrandReason = z.enum(["misconfiguration", "persistent_failure", "human_decision"]);
// One of the strand's terminal runs (its id + final status) — for the audit trail.
const StrandTerminalRun = z.object({ runId: z.string(), status: z.string() }).strict();

// dag.spec.needs_attention: a spec parked at the terminal `needs_attention` status — freeing the
// DAG slot and blocking ONLY its dependents (never the whole DAG), surfacing a loud, bounded ask-
// for-help. A discriminated union on `source` because FOUR subsystems reach the SAME terminal parked
// state, each carrying its own halt history:
//   - `strand`: the run-finalize authority's FIXED-POINT escalation — the SAME classified failure
//     recurring with no new information (the shared `convergenceDetector`). The canonical
//     persistent-failure source: ONE failure code repeating.
//   - `merge_conflict`: the native merge queue's intent-preserving conflict resolver
//     judged the spec GENUINELY irreconcilable against another in-flight spec (re-
//     executing it would just re-conflict forever), so the coordinator parked it
//     instead of blindly re-executing (autonomy-engine.md §2c — the non-bricking
//     conflict escalation). Carries the PR + the resolver's message.
//   - `cancelled_ancestor`: an operator CANCELLED an ancestor of this spec (the
//     operator cancel-spec action, workflow/cancelSpec). A dependent of a cancelled
//     spec is NOT silently dropped (the human-escalation discipline): cancelling the
//     ancestor removed the work the dependent assumed, so the dependent parks at
//     `needs_attention` for a human to DECIDE (re-scope the dependent, re-queue the
//     ancestor, or cancel the dependent too) — never an autonomous cascade-cancel.
//     Carries the cancelled ancestor's spec id.
//   - `wandering_halt` (apex v67 finding #122): the run-finalize authority's WANDERING-HALT
//     escalation — N consecutive re-drives with DIFFERENT failure codes but ZERO deliverable
//     progress (no PR opened, no merge, no new pipeline stage reached). Distinct from `strand`
//     because the failure pattern differs: a strand has ONE code repeating; a wandering halt
//     has MANY different codes with no forward motion. The new SECOND convergence signal — the
//     fixed-point detector structurally cannot catch the changing-failure-no-progress trap.
//     See `engine/workflow/wanderingHaltDetector.ts` for the full rationale.
// One event type (no new event / no events-CHECK migration) so the DAG/UI consume the
// parked state uniformly regardless of which subsystem escalated it.
// Split out of `dag.ts` (file-size cap) and re-exported there so import sites are unchanged.
export const DagSpecNeedsAttentionPayload = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("strand"),
      specId: z.string(),
      reason: StrandReason,
      // The spec's terminal runs at escalation time (the halt history).
      terminalRuns: z.array(StrandTerminalRun),
      // How many times the spec had already been re-enqueued (exceeded the cap).
      attempts: z.number().int().nonnegative(),
      // The human-readable DECISION ask (the escalation discipline): framed as
      // "the autonomous self-heal could not make progress — a human must decide",
      // NOT "an error occurred". Mirrors the merge_conflict source's `message` so
      // both parked-state reasons surface as decisions, not error reports.
      message: z.string(),
    })
    .strict(),
  z
    .object({
      source: z.literal("merge_conflict"),
      specId: z.string(),
      // The PR whose merge the resolver found genuinely irreconcilable.
      prUrl: z.string(),
      prNumber: z.number().int(),
      // The resolver's human-readable reason the conflict could not be reconciled.
      message: z.string(),
    })
    .strict(),
  z
    .object({
      source: z.literal("cancelled_ancestor"),
      specId: z.string(),
      // The ancestor an operator cancelled — the dependency this spec assumed that
      // no longer exists, forcing the human decision.
      cancelledAncestorSpecId: z.string(),
      // The human-readable DECISION ask (the escalation discipline): framed as "an
      // ancestor was cancelled — decide how to proceed", not "an error occurred".
      message: z.string(),
    })
    .strict(),
  z
    .object({
      source: z.literal("wandering_halt"),
      specId: z.string(),
      // Always `persistent_failure` (the wandering halt is a persistent-failure ESCALATION
      // pattern: the spec persistently failed to make any deliverable progress, even though
      // each individual failure differed). Carried explicitly so the strand/wandering pair
      // share the same `reason` vocabulary on the timeline.
      reason: z.literal("persistent_failure"),
      // Total re-drives in the wandering history (the spec's lifetime — NOT just the
      // trailing window). 5+ by construction at the threshold default.
      totalRedrives: z.number().int().positive(),
      // The trailing run of no-progress re-drives that crossed the threshold.
      noProgressStreak: z.number().int().positive(),
      // The distinct classified failure codes seen across the wandering history — the
      // diagnostic that distinguishes this from a strand at a glance (a strand has ONE
      // code; a wandering halt has MANY).
      distinctFailureCodes: z.array(z.string()),
      // The human-readable DECISION ask (the escalation discipline) — framed as
      // "the spec re-drove N times without making any deliverable progress — a human
      // must decide", NOT "an error occurred".
      message: z.string(),
    })
    .strict(),
]);
export type DagSpecNeedsAttentionPayload = z.infer<typeof DagSpecNeedsAttentionPayload>;
