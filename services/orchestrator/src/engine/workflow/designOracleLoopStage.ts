// The WS-D4 native design-fidelity ORACLE loop stage — the verify→re-drive half of the
// design loop. Split out of loopStages.ts to keep both modules under the 500-line
// architecture cap (and to give the oracle's own stall recovery a clean home). The cost +
// event + task-row accounting is preserved exactly as the demo-run slot's.
import { randomUUID } from "node:crypto";
import type { ActorContext } from "../../auth/schemas.js";
import type { ActorRef } from "../state/actor.js";
import type { DesignOracleAnswer } from "../answerers/schemas/index.js";
import type { Finding } from "../contracts/findings.js";
import { emitStageTiming } from "../observability/index.js";
import type { AnswererAdapter } from "../providers/types.js";
import { runDesignOracleStage } from "./designOracle/designOracle.js";
import type { LoopQueryClient, StageBase } from "./loopStages.js";
import { runAnswererStageWithRecovery } from "./loopStageRecovery.js";
import { recordAnswererCost, secondsSince } from "./subtaskCost.js";
import { insertChildTask, markTaskDone } from "./subtaskTasks.js";

export interface DesignOracleLoopStageInput extends StageBase {
  adapter: AnswererAdapter<DesignOracleAnswer>;
  // The query client the oracle reads the contract + entity graph through (the run's
  // org-scoped pool — RLS-scoped, actor-authorized).
  client: LoopQueryClient;
  projectId: string;
  // The org-scope carrier for the entity-graph reads + the audit/event actor for the
  // contract store reads (built in plannerRun from the run's org/project).
  actor: ActorContext;
  actorRef: ActorRef;
  baselineSha: string;
}

/**
 * Run the native design-fidelity ORACLE stage (WS-D4) — the verify→re-drive half of the
 * design loop. Mirrors `runDemoRunStage`'s wiring (task row + events + cost), delegating
 * the contract read + ref resolution + answerer invocation to the reusable
 * `runDesignOracleStage` oracle module. Returns the normalized fidelity findings for the
 * loop's ONE triage input. No kill-switch; a project with NO design contract no-ops
 * cleanly (empty findings, no answerer call, no cost) — never a fabricated default.
 *
 * STAGE-LOCAL stall recovery: the oracle's answerer call (inside `runDesignOracleStage`) is
 * wrapped so a transient stall re-drives THIS stage in place — the spec loop's sibling
 * progress is preserved, never a whole-spec restart — while a genuinely-wedged oracle
 * escalates loudly via the shared convergence judgment. A no-contract no-op never stalls.
 */
export async function runDesignOracleLoopStage(
  args: DesignOracleLoopStageInput,
): Promise<{ findings: Finding[]; designOracleTaskId: string | undefined }> {
  // Run the oracle first; only materialize a task row / events / cost when a contract was
  // genuinely verified. A no-contract project produces no task (the explicit empty state),
  // mirroring how the demo-run slot is simply skipped when there is nothing to do.
  const result = await runAnswererStageWithRecovery("designOracle", () =>
    runDesignOracleStage({
      client: args.client,
      projectId: args.projectId,
      actor: args.actor,
      actorRef: args.actorRef,
      adapter: args.adapter,
      baselineSha: args.baselineSha,
      workspacePath: args.workspacePath,
    }),
  );
  if (!result.hasContract) {
    return { findings: [], designOracleTaskId: undefined };
  }

  // A contract WAS verified — record the stage as a task with its verdict + cost, exactly
  // like the demo-run slot. The oracle already invoked the answerer; the cost record below
  // attributes that real call (token telemetry surfaced by the same adapter instance).
  const startedAt = Date.now();
  const designOracleTaskId = `task_${randomUUID()}`;
  await insertChildTask(
    args.pool,
    {
      taskId: designOracleTaskId,
      runId: args.runId,
      kind: "designOracle",
      title: "design-oracle verify",
      parentTaskId: args.plannerTaskId,
      agentKind: "answerer",
      cli: args.adapter.cli,
      model: null,
    },
    args.writer,
  );
  await args.appendEvent("task.started", { taskKind: "designOracle" }, designOracleTaskId);
  await args.appendEvent("designOracle.started", { taskKind: "designOracle" }, designOracleTaskId);
  emitStageTiming("audit", Date.now() - startedAt, { runId: args.runId });
  await args.appendEvent(
    "designOracle.verdict",
    {
      runId: args.runId,
      contractVersion: result.contractVersion ?? 0,
      verificationMode: result.verificationMode ?? "",
      summary: result.summary ?? "",
      findings: result.findings,
    },
    designOracleTaskId,
  );
  await recordAnswererCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    role: "designOracle",
    taskId: designOracleTaskId,
    model: "tanren-design-oracle",
    runtimeSeconds: secondsSince(startedAt),
    rawUsage: { role: "designOracle" },
  });
  await markTaskDone(args.pool, designOracleTaskId, "passed", args.writer);
  await args.appendEvent("task.completed", { taskKind: "designOracle" }, designOracleTaskId);
  return { findings: result.findings, designOracleTaskId };
}
