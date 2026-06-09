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

// run.failed is PUBLIC (any project member). The worker-level catch wraps a WHOLE
// run, so its caught error can carry URLs / repo refs / command fragments / provider
// responses / secret-adjacent text — that raw string must NEVER land here. So this
// payload carries only safe, closed-vocabulary signal: a stable `failureCode` + the
// `stage` it failed in + a FIXED safe `message` summary (none of which echo the raw
// error). The raw detail lives in the INTERNAL `job_queue.failure_message` column +
// a redacted log, off the public event. See worker/runFailureClassifier.ts.
export const RunFailedPayload = z
  .object({
    status: z.string(),
    // Stable failure code from the closed run-failure enum (worker/runFailureClassifier).
    failureCode: z.string(),
    // The run stage the failure is attributed to (bootstrap/credentials/workspace/agent/merge/deploy/run).
    stage: z.string(),
    // A FIXED safe summary of the failure — never the raw caught-error string.
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
