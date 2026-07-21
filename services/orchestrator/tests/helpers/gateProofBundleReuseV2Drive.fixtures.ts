import type { RunnerHandle } from "../../src/engine/contracts/allocator.js";
import type { BatchAuthorityBinding, BatchCheckVerdict } from "../../src/engine/contracts/batchMergeCoordinator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../../src/engine/contracts/commandSubstrate.js";
import type { MergeQueueEntry } from "../../src/engine/contracts/mergeCoordinator.js";
import type { BatchNodeDriveFacts } from "../../src/engine/merge/batchIntegrationNodeDrive.js";

export const reuseV2Target: RunnerHandle = {
  backend: "ssh",
  host: "gate-reuse-v2-runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:gate-reuse-v2",
  identitySecretRef: "runner/gate-reuse-v2",
};

export class ReuseV2DiffSubstrate implements CommandSubstrate {
  async run(_target: RunnerHandle, _command: RunnerCommand): Promise<CommandResult> {
    return { exitCode: 0, stdout: "src/gate-reuse-v2.ts\0", stderr: "" };
  }
}

export function reuseV2Facts(input: {
  baseSha: string;
  headSha: string;
  treeHash: string;
  members: ReadonlyArray<{ specId: string; runId: string; branch: string; headSha: string }>;
  quarantineVersion: string;
}): BatchNodeDriveFacts {
  return {
    orgId: "org_gate_reuse_v2",
    projectId: "project_gate_reuse_v2",
    baseBranch: "main",
    repoUrl: "https://example.test/tanren/gate-reuse-v2.git",
    runnerImage: "runner:v0",
    tailSpecId: input.members.at(-1)?.specId ?? "missing-member",
    policyVersion: "1",
    ...input,
  };
}

export function reuseV2Entry(specId: string, runId: string): MergeQueueEntry {
  return {
    orgId: "org_gate_reuse_v2",
    projectId: "project_gate_reuse_v2",
    queueId: `queue-${specId}`,
    runId,
    specId,
    prUrl: `https://example.test/${specId}`,
    prNumber: 1,
    dependsOn: [],
    priority: "P1",
    orderKey: 1,
    partitionId: "default",
  };
}

export async function requireReuseV2Pass(result: Promise<BatchCheckVerdict>): Promise<BatchAuthorityBinding> {
  const verdict = await result;
  if (verdict.result !== "pass" || verdict.authorityBinding === undefined) {
    throw new Error(`expected a fresh V2 pass, received ${JSON.stringify(verdict)}`);
  }
  return verdict.authorityBinding;
}
