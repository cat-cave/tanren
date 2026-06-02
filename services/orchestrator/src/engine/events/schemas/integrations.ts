import { z } from "zod";

// External integration events: GitHub (branch/PR), CI polling, phase 1
// fixture orchestration, review lifecycle, notification dispatch, and the
// developer-facing hello run.

export const GithubBranchPushedPayload = z
  .object({
    repoUrl: z.string(),
    branch: z.string(),
    credentialRef: z.string(),
    redacted: z.literal(true),
  })
  .strict();

export const GithubPrCreatedPayload = z
  .object({
    repoUrl: z.string(),
    branch: z.string(),
    targetBranch: z.string(),
    prUrl: z.string(),
    prNumber: z.number().int(),
    reused: z.boolean(),
  })
  .strict();

export const GithubPrReadyPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
  })
  .strict();

export const GithubPrMergedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    mergeSha: z.string().optional(),
  })
  .strict();

export const GithubFailedPayload = z
  .object({
    operation: z.string(),
    branch: z.string().optional(),
    message: z.string(),
  })
  .strict();

const CheckRunSummary = z
  .object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable().optional(),
    url: z.string().optional(),
  })
  .strict();

const CommitStatusSummary = z
  .object({
    context: z.string(),
    state: z.string(),
    url: z.string().optional(),
  })
  .strict();

const CiCheckRef = z
  .object({
    kind: z.enum(["check_run", "commit_status"]),
    name: z.string(),
    state: z.string(),
    url: z.string().optional(),
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
    pendingChecks: z.array(CiCheckRef),
  })
  .strict();

export const CiStartedPayload = CiObservationPayload;
export const CiPassedPayload = CiObservationPayload;
export const CiFailedPayload = CiObservationPayload;

export const Phase1FixtureStartedPayload = z
  .object({
    repoUrl: z.string(),
    targetBranch: z.string(),
  })
  .strict();

export const Phase1FixtureCiPendingPayload = z
  .object({
    attempt: z.number().int(),
    nextPollAfterMs: z.number().int(),
  })
  .strict();

export const Phase1FixtureCompletedPayload = z
  .object({
    prUrl: z.string(),
    ciStatus: z.string(),
  })
  .strict();

export const Phase1FixtureFailedPayload = z
  .object({
    message: z.string(),
  })
  .strict();

export const ReviewRequestedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    reviewers: z.array(z.string()).optional(),
  })
  .strict();

export const ReviewApprovedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    reviewer: z.string().optional(),
  })
  .strict();

export const ReviewChangesRequestedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    reviewer: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

// Emitted when a project's reviewPolicy is `auto`: the review stage approved the
// PR without polling GitHub (the no-review tier). Distinct from `review.approved`
// so the audit trail records that no human verdict gated the merge.
export const ReviewAutoApprovedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
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
    queueLabel: z.string().optional(),
  })
  .strict();

export const MergeCompletedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    mergeSha: z.string().optional(),
  })
  .strict();

export const MergeFailedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    message: z.string(),
  })
  .strict();

export const MergeConflictPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    baseBranch: z.string(),
    headBranch: z.string().optional(),
    message: z.string(),
  })
  .strict();

// P2c-1 (autonomy-engine.md §2c): a SPECULATIVE dependent's MERGE is HELD because
// one or more of its ancestors are not yet genuinely merged. Its WORK proceeded
// (it built against a speculative integration branch), but its MERGE must wait so
// no unreviewed ancestor code reaches `main` early. The merge stage emits this
// instead of merging; the run re-enters the merge stage once its ancestors merge
// (the DagWalker re-walks on ancestor merge.completed). NOT a failure — a hold.
export const MergeSpeculativeHeldPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    /** The integration branch the dependent's PR currently bases on. */
    speculativeBase: z.string(),
    /** The ancestor spec ids that are not yet merged (the merge is held on these). */
    unmergedAncestors: z.array(z.string()).min(1),
  })
  .strict();

// P2a up-to-date enforcement. Before merging, the stage checks the PR branch's
// freshness: `merge.behind` records that the branch was out of date with its
// base (so a rebase is being driven); `merge.rebased` records that the
// server-side update-branch advanced the branch onto base and the stage is
// re-polling CI before merging. A stale/conflicting branch is now DETECTED and
// routed here, not discovered as a raw 405/409 at merge time.
export const MergeBehindPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    baseBranch: z.string(),
    headBranch: z.string().optional(),
    /** The mergeability state observed (`behind` / `dirty` / `unknown`). */
    mergeableState: z.string(),
  })
  .strict();

export const MergeRebasedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    baseBranch: z.string(),
    headBranch: z.string().optional(),
    /** Whether CI was re-polled green after the rebase before merging. */
    reGatedCi: z.boolean(),
  })
  .strict();

