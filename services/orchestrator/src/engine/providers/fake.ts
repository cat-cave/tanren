import type { SshTarget } from "../contracts/allocator.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { captureGitMutation, runFakeWriterMutation } from "../workspace/index.js";
import type { AnswererAdapter, WriterAdapter, WriterResult } from "./types.js";

export interface FakePlan {
  subtasks: Array<{
    title: string;
    acceptanceCriteria: string[];
  }>;
}

export interface FakeCheck {
  done: boolean;
  reason: string;
}

export interface FakeAudit {
  verified: boolean;
  reason: string;
}

export interface FakeWriterDependencies {
  ssh: SshSubstrate;
  target: SshTarget;
}

export const fakePlanner: AnswererAdapter<FakePlan> = {
  kind: "answerer",
  cli: "fake",
  async runAnswerer() {
    return {
      subtasks: [
        {
          title: "Return hello-world status",
          acceptanceCriteria: ["The orchestrator persists a completed synthetic run"]
        }
      ]
    };
  }
};

export const fakeWriter: WriterAdapter = {
  kind: "writer",
  cli: "fake",
  async runWriter(): Promise<WriterResult> {
    throw new Error("fake writer requires a runner SSH target; use createFakeWriter");
  }
};

export function createFakeWriter(dependencies: FakeWriterDependencies): WriterAdapter {
  return {
    kind: "writer",
    cli: "fake",
    async runWriter(opts): Promise<WriterResult> {
      const input = {
        ssh: dependencies.ssh,
        target: dependencies.target,
        workspacePath: opts.workspace,
        timeoutMs: opts.timeoutMs
      };
      await runFakeWriterMutation(input);
      return await captureGitMutation(input);
    }
  };
}

export const fakeChecker: AnswererAdapter<FakeCheck> = {
  kind: "answerer",
  cli: "fake",
  async runAnswerer() {
    return { done: true, reason: "Synthetic writer output satisfies the hello-world criteria." };
  }
};

export const fakeAuditor: AnswererAdapter<FakeAudit> = {
  kind: "answerer",
  cli: "fake",
  async runAnswerer() {
    return { verified: true, reason: "All hello-world checks completed." };
  }
};
