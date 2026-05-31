// TEST FIXTURE ONLY. The fake writer is a connectivity/test stand-in — it writes
// a synthetic HELLO.md mutation over SSH and captures the resulting git diff. It
// MUST NOT exist in any production/runtime path: production code resolves the
// real writer adapter from the project's role-routing config. This fixture lives
// under tests/ so it is unreachable from src/.
import type { SshTarget } from "../../src/engine/contracts/allocator.js";
import type { SshSubstrate } from "../../src/engine/contracts/sshSubstrate.js";
import { fakeSelfHostedAuthRef } from "../../src/engine/providers/fake.js";
import type { WriterAdapter, WriterResult } from "../../src/engine/providers/types.js";
import { captureGitMutation, runFakeWriterMutation } from "../../src/engine/workspace/index.js";

export interface FakeWriterDependencies {
  ssh: SshSubstrate;
  target: SshTarget;
}

export function createFakeWriter(dependencies: FakeWriterDependencies): WriterAdapter {
  return {
    kind: "writer",
    cli: "fake",
    authRef: fakeSelfHostedAuthRef,
    async runWriter(opts): Promise<WriterResult> {
      const input = {
        ssh: dependencies.ssh,
        target: dependencies.target,
        workspacePath: opts.workspace,
        timeoutMs: opts.timeoutMs,
      };
      await runFakeWriterMutation(input);
      return await captureGitMutation(input);
    },
  };
}
