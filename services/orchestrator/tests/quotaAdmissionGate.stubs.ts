// Trivial worker-dependency stubs for the quota-admission-gate test. Extracted
// from the test file so that module groups only the stateful fakes the
// assertions read (GatePool, StubPolicy) — keeps each file's class count low.

import type { AllocationRequest, Allocator, RunnerAllocation, SshTarget } from "../src/engine/contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";

export const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

export class StubAllocator implements Allocator {
  async allocate(_request: AllocationRequest): Promise<RunnerAllocation> {
    return { runnerId: "r", imageSha: "sha", target };
  }
  async release(): Promise<void> {}
}

export class StubSsh implements SshSubstrate {
  async run(_target: SshTarget, _command: SshCommand): Promise<SshCommandResult> {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

export class StubGitHub implements GitHubHttpClient {
  async request(_input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    return { status: 200, body: {} };
  }
}
