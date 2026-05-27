import { z } from "zod";

// Infrastructure-side events: runner, allocator, workspace, credential, cost.
// These payloads describe state of the underlying runtime substrate.

const SshTargetSummary = z
  .object({
    host: z.string(),
    port: z.number().int(),
    username: z.string(),
    hostKeyFingerprint: z.string()
  })
  .strict();

const RunnerAllocationSummary = z
  .object({
    runnerId: z.string(),
    imageSha: z.string(),
    target: SshTargetSummary
  })
  .strict();

export const AllocatorRequestedPayload = z
  .object({
    allocator: z.string(),
    runnerImage: z.string(),
    identitySecretRef: z.string()
  })
  .strict();

export const AllocatorAllocatedPayload = RunnerAllocationSummary;

export const AllocatorFailedPayload = z
  .object({
    message: z.string()
  })
  .strict();

export const RunnerAllocatedPayload = RunnerAllocationSummary;

export const RunnerReleasedPayload = z
  .object({
    runnerId: z.string()
  })
  .strict();

const SshCommandFailure = z
  .union([
    z.object({ reason: z.string(), message: z.string().optional() }).strict(),
    z.object({ reason: z.string() }).strict()
  ])
  .or(z.record(z.string(), z.unknown()));

const SshCommandResultSummary = z
  .object({
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    signal: z.string().optional(),
    timedOut: z.boolean(),
    failure: SshCommandFailure.optional()
  })
  .strict();

export const RunnerFailedPayload = z
  .object({
    runnerId: z.string(),
    command: z.string(),
    result: SshCommandResultSummary
  })
  .strict();

export const WorkspacePreparedPayload = z
  .object({
    runnerId: z.string().optional(),
    workspacePath: z.string(),
    repoUrl: z.string().optional(),
    targetBranch: z.string().optional()
  })
  .strict();

export const WorkspaceGitCapturedPayload = z
  .object({
    workspacePath: z.string(),
    commits: z.array(
      z.object({ sha: z.string(), message: z.string() }).strict()
    ),
    diffBytes: z.number().int()
  })
  .strict();

export const WorkspaceFailedPayload = z
  .object({
    runnerId: z.string().optional(),
    workspacePath: z.string(),
    message: z.string()
  })
  .strict();

const CredentialReference = z
  .object({
    credentialKind: z.string(),
    ref: z.string(),
    redacted: z.literal(true)
  })
  .strict();

export const CredentialRequestedPayload = CredentialReference;
export const CredentialLoadedPayload = CredentialReference;
export const CredentialFailedPayload = z
  .object({
    ref: z.string().optional(),
    message: z.string()
  })
  .strict();

export const CostResolvedPayload = z
  .object({
    taskId: z.string(),
    cli: z.string(),
    provider: z.string(),
    model: z.string(),
    costUsd: z.string(),
    pricingMode: z.string(),
    costSource: z.string()
  })
  .strict();

export const CostFailedPayload = z
  .object({
    taskId: z.string().optional(),
    message: z.string()
  })
  .strict();
