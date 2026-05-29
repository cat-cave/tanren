/**
 * phase1FixtureRoles — role-event + cost-accounting helpers for the phase-1
 * fixture workflow. Extracted from phase1Fixture.ts to keep that file under the
 * 500-line architecture cap. These translate a fixture task kind into the
 * writer/checker/auditor lifecycle events and record the mandatory per-task
 * token accounting (cost best-effort).
 */
import type { CostRecorder } from "../costs/index.js";
import type { EventName, EventPayload } from "../events/index.js";
import { emptyTokenUsage, type TokenUsage } from "../providers/types.js";
import type { Phase1FixtureRunContext } from "./phase1Fixture.js";

export type Phase1TaskKind = "write" | "check" | "audit";

type AppendEvent = <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>;

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Maps a thrown error from a fixture task body to the typed failure payload
// persisted on the row + emitted on the task.failed event. Cost-unknown is no
// longer a failure (the recorder records cost_usd = NULL instead), so there is
// no cost-specific failure branch here.
export function failureForFixtureTask(kind: Phase1TaskKind, error: unknown): { kind: string; message: string } {
  return { kind: `${kind}_failed`, message: messageFromError(error) };
}

export interface FixtureCostInput {
  recorder: CostRecorder;
  context: Phase1FixtureRunContext;
  taskId: string;
  cli: "codex" | "claude" | "opencode" | "aider" | "fake";
  model: string;
  authRef: string;
  tokenUsage: TokenUsage | undefined;
  runtimeSeconds: number;
  rawUsage: Record<string, unknown>;
}

// recordFixtureCost is the single mandatory call at fixture task completion.
// Token accounting is mandatory; cost is best-effort (NULL when the ref has no
// per-token price basis), so this never fails the task for missing cost.
export async function recordFixtureCost(input: FixtureCostInput): Promise<void> {
  const tokens = input.tokenUsage ?? emptyTokenUsage;
  await input.recorder.record(
    {
      runId: input.context.runId,
      taskId: input.taskId,
      specId: input.context.specId,
      projectId: input.context.projectId,
      cli: input.cli,
      model: input.model,
      authRef: input.authRef,
      runtimeSeconds: input.runtimeSeconds,
    },
    tokens,
    input.rawUsage,
  );
}

export function secondsSince(startedAtMs: number): number {
  const elapsed = (Date.now() - startedAtMs) / 1000;
  return elapsed > 0 ? elapsed : 0.001;
}

export async function appendRoleStarted(appendEvent: AppendEvent, kind: Phase1TaskKind, taskId: string): Promise<void> {
  if (kind === "write") {
    await appendEvent("writer.started", { taskKind: kind }, taskId);
    return;
  }
  if (kind === "check") {
    await appendEvent("checker.started", { taskKind: kind }, taskId);
    return;
  }
  await appendEvent("auditor.started", { taskKind: kind }, taskId);
}

export async function appendRoleCompleted<TOutput>(
  appendEvent: AppendEvent,
  kind: Phase1TaskKind,
  output: TOutput,
  taskId: string,
): Promise<void> {
  if (kind === "write") {
    await appendEvent("writer.completed", output as EventPayload<"writer.completed">, taskId);
    return;
  }
  if (kind === "check") {
    await appendEvent("checker.completed", output as EventPayload<"checker.completed">, taskId);
    return;
  }
  await appendEvent("auditor.completed", output as EventPayload<"auditor.completed">, taskId);
}

export async function appendRoleFailed(
  appendEvent: AppendEvent,
  kind: Phase1TaskKind,
  failure: { kind: string; message: string },
  taskId: string,
): Promise<void> {
  if (kind === "write") {
    await appendEvent("writer.failed", failure, taskId);
    return;
  }
  if (kind === "check") {
    await appendEvent("checker.failed", failure, taskId);
    return;
  }
  await appendEvent("auditor.failed", failure, taskId);
}
