// Cost-record hook for the hello-world workflow. Phase 1 fixture uses an
// inline equivalent in phase1Fixture.ts; the two will converge under
// P2A-0012's planner-feedback-loops dispatcher refactor. Until then keeping
// the hello flow's cost recording in its own module keeps helloRun.ts under
// the architecture-check 500-line cap.
import type { CostRecorder } from "../costs/index.js";
import type { TokenUsage } from "../providers/types.js";

export interface HelloCostScope {
  runId: string;
  specId: string;
  projectId: string;
}

export interface HelloCostInput {
  recorder: CostRecorder;
  scope: HelloCostScope;
  taskId: string;
  cli: "codex" | "claude" | "opencode" | "fake";
  model: string;
  authRef: string;
  tokenUsage?: TokenUsage;
}

// Fake hello-world adapters resolve as opportunity_computed (PROJECT_BRIEF
// §4.2): runtime-based dollar figures with the self-hosted rate. The fixed
// 1-second runtime is intentional — hello-world runs do not exercise real
// LLMs, so the cost row carries the audit-trail shape, not a meaningful
// dollar value.
export async function recordHelloTaskCost(input: HelloCostInput): Promise<void> {
  const tokens = input.tokenUsage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
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
