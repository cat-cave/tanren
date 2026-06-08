// The AUDITOR stage of the planner-feedback loop, split out of `subtaskStages.ts` to
// keep both modules under the 500-line architecture cap. Owns the single auditor
// invocation (task row, event append, cost record) AND the RECOVERABLE handling of an
// auditor schema-parse miss: rather than dead-ending the run, a malformed/missing audit
// verdict loops back to the planner via the same bounded rework path the subtask loop
// already drives, while the land gate's fail-closed synthetic-P0 still blocks any merge
// without a real `auditor.verdict`.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { AuditAnswer, PlanAnswer } from "../answerers/schemas/index.js";
import { normalizeFinding } from "../answerers/schemas/index.js";
import { emitStageTiming } from "../observability/index.js";
import type { AnswererAdapter } from "../providers/types.js";
import { AnswererSchemaValidationError } from "../providers/codex.js";
import {
  decideAuditorOutcome,
  invokeAuditor,
  type AuditorDecision,
  type AuditorSpecContext,
} from "./auditor/auditor.js";
import { recordAnswererCost, secondsSince, type SubtaskCostContext } from "./subtaskCost.js";
import { insertChildTask, markTaskDone, markTaskFailed } from "./subtaskTasks.js";
import type { StageAppendEvent } from "./subtaskStages.js";

type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface AuditorStageInput {
  pool: LoopQueryClient;
  /** route the auditor task INSERT/UPDATE remote when wired. */
  writer?: RunStateWriter;
  costCtx: SubtaskCostContext;
  adapter: AnswererAdapter<AuditAnswer>;
  runId: string;
  workspacePath: string;
  plannerTaskId: string;
  plan: PlanAnswer;
  // The run base the combined writer change is diffed against. The auditor
  // inspects the change itself in its read-only workspace rather than receiving
  // an injected combined diff. Omitted by unit callers without a base sha.
  baseSha?: string;
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  timeoutMs: number;
  appendEvent: StageAppendEvent;
  buildUsage?: (input: { auditorTaskId: string; verdict: AuditAnswer }) => Record<string, unknown>;
}

