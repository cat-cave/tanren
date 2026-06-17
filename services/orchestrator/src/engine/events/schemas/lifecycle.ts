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

// queue lease recovery. Emitted when a job's lease lapses (a crashed or
// slow worker) and the reaper requeues it — ALWAYS, unbounded; there is NO
// attempt-cap dead-letter (a re-claim is recovery, not a strike). `attempts` is
// the DIAGNOSTIC re-claim count: a value that keeps climbing on the same job is a
// worker repeatedly crashing on it — an infra problem this LOUD signal surfaces
// for triage, never a give-up budget.
export const JobLeaseExpiredPayload = z
  .object({
    jobId: z.string(),
    taskKind: TaskKindLiteral,
    attempts: z.number().int(),
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
