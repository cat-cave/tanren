// Cost-record hook for the hello-world workflow. Phase 1 fixture uses an
// inline equivalent in phase1Fixture.ts; the two will converge under
// P2A-0012's planner-feedback-loops dispatcher refactor. Until then keeping
// the hello flow's cost recording in its own module keeps helloRun.ts under
// the architecture-check 500-line cap.
import type { CostRecorder } from "../costs/index.js";
import { emptyTokenUsage, type TokenUsage } from "../providers/types.js";

export interface HelloCostScope {
  runId: string;
  specId: string;
  projectId: string;
}

export interface HelloCostInput {
  recorder: CostRecorder;
  scope: HelloCostScope;
  taskId: string;
  cli: "codex" | "claude" | "opencode" | "aider" | "fake";
  model: string;
  authRef: string;
  tokenUsage?: TokenUsage;
}

// Fake hello-world adapters resolve as self-hosted billing (PROJECT_BRIEF
// §4.2): no per-call dollar basis, so the cost row carries cost_usd = NULL
// with cost_basis = 'unknown'. The token breakdown still lands for audit. The
// fixed 1-second runtime is intentional — hello-world runs do not exercise
// real LLMs.
export async function recordHelloTaskCost(input: HelloCostInput): Promise<void> {
  const tokens = input.tokenUsage ?? emptyTokenUsage;
  await input.recorder.record(
    {
      runId: input.scope.runId,
      taskId: input.taskId,
      specId: input.scope.specId,
      projectId: input.scope.projectId,
      cli: input.cli,
      model: input.model,
      authRef: input.authRef,
      runtimeSeconds: 1
    },
    tokens,
    { source: "hello-world fake adapter" }
  );
}
