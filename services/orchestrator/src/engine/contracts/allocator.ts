export interface SshTarget {
  host: string;
  port: number;
  username: string;
  hostKeyFingerprint: string;
  identitySecretRef: string;
}

export interface AllocationRequest {
  runId: string;
  projectId: string;
  runnerImage: string;
  identitySecretRef: string;
  /**
   * Optional list of Vault references whose values the allocator must
   * materialize into the runner's `CODEX_HOME` mount before signaling that
   * the runner is ready. The allocator owns the lifetime of any files
   * derived from these refs and wipes them on release.
   */
  vaultRefs?: string[];
}

export interface RunnerAllocation {
  runnerId: string;
  target: SshTarget;
  imageSha: string;
}

export type ReleaseReason = "completed" | "failed" | "abandoned";

export interface Allocator {
  allocate(request: AllocationRequest): Promise<RunnerAllocation>;
  /**
   * Release the runner. `reason` is best-effort metadata for the allocator's
   * finalizer log; allocator implementations must always run the same
   * destroy + wipe path regardless of the reason. Calling release on an
   * already-released runner is a no-op.
   */
  release(runnerId: string, reason?: ReleaseReason): Promise<void>;
}

export class FakeAllocator implements Allocator {
  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    return {
      runnerId: `runner_${request.runId}`,
      imageSha: `${request.runnerImage}@sha256:fake`,
      target: {
        host: "runner",
        port: 22,
        username: "tanren",
        hostKeyFingerprint: "SHA256:fake",
        identitySecretRef: request.identitySecretRef
      }
    };
  }

  async release(): Promise<void> {}
}
