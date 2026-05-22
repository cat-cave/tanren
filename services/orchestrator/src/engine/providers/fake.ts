import type { SshTarget } from "../contracts/allocator.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { captureGitMutation, runFakeWriterMutation } from "../workspace/index.js";
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "./answererSchemas.js";
import type { AnswererAdapter, WriterAdapter, WriterResult } from "./types.js";

export interface FakeWriterDependencies {
  ssh: SshSubstrate;
  target: SshTarget;
}

export const fakePlanner: AnswererAdapter<PlanAnswer> = {
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

export const fakeChecker: AnswererAdapter<CheckAnswer> = {
  kind: "answerer",
  cli: "fake",
  async runAnswerer() {
    return { done: true, reason: "Synthetic writer output satisfies the hello-world criteria.", suggested_fixes: null };
  }
};

export const fakeAuditor: AnswererAdapter<AuditAnswer> = {
  kind: "answerer",
  cli: "fake",
  async runAnswerer() {
    return {
      verified: true,
      criteria_status: {
        criteria: [
          {
            criterion: "The orchestrator persists a completed synthetic run",
            satisfied: true,
            reason: "The structured checker accepted the writer output."
          }
        ]
      },
      reason: "All hello-world checks completed."
    };
  }
};
