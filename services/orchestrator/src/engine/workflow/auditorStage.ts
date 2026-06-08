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
    result = await invokeAuditor(args.adapter, {
      context: auditorContext,
      timeoutMs: args.timeoutMs,
      workspace: args.workspacePath,
    });
  } catch (error) {
    // RECOVERABLE prompt-repair: the auditor's model emitted output that failed the
    // AuditAnswer schema parse. No `auditor.verdict` is written, so the durable record
    // stays UN-AUDITED — the land gate's fail-closed synthetic-P0 still BLOCKS a merge.
    // Here, rather than dead-ending the run on a single model schema miss, we surface a
    // synthetic P0 FINDING so the loop's triage routes a fix-in-spec task (a re-plan +
    // re-audit can recover). A non-schema error (timeout / usage-limit / infra) still
    // propagates to its own handling.
    if (!(error instanceof AnswererSchemaValidationError)) throw error;
    return await failClosedForSchemaMiss(args, auditorTaskId, error);
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
  console.warn(`[auditor] schema-parse miss for run ${args.runId} — synthesizing a P0 finding to re-audit:`, error);
  await markTaskFailed(args.pool, auditorTaskId, "auditor_schema_invalid", args.writer);
  await args.appendEvent("task.completed", { taskKind: "audit" }, auditorTaskId);
  return { findings: [AUDITOR_SCHEMA_MISS_FINDING], auditorTaskId };
}
