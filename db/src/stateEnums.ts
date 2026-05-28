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
    "cancelled",
    "done"
  ],
  runs_outcome: [
    "hello_complete",
    "phase1_fixture_complete",
    "phase2_easy_complete",
    "phase2_medium_complete",
    "halted",
    "escape_hatch_hit",
    "retry_budget_exhausted",
    "window_exhausted",
    "cancelled",
    "hello_world_complete",
    "ok",
    "failed",
    "pending"
  ],
  specs_status: [
    "open",
    "in_flight",
    "review",
    "merged",
    "halted",
    "cancelled",
    "pending",
    "active",
    "done"
  ],
  tasks_kind: [
    "plan",
    "write",
    "check",
    "audit",
    "ci",
    "demo",
    "forge"
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
    "failed",
    "rejected_by_checker",
    "rejected_by_auditor",
    "timed_out",
    "crashed",
    "window_exhausted",
    "cancelled",
    "ok",
    "pending"
  ],
  tasks_agent_kind: [
    "system",
    "operator",
    "writer_codex",
    "answerer_codex",
    "forge_template",
    "ci_poller",
    "writer",
    "answerer"
  ],
  job_queue_status: [
    "queued",
    "claimed",
    "running",
    "done",
    "failed",
    "cancelled"
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
