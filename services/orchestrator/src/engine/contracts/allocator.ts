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
}

export interface RunnerAllocation {
  runnerId: string;
  target: SshTarget;
  imageSha: string;
}

export interface Allocator {
  allocate(request: AllocationRequest): Promise<RunnerAllocation>;
  release(runnerId: string): Promise<void>;
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
        identitySecretRef: `runner/${request.runId}/identity`
      }
    };
  }

  async release(): Promise<void> {}
}
