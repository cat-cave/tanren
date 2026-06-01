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
   * The org the run belongs to. Threaded end-to-end so a backend that persists
   * a `runners` row (a tenant table) writes it under the org's RLS scope rather
   * than off-RLS via a BYPASSRLS role. Optional on the contract so scaffolded /
   * benchmark / fixture constructions keep compiling, but the live worker path
   * always supplies it and the sidecar allocator SERVICE requires it.
   */
  orgId?: string;
  /**
   * Optional list of Vault references whose values the allocator must
   * materialize into the runner's `CODEX_HOME` mount before signaling that
   * the runner is ready. The allocator owns the lifetime of any files
   * derived from these refs and wipes them on release.
   */
  vaultRefs?: string[];
  /**
   * Optional run labels used by the allocator router (P3-0027) to pick an
   * allocator kind and apply its pool policy. Allocators that do not route on
   * labels ignore this field. Absent / empty means "use the default kind".
   */
  labels?: Record<string, string>;
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
        identitySecretRef: request.identitySecretRef,
      },
    };
  }

  async release(): Promise<void> {}
}
