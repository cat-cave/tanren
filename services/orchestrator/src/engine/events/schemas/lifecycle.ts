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
      allocator: z.string()
    }),
    spec: z.object({
      title: z.string(),
      acceptanceCriteria: z.array(z.string()),
      dependsOn: z.array(z.string())
    })
  })
  .strict();

export const RunStartedPayload = z
  .object({
    status: z.string()
  })
  .strict();

export const RunCompletedPayload = z
  .object({
    status: z.string(),
    outcome: z.string()
  })
  .strict();

export const RunFailedPayload = z
  .object({
    status: z.string(),
    message: z.string()
  })
  .strict();

// task.* payloads carry a taskKind plus optional job-queue correlation. The
// failure variant adds the failure kind/message so the timeline UI doesn't
// need to join through tasks to render the failure row.
const TaskKindLiteral = z.string();

export const TaskQueuedPayload = z
  .object({
    taskKind: TaskKindLiteral,
    jobId: z.string().optional()
  })
  .strict();

export const TaskStartedPayload = z
  .object({
    taskKind: TaskKindLiteral,
    jobId: z.string().optional()
  })
  .strict();

export const TaskCompletedPayload = z
  .object({
    taskKind: TaskKindLiteral,
    jobId: z.string().optional(),
    status: z.string().optional(),
    reason: z.string().optional()
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
    reason: z.string().optional()
  })
  .strict();