export async function runAuditorStage(
  args: AuditorStageInput,
): Promise<{ decision: AuditorDecision; auditorTaskId: string }> {
  const auditorTaskId = `task_${randomUUID()}`;
  await insertChildTask(
    args.pool,
    {
      taskId: auditorTaskId,
      runId: args.runId,
      kind: "audit",
      title: "audit plan",
      parentTaskId: args.plannerTaskId,
      agentKind: "answerer",
      cli: args.adapter.cli,
      model: null,
    },
    args.writer,
  );
  await args.appendEvent("task.started", { taskKind: "audit" }, auditorTaskId);
  await args.appendEvent("auditor.started", { taskKind: "audit" }, auditorTaskId);
  const auditorContext: AuditorSpecContext = {
    specTitle: args.specTitle,
    specDescription: args.specDescription,
    acceptanceCriteria: args.acceptanceCriteria,
    subtasks: args.plan.subtasks,
    baselineSha: args.baseSha ?? "HEAD",
  };
  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof invokeAuditor>>;
  try {
    result = await invokeAuditor(args.adapter, {
      context: auditorContext,
      timeoutMs: args.timeoutMs,
      workspace: args.workspacePath,
    });
  } catch (error) {
    // RECOVERABLE prompt-repair (NOT a permanent dead-end): the auditor's model emitted
    // output that failed the AuditAnswer schema parse (malformed/missing findings). No
    // `auditor.verdict` is written, so the durable record stays UN-AUDITED — the land
    // gate's fail-closed synthetic-P0 (landSignals.auditMissingFinding) still BLOCKS a
    // merge. But rather than letting the throw escape to the catch-all run-`failed`
    // (a dead-end on a single model schema miss, even for clean code), surface it as an
    // audit-STAGE rejection that loops back to the planner via the SAME bounded rework
    // path (maxPlannerRerunsPerSpec) — a re-plan + re-audit can recover. A non-schema
    // error (timeout / usage-limit / infra) still propagates to its own handling.
    if (!(error instanceof AnswererSchemaValidationError)) throw error;
    return await rejectAuditorForSchemaMiss(args, auditorTaskId, error);
  }
  const runtimeSeconds = secondsSince(startedAt);
  emitStageTiming("audit", Date.now() - startedAt, { runId: args.runId });
  // S3: the auditor emits FINDINGS as its sole severity currency (no dual-emit flag).
  // `findings` is ALWAYS present on `auditor.verdict` — it is the EXPLICIT P0–P3 list
  // the DagLifecycle read model + the `auditPosture` policy (the live merge gate) read.
  // S3a: the auditor emits FINDINGS as its sole severity currency. `findings` is a
  // REQUIRED field on the parsed `AuditAnswer` (no `.default([])`) — so the adapter's
  // verdict ALWAYS carries a real, explicitly-emitted findings array. We persist it
  // VERBATIM (no `?? []` coalesce): a clean `[]` here can ONLY mean the auditor
  // explicitly emitted an empty list, never a missing/omitted one (that would have
  // failed to parse upstream). `normalizeFinding` collapses a strict-schema
  // `fixHint: null` to an absent key so the stored shape matches the frozen
  // `{ fixHint?: string }` contract. The `passed`/`reasoning`/`recommendedAction` fields
  // are persisted as NARRATION only — no decision reads them.
  await args.appendEvent(
    "auditor.verdict",
    {
      runId: args.runId,
      passed: result.verdict.passed,
      reasoning: result.verdict.reasoning,
      outstandingBehaviorIds: [...result.verdict.outstandingBehaviorIds],
      recommendedAction: result.verdict.recommendedAction,
      findings: result.verdict.findings.map((f) => normalizeFinding(f)),
    },
    auditorTaskId,
  );
  await recordAnswererCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    taskId: auditorTaskId,
    model: "tanren-auditor",
    runtimeSeconds,
    rawUsage: args.buildUsage?.({ auditorTaskId, verdict: result.verdict }) ?? { role: "auditor" },
  });
  const decision = decideAuditorOutcome(result.verdict);
  if (decision.kind === "pass") {
    await markTaskDone(args.pool, auditorTaskId, "passed", args.writer);
    await args.appendEvent("task.completed", { taskKind: "audit" }, auditorTaskId);
    return { decision, auditorTaskId };
  }
  await markTaskDone(args.pool, auditorTaskId, "rejected_by_auditor", args.writer);
  await args.appendEvent(
    "auditor.rejected",
    {
      runId: args.runId,
      auditTaskId: auditorTaskId,
      reason: decision.reason,
      outstandingBehaviorIds: [...decision.outstandingBehaviorIds],
      recommendedAction: decision.action,
    },
    auditorTaskId,
  );
  await args.appendEvent("task.completed", { taskKind: "audit" }, auditorTaskId);
  return { decision, auditorTaskId };
}

// The FIXED, non-secret reason an auditor schema-parse miss loops back to the planner.
// NOT the raw parse error (it can embed model output / response text); the full error is
// logged via console.warn for diagnosis.
const AUDITOR_SCHEMA_MISS_REASON =
  "the auditor produced output that failed the audit schema parse; re-planning to obtain a well-formed audit verdict";

/**
 * Turn an auditor schema-parse miss into a RECOVERABLE loop-to-planner rejection (not a
 * run-`failed` dead-end). Marks the audit task failed, appends a diagnostic
 * `auditor.rejected` (loop_to_planner), and returns the loop-back decision so the subtask
 * loop routes through the SAME bounded planner-rework path. Fail-closed is preserved: no
 * `auditor.verdict` is written, so the land gate's synthetic-P0 still blocks the merge.
 */
async function rejectAuditorForSchemaMiss(
  args: AuditorStageInput,
  auditorTaskId: string,
  error: AnswererSchemaValidationError,
): Promise<{ decision: AuditorDecision; auditorTaskId: string }> {
  console.warn(`[auditor] schema-parse miss for run ${args.runId} — looping back to the planner to re-audit:`, error);
  await markTaskFailed(args.pool, auditorTaskId, "auditor_schema_invalid", args.writer);
  const decision: AuditorDecision = {
    kind: "reject",
    action: "loop_to_planner",
    reason: AUDITOR_SCHEMA_MISS_REASON,
    outstandingBehaviorIds: [],
  };
  await args.appendEvent(
    "auditor.rejected",
    {
      runId: args.runId,
      auditTaskId: auditorTaskId,
      reason: decision.reason,
      outstandingBehaviorIds: [],
      recommendedAction: decision.action,
    },
    auditorTaskId,
  );
  await args.appendEvent("task.completed", { taskKind: "audit" }, auditorTaskId);
  return { decision, auditorTaskId };
}
