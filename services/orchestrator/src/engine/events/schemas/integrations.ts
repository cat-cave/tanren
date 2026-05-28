import { z } from "zod";

// External integration events: GitHub (branch/PR), CI polling, phase 1
// fixture orchestration, review lifecycle, notification dispatch, and the
// developer-facing hello run.

export const GithubBranchPushedPayload = z
  .object({
    repoUrl: z.string(),
    branch: z.string(),
    credentialRef: z.string(),
    redacted: z.literal(true)
  })
  .strict();

export const GithubPrCreatedPayload = z
  .object({
    repoUrl: z.string(),
    branch: z.string(),
    targetBranch: z.string(),
    prUrl: z.string(),
    prNumber: z.number().int(),
    reused: z.boolean()
  })
  .strict();

export const GithubPrReadyPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int()
  })
  .strict();

export const GithubPrMergedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    mergeSha: z.string().optional()
  })
  .strict();

export const GithubFailedPayload = z
  .object({
    operation: z.string(),
    branch: z.string().optional(),
    message: z.string()
  })
  .strict();

const CheckRunSummary = z
  .object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable().optional(),
    url: z.string().optional()
  })
  .strict();

const CommitStatusSummary = z
  .object({
    context: z.string(),
    state: z.string(),
    url: z.string().optional()
  })
  .strict();

const CiCheckRef = z
  .object({
    kind: z.enum(["check_run", "commit_status"]),
    name: z.string(),
    state: z.string(),
    url: z.string().optional()
  })
  .strict();

const CiObservationPayload = z
  .object({
    prUrl: z.string(),
    credentialRef: z.string(),
    redacted: z.literal(true),
    status: z.enum(["pending", "passed", "failed"]),
    reason: z.string(),
    headSha: z.string(),
    checkRuns: z.array(CheckRunSummary),
    statuses: z.array(CommitStatusSummary),
    failingChecks: z.array(CiCheckRef),
    pendingChecks: z.array(CiCheckRef)
  })
  .strict();

export const CiStartedPayload = CiObservationPayload;
export const CiPassedPayload = CiObservationPayload;
export const CiFailedPayload = CiObservationPayload;

export const Phase1FixtureStartedPayload = z
  .object({
    repoUrl: z.string(),
    targetBranch: z.string()
  })
  .strict();

export const Phase1FixtureCiPendingPayload = z
  .object({
    attempt: z.number().int(),
    nextPollAfterMs: z.number().int()
  })
  .strict();

export const Phase1FixtureCompletedPayload = z
  .object({
    prUrl: z.string(),
    ciStatus: z.string()
  })
  .strict();

export const Phase1FixtureFailedPayload = z
  .object({
    message: z.string()
  })
  .strict();

export const ReviewRequestedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    reviewers: z.array(z.string()).optional()
  })
  .strict();

export const ReviewApprovedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    reviewer: z.string().optional()
  })
  .strict();

export const ReviewChangesRequestedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    reviewer: z.string().optional(),
    message: z.string().optional()
  })
  .strict();

// P3-0008 merge stage. The integration is one of the per-repo MergeIntegration
// modes (mergify_queue / direct_merge / external_reviewer). `merge.queued`
// fires when the PR is handed to the integration (a Mergify label, a direct
// merge attempt, or an external-reviewer hand-off); `merge.completed` carries
// the merge sha on a real GitHub merge; `merge.failed` records a non-conflict
// failure; `merge.conflict` is the typed recoverable branch the conflict
// resolver scaffolding hooks into.
export const MergeIntegrationMode = z.enum(["mergify_queue", "direct_merge", "external_reviewer"]);

export const MergeQueuedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    /** Label applied for the mergify_queue path; absent for other modes. */
    queueLabel: z.string().optional()
  })
  .strict();

export const MergeCompletedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    mergeSha: z.string().optional()
  })
  .strict();

export const MergeFailedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    message: z.string()
  })
  .strict();

export const MergeConflictPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    baseBranch: z.string(),
    headBranch: z.string().optional(),
    message: z.string()
  })
  .strict();

export const NotificationEnqueuedPayload = z
  .object({
    channel: z.string(),
    eventName: z.string().optional()
  })
  .strict();

export const NotificationSentPayload = z
  .object({
    channel: z.string(),
    attempts: z.number().int().optional()
  })
  .strict();

export const NotificationFailedPayload = z
  .object({
    channel: z.string(),
    message: z.string()
  })
  .strict();

const RunnerProofPayload = z
  .object({
    runnerId: z.string(),
    imageSha: z.string(),
    target: z
      .object({
        host: z.string(),
        port: z.number().int(),
        username: z.string(),
        hostKeyFingerprint: z.string()
      })
      .strict(),
    command: z.string(),
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    timedOut: z.boolean()
  })
  .strict();

export const HelloStartedPayload = z.object({}).strict();

export const HelloSshStartedPayload = z
  .object({
    runnerId: z.string(),
    command: z.string(),
    target: z
      .object({
        host: z.string(),
        port: z.number().int(),
        username: z.string(),
        hostKeyFingerprint: z.string()
      })
      .strict()
  })
  .strict();

export const HelloSshCompletedPayload = RunnerProofPayload;

export const HelloCompletedPayload = z
  .object({
    outcome: z.string(),
    runnerProof: RunnerProofPayload,
    workspacePath: z.string()
  })
  .strict();
