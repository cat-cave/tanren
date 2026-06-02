import { z } from "zod";

// Infrastructure-side events: runner, allocator, workspace, credential, cost.
// These payloads describe state of the underlying runtime substrate.

const SshTargetSummary = z
  .object({
    host: z.string(),
    port: z.number().int(),
    username: z.string(),
    hostKeyFingerprint: z.string(),
  })
  .strict();

const RunnerAllocationSummary = z
  .object({
    runnerId: z.string(),
    imageSha: z.string(),
    target: SshTargetSummary,
  })
  .strict();

export const AllocatorRequestedPayload = z
  .object({
    allocator: z.string(),
    runnerImage: z.string(),
    identitySecretRef: z.string(),
  })
  .strict();

export const AllocatorAllocatedPayload = RunnerAllocationSummary;

export const AllocatorFailedPayload = z
  .object({
    message: z.string(),
  })
  .strict();

export const RunnerAllocatedPayload = RunnerAllocationSummary;

export const RunnerReleasedPayload = z
  .object({
    runnerId: z.string(),
  })
  .strict();

const SshCommandFailure = z
  .union([
    z.object({ reason: z.string(), message: z.string().optional() }).strict(),
    z.object({ reason: z.string() }).strict(),
  ])
  .or(z.record(z.string(), z.unknown()));

const SshCommandResultSummary = z
  .object({
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    signal: z.string().optional(),
    timedOut: z.boolean(),
    failure: SshCommandFailure.optional(),
  })
  .strict();

export const RunnerFailedPayload = z
  .object({
    runnerId: z.string(),
    command: z.string(),
    result: SshCommandResultSummary,
  })
  .strict();

export const WorkspacePreparedPayload = z
  .object({
    runnerId: z.string().optional(),
    workspacePath: z.string(),
    repoUrl: z.string().optional(),
    targetBranch: z.string().optional(),
  })
  .strict();

export const WorkspaceGitCapturedPayload = z
  .object({
    workspacePath: z.string(),
    commits: z.array(z.object({ sha: z.string(), message: z.string() }).strict()),
    diffBytes: z.number().int(),
  })
  .strict();

export const WorkspaceFailedPayload = z
  .object({
    runnerId: z.string().optional(),
    workspacePath: z.string(),
    message: z.string(),
  })
  .strict();

const CredentialReference = z
  .object({
    credentialKind: z.string(),
    ref: z.string(),
    redacted: z.literal(true),
  })
  .strict();

export const CredentialRequestedPayload = CredentialReference;
export const CredentialLoadedPayload = CredentialReference;
export const CredentialFailedPayload = z
  .object({
    ref: z.string().optional(),
    message: z.string(),
  })
  .strict();

// Managed-hosting dimension D (per-run scoped credentials): a short-lived Vault
// CHILD token was minted, scoped to read ONLY this run's credential ref paths,
// with a bounded TTL + use count. The audit record carries the SCOPE — the ref
// paths the policy covers, the policy name, the TTL and num_uses — but NEVER the
// token value (and never the broad VAULT_TOKEN). The ref paths are redacted (they
// embed the tenant), the bounds are public.
export const CredentialScopedTokenMintedPayload = z
  .object({
    policyName: z.string(),
    refPaths: z.array(z.string()),
    ttlSeconds: z.number().int(),
    numUses: z.number().int(),
  })
  .strict();

export const CostResolvedPayload = z
  .object({
    taskId: z.string(),
    cli: z.string(),
    provider: z.string(),
    model: z.string(),
    // cost is best-effort: null when no reliable basis exists.
    costUsd: z.string().nullable(),
    billingMode: z.string(),
    costBasis: z.string(),
  })
  .strict();

export const CostFailedPayload = z
  .object({
    taskId: z.string().optional(),
    message: z.string(),
  })
  .strict();

// cost.unattributable is retained in the event registry for compatibility but
// is no longer thrown for missing cost (cost-unknown is now an allowed state
// recorded as cost_usd = NULL). Kept harmless per the locked contract.
export const CostUnattributablePayload = z
  .object({
    taskId: z.string(),
    cli: z.string(),
    authRef: z.string(),
    reason: z.string(),
    inputTokens: z.number().int().optional(),
    outputTokens: z.number().int().optional(),
    cachedInputTokens: z.number().int().optional(),
  })
  .strict();

// Usage monitoring (P2A-cost-monitors): codexbar (live subscription windows)
// and ccusage (token-consumption accounting), captured in the runner over SSH.

// One concurrent rolling subscription window, mirroring the codexbar shape.
const SubscriptionWindowSummary = z
  .object({
    slot: z.enum(["primary", "secondary", "tertiary"]),
    usedPercent: z.number(),
    resetsAt: z.string(),
    windowMinutes: z.number().int(),
    resetDescription: z.string(),
  })
  .strict();

// usage.window.observed — the live subscription-window state for a provider.
export const UsageWindowObservedPayload = z
  .object({
    provider: z.string(),
    windows: z.array(SubscriptionWindowSummary),
    creditsRemaining: z.number().nullable(),
    source: z.string(),
    capturedAt: z.string(),
  })
  .strict();

// usage.window.pressure — a window is at/over the configured pressure
// threshold; carries the offending slot so the workflow can escalate.
export const UsageWindowPressurePayload = z
  .object({
    provider: z.string(),
    slot: z.enum(["primary", "secondary", "tertiary"]),
    usedPercent: z.number(),
    resetsAt: z.string(),
  })
  .strict();

// usage.accounting.observed — token-consumption accounting from ccusage. The
// token buckets are disjoint (same convention as the cost schema); costUsd is
// best-effort and null unless ccusage reports a positive figure.
export const UsageAccountingObservedPayload = z
  .object({
    cli: z.string(),
    totals: z
      .object({
        inputTokens: z.number().int(),
        cachedInputTokens: z.number().int(),
        cacheCreationTokens: z.number().int(),
        outputTokens: z.number().int(),
        reasoningOutputTokens: z.number().int(),
        totalTokens: z.number().int(),
      })
      .strict(),
    costUsd: z.number().nullable(),
    capturedAt: z.string(),
  })
  .strict();
