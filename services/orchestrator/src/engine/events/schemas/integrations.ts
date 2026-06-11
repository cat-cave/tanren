import { z } from "zod";
import { AuditEnvelope } from "./audit.js";

// External integration events: GitHub (branch/PR), the review lifecycle, and the
// merge stage. (The native gate is the merge authority — there are no forge-CI
// observation events here; the gate's own verdict lives in schemas/gate.ts.)

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

// merge stage. The integration is one of the per-repo MergeIntegration
// modes (native_queue / direct_merge / external_reviewer). `merge.queued`
// fires when the PR is handed to the integration (a native-queue enqueue, a
// direct merge attempt, or an external-reviewer hand-off); `merge.completed`
// carries the merge sha on a real GitHub merge; `merge.failed` records a
// non-conflict failure; `merge.conflict` is the typed recoverable branch the
// conflict resolver scaffolding hooks into.
export const MergeIntegrationMode = z.enum(["native_queue", "direct_merge", "external_reviewer"]);

export const MergeQueuedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
  })
  .strict();

// merge.completed is the terminal governing event of the delivery loop — code
// reaches `main`. The audit envelope records the governance policy version + the
// initiating actor (the autonomous service) AND the approving actor when a human
// review tier gated the merge (absent on the autonomous tiers — the honest "no
// human approver" state). Flat-merged onto the payload.
export const MergeCompletedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    mergeSha: z.string().optional(),
  })
  .extend(AuditEnvelope.shape)
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

// autonomy-engine.md §2c: a SPECULATIVE dependent's MERGE is HELD because
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
    /**
     * The base the dependent's PR currently stacks on — the immediate unmerged ancestor's
     * PR-head branch (the stacked-PR base), or `default_branch` once the stack empties.
     * jj-local: there is no synthesized integration ref.
     */
    speculativeBase: z.string(),
    /** The ancestor spec ids that are not yet merged (the merge is held on these). */
    unmergedAncestors: z.array(z.string()).min(1),
  })
  .strict();

// §2c step 3: a speculative dependent's ancestors have all merged, so its
// hold CLEARED — the merge stage re-points the dependent's PR base from its
// ephemeral integration ref to `default_branch` (GitHub PATCH /pulls/:n { base })
// BEFORE merging, so it lands on REAL `main` (never the integration ref). The up-to-date
// auto-rebase + re-gate then brings the branch current with `default_branch`.
export const MergeRetargetedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    /** The integration ref the PR was based on before the retarget. */
    fromBase: z.string(),
    /** The real base the PR now targets (`default_branch`). */
    toBase: z.string(),
  })
  .strict();

// up-to-date enforcement. Before merging, the stage checks the PR branch's
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

// intent-preserving conflict resolution (autonomy-engine.md §2b). On a real
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

// the routed-back-to-planner record — the durable carrier that keeps a
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

// external-push governance posture. Emitted at the merge decision when
// the configured posture holds an auto-merge:
//   strict / lenient + external → mode "operator_approval" (lenient mirrors strict)
//   audit_only + external change → mode "audit_only" (observed, never merged)
// `externalLogins` are the non-Tanren contributor logins that drove the block.
export const GovernancePostureMode = z.enum(["strict", "open", "audit_only", "lenient"]);
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

// `integration.provisioned` (schemas/onboarding.ts) + `deploy.triggered`
// (schemas/deploy.ts) live in their own modules (500-line cap), re-exported here.
export { IntegrationProvisionedPayload } from "./onboarding.js";
export { DeployTriggeredPayload, DeployVerifiedPayload, DeployFailedPayload, DeploySkippedPayload } from "./deploy.js";

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

// Plane B app-environment: the project's RUNTIME-scoped app env was
// attached to the DEPLOYED app (Vercel/Fly) as its environment. The deploy is an
// external integration the built product runs on, so the event lives here.
//
// SECURITY: this payload carries ONLY the deploy target (provider + appId) and the
// env var KEY NAMES — never a single secret VALUE. The values went into the deploy
// provider's set-env request and nowhere else; this event is the observable proof
// the attach ran, safe to surface to any project member.
export const AppEnvRuntimeAttachedPayload = z
  .object({
    /** The deploy provider kind the env was attached on (`deploy.vercel` | `deploy.flyio`). */
    provider: z.string(),
    /** The deployed app/project id the env was attached to (the deployRef's appId). */
    appId: z.string(),
    /** The env var KEY NAMES attached (sorted). NEVER the values. */
    keys: z.array(z.string()),
  })
  .strict();
