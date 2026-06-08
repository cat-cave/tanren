import { z } from "zod";

// Semantic-rich planner/writer/checker/auditor event payloads. These fields
// are what the Forge narration substrate renders directly. The
// shapes are intentionally a superset of the single-pass emits so the
// fixture run replays without re-derivation.

const SubtaskSummary = z
  .object({
    title: z.string(),
    acceptanceCriteria: z.array(z.string()).optional(),
    // Subtask enrichments — optional so older single-pass payloads still parse.
    index: z.number().int().optional(),
    intent: z.string().optional(),
    estimatedTokens: z.number().int().nullable().optional(),
    behaviorIds: z.array(z.string()).optional(),
  })
  .strict();

// planner.started carries the task kind correlator; once lands the
// rationale field will be required.
export const PlannerStartedPayload = z
  .object({
    taskKind: z.string(),
    intent: z.string().optional(),
    rationale: z.string().optional(),
  })
  .strict();

export const PlannerCompletedPayload = z
  .object({
    subtasks: z.array(SubtaskSummary).min(1),
    // rationale is the planner's declared reason for the decomposition. It
    // is the narration field the Forge "planner reasoning" pane consumes.
    rationale: z.string().optional(),
  })
  .strict();

export const PlannerFailedPayload = z
  .object({
    kind: z.string().optional(),
    message: z.string(),
    reason: z.string().optional(),
  })
  .strict();

// planner.subtasks.emitted is the explicit subtask-emission event;
// keeping it distinct from planner.completed so future consumers can subscribe
// to the subtask emission without coupling to planner lifecycle.
export const PlannerSubtasksEmittedPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    subtasks: z.array(
      z
        .object({
          index: z.number().int(),
          title: z.string(),
          intent: z.string(),
          estimatedTokens: z.number().int().nullable(),
          behaviorIds: z.array(z.string()),
        })
        .strict(),
    ),
    rationale: z.string(),
  })
  .strict();

// Writer events carry structured intent/decisions/toolCalls so the writer
// reasoning pane renders from event fields alone — never from raw stdout.
const WriterDecision = z
  .object({
    summary: z.string(),
    code: z.string().nullable(),
    rationale: z.string().nullable(),
  })
  .strict();

const WriterToolCall = z
  .object({
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
    outputSummary: z.string(),
  })
  .strict();

const CommitSummary = z
  .object({
    sha: z.string(),
    message: z.string(),
  })
  .strict();

const TokenUsageSummary = z
  .object({
    inputTokens: z.number().int(),
    cachedInputTokens: z.number().int(),
    cacheCreationTokens: z.number().int(),
    outputTokens: z.number().int(),
    reasoningOutputTokens: z.number().int(),
    totalTokens: z.number().int(),
  })
  .strict();

export const WriterStartedPayload = z
  .object({
    taskKind: z.string(),
    intent: z.string().optional(),
    behaviorIds: z.array(z.string()).optional(),
  })
  .strict();

// writer.subtask.started — the declares-intent variant; both forms
// coexist while wires the loop.
export const WriterSubtaskStartedPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    subtaskIndex: z.number().int(),
    intent: z.string(),
    behaviorIds: z.array(z.string()),
  })
  .strict();

// writer.completed is the single-pass shape (WriterResult). Semantic
// fields are accepted as optional so fixture rows still parse and
// subtask writers can populate them.
export const WriterCompletedPayload = z
  .object({
    diff: z.string(),
    commits: z.array(CommitSummary),
    exitReason: z.enum(["completed", "timeout", "crashed", "token_limit", "window_exhausted"]),
    tokenUsage: TokenUsageSummary.optional(),
    telemetry: z
      .object({
        rawEventCount: z.number().int(),
        tokenUsage: TokenUsageSummary.optional(),
        usageLimit: z.object({ message: z.string() }).optional(),
      })
      .optional(),
    // narration enrichments
    intent: z.string().optional(),
    decisions: z.array(WriterDecision).optional(),
    toolCalls: z.array(WriterToolCall).optional(),
    diffBytes: z.number().int().optional(),
    commitSha: z.string().nullable().optional(),
  })
  .strict();

export const WriterSubtaskCompletedPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    subtaskIndex: z.number().int(),
    intent: z.string(),
    decisions: z.array(WriterDecision),
    toolCalls: z.array(WriterToolCall),
    diffBytes: z.number().int(),
    commitSha: z.string().nullable(),
  })
  .strict();

export const WriterFailedPayload = z
  .object({
    kind: z.string(),
    message: z.string(),
  })
  .strict();

export const WriterSubtaskFailedPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    subtaskIndex: z.number().int(),
    intent: z.string(),
    failureKind: z.string(),
    message: z.string(),
  })
  .strict();

const CriterionStatus = z
  .object({
    criterion: z.string(),
    satisfied: z.boolean(),
    reason: z.string(),
  })
  .strict();

export const CheckerStartedPayload = z
  .object({
    taskKind: z.string(),
  })
  .strict();

// checker.completed wraps the CheckAnswer shape and accepts the
// verdict fields as optional.
export const CheckerCompletedPayload = z
  .object({
    done: z.boolean(),
    reason: z.string(),
    suggested_fixes: z.array(z.string()).nullable(),
    // verdict enrichments
    passed: z.boolean().optional(),
    reasoning: z.string().optional(),
    behaviorIdsPassed: z.array(z.string()).optional(),
    behaviorIdsFailed: z.array(z.string()).optional(),
  })
  .strict();

// SPEC-LOOP REDESIGN: the checker is COMPLETENESS-FINDINGS-ONLY (no binary
// `passed`). `complete` is the deterministic loop's read (findings.length === 0);
// `findings` is the emitted completeness list (all treated as P0). `reasoning` is the
// narration; `behaviorIdsFailed` collects the downstream-blocked behaviors.
const CheckerFindingPayload = z
  .object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    behaviorId: z.string().nullable(),
  })
  .strict();

export const CheckerVerdictPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    subtaskIndex: z.number().int(),
    complete: z.boolean(),
    reasoning: z.string(),
    behaviorIdsFailed: z.array(z.string()),
    findings: z.array(CheckerFindingPayload),
  })
  .strict();

export const CheckerFailedPayload = z
  .object({
    kind: z.string(),
    message: z.string(),
  })
  .strict();

export const AuditorStartedPayload = z
  .object({
    taskKind: z.string(),
  })
  .strict();

export const AuditorCompletedPayload = z
  .object({
    verified: z.boolean(),
    criteria_status: z
      .object({
        criteria: z.array(CriterionStatus).min(1),
      })
      .strict(),
    reason: z.string(),
    // verdict enrichments
    passed: z.boolean().optional(),
    reasoning: z.string().optional(),
    outstandingBehaviorIds: z.array(z.string()).optional(),
    recommendedAction: z.enum(["pass", "loop_to_planner", "halt"]).optional(),
  })
  .strict();

// SPEC-LOOP REDESIGN: the auditor is FINDINGS-ONLY (no `passed`/`recommendedAction`).
// The explicit P0–P3 findings list IS the verdict; the loop's triage + the project
// posture decide what each severity means for the merge.
const AuditorFindingPayload = z
  .object({
    id: z.string(),
    severity: z.enum(["P0", "P1", "P2", "P3"]),
    title: z.string(),
    body: z.string(),
    fixHint: z.string().optional(),
  })
  .strict();

export const AuditorVerdictPayload = z
  .object({
    runId: z.string(),
    // The explicit P0–P3 findings list — the SOLE audit currency. REQUIRED.
    findings: z.array(AuditorFindingPayload),
  })
  .strict();

export const AuditorFailedPayload = z
  .object({
    kind: z.string(),
    message: z.string(),
  })
  .strict();

// S3 (tanren-owns-the-engine.md §4): the durable record of how the project `auditPosture`
// HANDLED the residual (below-`blockReviewAt`) P2/P3 findings at merge time. Under
// `route-to-dag` the residuals become new DAG specs (`routed` carries each title + id);
// under `fix-if-idle` they are fixed in place when the spec idles, else carried forward
// (`fixedInPlace`/`carriedForward`). This is the live posture-gate path's audit trail —
// the merge was NOT blocked by these findings; they were handled per the DORA knob.
const RoutedFindingRef = z.object({ id: z.string(), severity: z.enum(["P2", "P3"]), title: z.string() }).strict();

