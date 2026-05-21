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
    return {
      diff: "diff --git a/HELLO.md b/HELLO.md\n+hello from tanren\n",
      commits: [{ sha: "fake-commit", message: "hello world" }],
      exitReason: "completed",
      tokenUsage: { inputTokens: 32, outputTokens: 16, cachedTokens: 0 }
    };
  }
};

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
