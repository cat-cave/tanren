import { z } from "zod";

// Lifecycle events (run.* and task.*) cover the orchestrator workflow's
// terminal state transitions. Payloads are intentionally narrow so consumer
// dashboards render run/task cards directly from the event row.

export const RunQueuedPayload = z
  .object({
    trigger: z.string(),
    branch: z.string(),
    plannerTaskId: z.string(),
    plannerJobId: z.string(),
    project: z.object({
      repoUrl: z.string(),
      defaultBranch: z.string(),
      runnerImage: z.string(),
      allocator: z.string(),
    }),
    spec: z.object({
      title: z.string(),
      acceptanceCriteria: z.array(z.string()),
      dependsOn: z.array(z.string()),
    }),
  })
  .strict();

export const RunStartedPayload = z
  .object({
    status: z.string(),
  })
  .strict();

export const RunCompletedPayload = z
  .object({
    status: z.string(),
    outcome: z.string(),
  })
  .strict();

export const RunFailedPayload = z
  .object({
    status: z.string(),
    message: z.string(),
  })
  .strict();

// task.* payloads carry a taskKind plus optional job-queue correlation. The
// failure variant adds the failure kind/message so the timeline UI doesn't
// need to join through tasks to render the failure row.
const TaskKindLiteral = z.string();

export const TaskQueuedPayload = z
  .object({
    taskKind: TaskKindLiteral,
    jobId: z.string().optional(),
  })
  .strict();

export const TaskStartedPayload = z
  .object({
    taskKind: TaskKindLiteral,
    jobId: z.string().optional(),
  })
  .strict();

export const TaskCompletedPayload = z
  .object({
    taskKind: TaskKindLiteral,
    jobId: z.string().optional(),
    status: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();

export const TaskFailedPayload = z
  .object({
    taskKind: TaskKindLiteral,
    jobId: z.string().optional(),
    kind: z.string().optional(),
    failureKind: z.string().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();

// queue hardening. Emitted when a job's bounded re-claim budget is
// exhausted and the job is moved to the terminal `dead_letter` state instead
// of being retried forever. `attempts` is the final attempt count that tripped
// the budget; `maxAttempts` is the configured ceiling. The failure kind/message
// echo the last execution failure so operators can triage from the timeline.
export const JobDeadLetteredPayload = z
  .object({
    jobId: z.string(),
    taskKind: TaskKindLiteral,
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    failureKind: z.string(),
    message: z.string(),
  })
  .strict();

// Operator cancel events (spec.cancelled / run.cancelled). The operator
// cancel-spec/cancel-run action (workflow/cancelSpec) is a human-drivable control: it
// transitions a spec (and its active run) to the TERMINAL `cancelled` state, frees the
// DAG slot (the walker treats `cancelled` as terminal, like `merged`), and RELEASES any
// allocated runner (no leaked sandbox). These two events make that operator decision
// DURABLE + actor-stamped. Every field is non-secret: spec/run ids are run lineage, the
// prior status is an enum label, `cancelledBy` is the operator's user id, and the
// dependent ids / runner id carry no diff content, credentials, or command output.

// spec.cancelled: the operator cancelled the spec — it goes terminal `cancelled`,
// freeing its DAG slot (the walker never re-enqueues a cancelled spec). `fromStatus` is
// the status it was cancelled from; `dependentsParked` names the direct dependents
// escalated to `needs_attention` as a result (the human-escalation discipline — a
// dependent is NEVER silently dropped).
export const SpecCancelledPayload = z
  .object({
    specId: z.string(),
    fromStatus: z.string(),
    cancelledBy: z.string(),
    dependentsParked: z.array(z.string()),
  })
  .strict();

// run.cancelled: the spec's active run was cancelled as part of the spec cancel — it
// goes terminal `cancelled` and its claimed runner is RELEASED (the runner-row release
// seam; the workspace reaper then reclaims the sandbox now the run is terminal).
// `runnerReleased` records whether a runner was actually found + released (false when
// the run had no claimed runner — e.g. a still-`queued` run), so a leak is never silent.
export const RunCancelledPayload = z
  .object({
    runId: z.string(),
    fromStatus: z.string(),
    cancelledBy: z.string(),
    runnerId: z.string().optional(),
    runnerReleased: z.boolean(),
  })
  .strict();