export const AuditorFindingsRoutedPayload = z
  .object({
    runId: z.string(),
    p2p3Handling: z.enum(["fix-if-idle", "route-to-dag"]),
    routed: z.array(RoutedFindingRef),
    fixedInPlace: z.array(RoutedFindingRef),
    carriedForward: z.array(RoutedFindingRef),
  })
  .strict();

// rejection events. The planner-feedback-loop emits one of these on
// every rejection, carrying a structured `producer` (which Answerer rejected),
// the rejection `reason`, and the resulting `plannerRerunCount` so the run
// detail timeline can render the loop without joining tasks.
export const PlannerRerequestedPayload = z
  .object({
    runId: z.string(),
    plannerTaskId: z.string(),
    // adds "gate": the deterministic exit-code gate is a third
    // rejection producer alongside the checker and auditor Answerers.
    // adds "reviewer": a changes-requested PR review routed back through
    // the same rework path. "writer" is a hard writer failure (crashed / timed
    // out mid-subtask) routed through the same rework path.
    producer: z.enum(["checker", "auditor", "gate", "reviewer", "writer"]),
    rejectionReason: z.string(),
    behaviorIdsFailed: z.array(z.string()),
    plannerRerunCount: z.number().int(),
    maxPlannerRerunsPerSpec: z.number().int(),
  })
  .strict();

export const CheckerRejectedPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    subtaskIndex: z.number().int(),
    reason: z.string(),
    behaviorIdsFailed: z.array(z.string()),
  })
  .strict();

export const AuditorRejectedPayload = z
  .object({
    runId: z.string(),
    auditTaskId: z.string(),
    reason: z.string(),
    outstandingBehaviorIds: z.array(z.string()),
    recommendedAction: z.enum(["loop_to_planner", "halt"]),
  })
  .strict();

// ---- SPEC-LOOP REDESIGN stages: demo-run, triage, convergence -------------

const SeverityFindingPayload = z
  .object({
    id: z.string(),
    severity: z.enum(["P0", "P1", "P2", "P3"]),
    title: z.string(),
    body: z.string(),
    fixHint: z.string().optional(),
  })
  .strict();

export const DemoRunStartedPayload = z
  .object({
    taskKind: z.string(),
  })
  .strict();

// demoRun.verdict: the optional "does the thing actually work" gate's findings +
// the narration of what user-flow steps were exercised.
export const DemoRunVerdictPayload = z
  .object({
    runId: z.string(),
    summary: z.string(),
    findings: z.array(SeverityFindingPayload),
  })
  .strict();

export const TriageStartedPayload = z
  .object({
    taskKind: z.string(),
  })
  .strict();

const TriageItemPayload = z
  .object({
    id: z.string(),
    kind: z.enum(["task", "spec"]),
    route: z.enum(["task", "spec"]),
    severity: z.enum(["P0", "P1", "P2", "P3"]),
    title: z.string(),
    findingIds: z.array(z.string()),
  })
  .strict();

// triage.completed: the deduped work items + their RESOLVED routes (task-here vs new
// DAG spec) + the terminal outcome (`passed` when ALL items became specs, `kept` when
// at least one routed to a task in this spec).
export const TriageCompletedPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    outcome: z.enum(["passed", "kept"]),
    items: z.array(TriageItemPayload),
  })
  .strict();

export const ConvergenceStartedPayload = z
  .object({
    taskKind: z.string(),
  })
  .strict();

// convergence.assessed: the answerer's progress/stall/velocity read + the loop's
// applied decision (continue/pass/halt) + the consecutive-stall counter (the SOLE
// loop bound; NOT a retry counter).
export const ConvergenceAssessedPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    assessment: z.enum(["progress", "stalled", "velocity_defer"]),
    decision: z.enum(["continue", "pass", "halt"]),
    consecutiveStalls: z.number().int(),
    maxConsecutiveStalls: z.number().int(),
    reasoning: z.string(),
  })
  .strict();

// convergence.stalled: the terminal HALT after `maxConsecutiveStalls` consecutive
// stalls — the SOLE loop halt besides budget. A human action (rework the spec /
// stronger model / fix the env) is the genuine next step.
export const ConvergenceStalledPayload = z
  .object({
    runId: z.string(),
    consecutiveStalls: z.number().int(),
    maxConsecutiveStalls: z.number().int(),
    reason: z.string(),
  })
  .strict();
