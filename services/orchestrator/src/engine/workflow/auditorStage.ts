// The AUDITOR stage of the spec-implementation loop, split out of `subtaskStages.ts`
// to keep both modules under the 500-line architecture cap. Owns the single auditor
// invocation (task row, event append, cost record) AND the RECOVERABLE handling of an
// auditor schema-parse miss.
//
// SPEC-LOOP REDESIGN (docs/roadmap/spec-loop-redesign.md): the auditor is
// FINDINGS-ONLY and renders NO verdict. `runAuditorStage` returns the emitted findings
// (the frozen `Finding` currency); the loop COLLECTS them with the spec-gate CI-as-P0
// + demo findings and routes the union through TRIAGE + CONVERGENCE. There is NO
// auditor-level pass/loop/halt decision. A schema-parse miss surfaces as a synthetic
// P0 finding (fail-closed) so the loop never silently treats an un-audited run as
// clean, while the land gate's fail-closed synthetic-P0 still blocks any merge without
// a real `auditor.verdict`.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { AuditAnswer, PlanAnswer } from "../answerers/schemas/index.js";
import type { Finding } from "../contracts/findings.js";
import { emitStageTiming } from "../observability/index.js";
import type { AnswererAdapter } from "../providers/types.js";
import { AnswererSchemaValidationError } from "../providers/codex.js";
import { auditorFindings, invokeAuditor, type AuditorSpecContext } from "./auditor/auditor.js";
import { runAnswererStageWithRecovery } from "./loopStageRecovery.js";
import { classifyStageFailureKind, stageFailureMessage } from "./stageFailureKind.js";
import { recordAnswererCost, secondsSince, type SubtaskCostContext } from "./subtaskCost.js";
import { insertChildTask, markTaskDone, markTaskFailed } from "./subtaskTasks.js";
import type { StageAppendEvent } from "./subtaskStages.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("auditor");

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
  appendEvent: StageAppendEvent;
  buildUsage?: (input: { auditorTaskId: string; verdict: AuditAnswer }) => Record<string, unknown>;
}

export interface AuditorStageResult {
  // The auditor's emitted findings (the frozen `Finding` currency). On a schema-parse
  // miss this is a single synthetic P0 (fail-closed) so the loop never reads an
  // un-audited run as clean.
  findings: Finding[];
  auditorTaskId: string;
}

export async function runAuditorStage(args: AuditorStageInput): Promise<AuditorStageResult> {
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
    // STAGE-LOCAL stall recovery: a TRANSIENT stall re-drives the auditor IN PLACE
    // (sibling progress preserved); a wedged auditor escalates loudly. Schema-miss
    // recovery + the apex v51 per-stage emit-on-throw are split in the catch below.
    result = await runAnswererStageWithRecovery("auditor", () =>
      invokeAuditor(args.adapter, { context: auditorContext, workspace: args.workspacePath }),
    );
  } catch (error) {
    // SCHEMA-MISS PATH: a parse miss becomes the synthetic P0 (fail-closed) so the loop's
    // triage routes a fix-in-spec task instead of dead-ending. NON-schema throws get the
    // apex v51 per-stage `task.failed` emit-on-throw treatment so the auditor task row
    // never strands `running` on a real throw — same shape as the planner gap.
    if (error instanceof AnswererSchemaValidationError) {
      return await failClosedForSchemaMiss(args, auditorTaskId, error);
    }
    const failureKind = classifyStageFailureKind(error);
    await markTaskFailed(args.pool, auditorTaskId, failureKind, args.writer);
    await args.appendEvent(
      "task.failed",
      { taskKind: "audit", failureKind, message: stageFailureMessage(error) },
      auditorTaskId,
    );
    throw error;
  }
  const runtimeSeconds = secondsSince(startedAt);
  emitStageTiming("audit", Date.now() - startedAt, { runId: args.runId });
  // SPEC-LOOP REDESIGN: the auditor emits FINDINGS as its sole currency. `findings` is
  // a REQUIRED field on the parsed `AuditAnswer` (no `.default([])`), so the verdict
  // ALWAYS carries a real, explicitly-emitted array. We persist it VERBATIM (no
  // `?? []`): a clean `[]` here can ONLY mean the auditor explicitly emitted an empty
  // list, never a missing/omitted one (that would have failed to parse upstream).
  const findings = auditorFindings(result.verdict);
  await args.appendEvent("auditor.verdict", { runId: args.runId, findings }, auditorTaskId);
  await recordAnswererCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    role: "auditor",
    taskId: auditorTaskId,
    model: "tanren-auditor",
    runtimeSeconds,
    rawUsage: args.buildUsage?.({ auditorTaskId, verdict: result.verdict }) ?? { role: "auditor" },
  });
  await markTaskDone(args.pool, auditorTaskId, "passed", args.writer);
  await args.appendEvent("task.completed", { taskKind: "audit" }, auditorTaskId);
  return { findings, auditorTaskId };
}

// The synthetic P0 a schema-parse miss yields so the loop's triage routes a fix-in-spec
// task (re-plan + re-audit) instead of dead-ending. NOT the raw parse error (it can
// embed model output); the full error is logged via console.warn for diagnosis.
const AUDITOR_SCHEMA_MISS_FINDING: Finding = {
  id: "auditor-schema-miss",
  severity: "P0",
  title: "Auditor produced no parseable verdict",
  body: "The auditor emitted output that failed the audit schema parse; re-audit (and re-plan if needed) to obtain a well-formed findings list.",
};

/**
 * Turn an auditor schema-parse miss into a fail-closed synthetic P0 FINDING (not a
 * run-`failed` dead-end). Marks the audit task failed and returns the synthetic finding
 * so the loop's triage routes a fix-in-spec task. Fail-closed is preserved: no
 * `auditor.verdict` is written, so the land gate's synthetic-P0 still blocks the merge.
 */
async function failClosedForSchemaMiss(
  args: AuditorStageInput,
  auditorTaskId: string,
  error: AnswererSchemaValidationError,
): Promise<AuditorStageResult> {
  log.warn("schema-parse miss — synthesizing a P0 finding to re-audit", { runId: args.runId }, error);
  await markTaskFailed(args.pool, auditorTaskId, "auditor_schema_invalid", args.writer);
  await args.appendEvent("task.completed", { taskKind: "audit" }, auditorTaskId);
  return { findings: [AUDITOR_SCHEMA_MISS_FINDING], auditorTaskId };
}