// P2b intent-preserving conflict resolution (autonomy-engine.md §2b). On a real
// conflict between the merging spec and what is now on the base branch, the
// resolver makes the resolution INSPECTABLE through three events:
//   - merge.conflict.resolving      → the resolver was invoked: which other spec
//                                      the DAG provenance identified, the DAG
//                                      edge between them, and the conflicted
//                                      files. (A conflict is a re-planning
//                                      problem, not a text-picking one.)
//   - merge.conflict.resolved       → the Answerer produced a both-intents-
//                                      preserving tree AND the re-gate (gate +
//                                      checker + auditor over the RESOLVED tree)
//                                      passed: the merge proceeds. NEVER emitted
//                                      for an unverified resolution.
//   - merge.conflict.irreconcilable → the Answerer (or a failed re-gate) judged
//                                      the two intents cannot both be satisfied
//                                      by one edit: one spec is routed back to
//                                      the planner with the other's change as new
//                                      context. The intent stays ALIVE; the PR is
//                                      NOT merged.
export const MergeConflictResolvingPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    baseBranch: z.string(),
    /** The spec whose PR is being merged. */
    mergingSpecId: z.string(),
    /** The other conflicting spec the DAG + file provenance identified, if any. */
    conflictingSpecId: z.string().optional(),
    /** Whether a persisted DAG edge connects the two specs (provenance signal). */
    dagEdge: z.boolean(),
    /** The conflicted file paths the resolver gathered. */
    conflictedFiles: z.array(z.string()),
  })
  .strict();

export const MergeConflictResolvedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    baseBranch: z.string(),
    mergingSpecId: z.string(),
    conflictingSpecId: z.string().optional(),
    /** The files the resolution rewrote (the recorded resolution diff surface). */
    resolvedFiles: z.array(z.string()),
    /** Always true here — the resolution is only `resolved` after a clean re-gate. */
    reGated: z.boolean(),
  })
  .strict();

export const MergeConflictIrreconcilablePayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    baseBranch: z.string(),
    mergingSpecId: z.string(),
    conflictingSpecId: z.string().optional(),
    /** Which spec was routed back to the planner ('merging' | 'base'). */
    replanned: z.enum(["merging", "base"]).optional(),
    /** The spec id routed back to the planner (kept alive, not dropped). */
    replannedSpecId: z.string().optional(),
    /** Why irreconcilable: the Answerer diagnosis, or a failed re-gate. */
    reason: z.string(),
    /** True when the irreconcilable verdict came from a FAILED re-gate, not the Answerer. */
    fromFailedReGate: z.boolean(),
  })
  .strict();

// P2b: the routed-back-to-planner record — the durable carrier that keeps a
// re-planned spec's intent ALIVE. Emitted by the replan router when an
// irreconcilable conflict (or a failed re-gate) routes one spec back to the
// planner with the other's change as new context. The next planner pass reads
// `newContext` so the spec re-plans ON TOP of the other's change.
export const MergeConflictReplanRoutedPayload = z
  .object({
    specId: z.string(),
    /** The other spec whose change the re-planned spec must build on, if any. */
    otherSpecId: z.string().optional(),
    /** The other spec's change, as new planning context for the re-plan. */
    newContext: z.string(),
    /** The status the spec was returned to so it can be re-planned. */
    replanStatus: z.string(),
  })
  .strict();

// P3-0023 external-push governance posture. Emitted at the merge decision when
// the configured posture (strict | open | audit_only) holds an auto-merge:
//   strict + external change     → mode "operator_approval" (needs a human OK)
//   audit_only + external change → mode "audit_only" (observed, never merged)
// `externalLogins` are the non-Tanren contributor logins that drove the block.
export const GovernancePostureMode = z.enum(["strict", "open", "audit_only"]);
export const MergeBlockMode = z.enum(["operator_approval", "audit_only"]);

export const MergeBlockedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    posture: GovernancePostureMode,
    mode: MergeBlockMode,
    externalLogins: z.array(z.string()),
    reason: z.string(),
  })
  .strict();

export const NotificationEnqueuedPayload = z
  .object({
    channel: z.string(),
    eventName: z.string().optional(),
  })
  .strict();

export const NotificationSentPayload = z
  .object({
    channel: z.string(),
    attempts: z.number().int().optional(),
  })
  .strict();

export const NotificationFailedPayload = z
  .object({
    channel: z.string(),
    message: z.string(),
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
        hostKeyFingerprint: z.string(),
      })
      .strict(),
    command: z.string(),
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    timedOut: z.boolean(),
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
        hostKeyFingerprint: z.string(),
      })
      .strict(),
  })
  .strict();

export const HelloSshCompletedPayload = RunnerProofPayload;

export const HelloCompletedPayload = z
  .object({
    outcome: z.string(),
    runnerProof: RunnerProofPayload,
    workspacePath: z.string(),
  })
  .strict();
