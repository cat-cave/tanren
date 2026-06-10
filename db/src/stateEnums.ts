// GENERATED FILE — do not edit by hand.
// Regenerate via `corepack pnpm run codegen:state` (or `node scripts/generate-state-checks.mjs`).
// Source of truth: services/orchestrator/src/engine/state/*.ts (Zod enums).
// The drift check at `scripts/check-schema-drift.sh` and the dedicated state
// drift check confirm this file matches the Zod source.

export const stateEnumLists = {
  runs_status: [
    "queued",
    "running",
    "halted",
    "completed",
    "failed",
    "cancelled"
  ],
  runs_outcome: [
    "ok",
    "halted",
    "escape_hatch_hit",
    "retry_budget_exhausted",
    "convergence_stalled",
    "window_exhausted",
    "cancelled",
    "failed"
  ],
  specs_status: [
    "open",
    "in_flight",
    "review",
    "merged",
    "halted",
    "cancelled",
    "needs_attention"
  ],
  tasks_kind: [
    "plan",
    "write",
    "check",
    "audit",
    "ci",
    "review",
    "merge",
    "demo",
    "forge",
    "triage",
    "convergence"
  ],
  tasks_status: [
    "queued",
    "claimed",
    "running",
    "done",
    "failed",
    "cancelled"
  ],
  tasks_outcome: [
    "passed",
    "ok",
    "pending",
    "failed",
    "rejected_by_checker",
    "rejected_by_auditor",
    "timed_out",
    "crashed",
    "window_exhausted",
    "cancelled"
  ],
  tasks_agent_kind: [
    "system",
    "operator",
    "writer",
    "answerer",
    "forge_template",
    "ci_poller"
  ],
  job_queue_status: [
    "queued",
    "claimed",
    "running",
    "done",
    "failed",
    "cancelled",
    "dead_letter"
  ],
  job_queue_task_kind: [
    "hello",
    "phase1_fixture",
    "phase2_easy",
    "phase2_medium",
    "ci_poll",
    "recovery_revise",
    "recovery_replan",
    "recovery_rollback",
    "gate",
    "review",
    "merge",
    "plan",
    "write",
    "check",
    "audit",
    "ci",
    "demo",
    "forge"
  ]
} as const;

export type StateEnumName = keyof typeof stateEnumLists;
