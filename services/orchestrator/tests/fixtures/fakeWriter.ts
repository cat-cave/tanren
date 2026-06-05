// TEST FIXTURE ONLY. The fake writer is a connectivity/test stand-in — it writes
// a synthetic HELLO.md mutation over SSH and captures the resulting git diff. It
// MUST NOT exist in any production/runtime path: production code resolves the
// real writer adapter from the project's role-routing config. This fixture lives
// under tests/ so it is unreachable from src/.
import type { RunnerHandle } from "../../src/engine/contracts/allocator.js";
import type { CommandSubstrate } from "../../src/engine/contracts/commandSubstrate.js";
import type { WriterAdapter, WriterResult } from "../../src/engine/providers/types.js";
import { fakeSelfHostedAuthRef } from "./fakeAnswerers.js";
import { captureGitMutation, runFakeWriterMutation } from "./workspaceGit.js";

export interface FakeWriterDependencies {
  ssh: CommandSubstrate;
  target: RunnerHandle;
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
