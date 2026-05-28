import { z } from "zod";

// Semantic-rich planner/writer/checker/auditor event payloads. These fields
// are what the Forge narration substrate (P2A-0019) renders directly. The
// shapes are intentionally a superset of the legacy phase 1 emits so the
// existing fixture run replays without re-derivation.

const SubtaskSummary = z
  .object({
    title: z.string(),
    acceptanceCriteria: z.array(z.string()).optional(),
    // Phase 2 enrichments — optional during the transition so legacy phase 1
    // payloads continue to parse.
    index: z.number().int().optional(),
    intent: z.string().optional(),
    estimatedTokens: z.number().int().nullable().optional(),
    behaviorIds: z.array(z.string()).optional()
  })
  .strict();

// planner.started carries the task kind correlator; once P2A-0012 lands the
// rationale field will be required.
export const PlannerStartedPayload = z
  .object({
    taskKind: z.string(),
    intent: z.string().optional(),
    rationale: z.string().optional()
  })
  .strict();

export const PlannerCompletedPayload = z
  .object({
    subtasks: z.array(SubtaskSummary).min(1),
    // rationale is the planner's declared reason for the decomposition. It
    // is the narration field the Forge "planner reasoning" pane consumes.
    rationale: z.string().optional()
  })
  .strict();

export const PlannerFailedPayload = z
  .object({
    kind: z.string().optional(),
    message: z.string(),
    reason: z.string().optional()
  })
  .strict();

// planner.subtasks.emitted is the explicit Phase 2 event the spec describes;
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
          behaviorIds: z.array(z.string())
        })
        .strict()
    ),
    rationale: z.string()
  })
  .strict();

// Writer events carry structured intent/decisions/toolCalls so the writer
// reasoning pane renders from event fields alone — never from raw stdout.
const WriterDecision = z
  .object({
    summary: z.string(),
    code: z.string().nullable(),
    rationale: z.string().nullable()
  })
  .strict();

const WriterToolCall = z
  .object({
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
    outputSummary: z.string()
  })
  .strict();

const CommitSummary = z
  .object({
    sha: z.string(),
    message: z.string()
  })
  .strict();

const TokenUsageSummary = z
  .object({
    inputTokens: z.number().int(),
    cachedInputTokens: z.number().int(),
    cacheCreationTokens: z.number().int(),
    outputTokens: z.number().int(),
    reasoningOutputTokens: z.number().int(),
    totalTokens: z.number().int()
  })
  .strict();

export const WriterStartedPayload = z
  .object({
    taskKind: z.string(),
    intent: z.string().optional(),
    behaviorIds: z.array(z.string()).optional()
  })
  .strict();

// writer.subtask.started — Phase 2 declares-intent variant; both forms
// coexist while P2A-0012 wires the loop.
export const WriterSubtaskStartedPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    subtaskIndex: z.number().int(),
    intent: z.string(),
    behaviorIds: z.array(z.string())
  })
  .strict();

// writer.completed is the legacy phase 1 shape (WriterResult). Semantic
// fields are accepted as optional so phase 1 fixture rows still parse and
// phase 2 writers can populate them.
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
        usageLimit: z.object({ message: z.string() }).optional()
      })
      .optional(),
    // Phase 2 narration enrichments
    intent: z.string().optional(),
    decisions: z.array(WriterDecision).optional(),
    toolCalls: z.array(WriterToolCall).optional(),
    diffBytes: z.number().int().optional(),
    commitSha: z.string().nullable().optional()
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
    commitSha: z.string().nullable()
  })
  .strict();

export const WriterFailedPayload = z
  .object({
    kind: z.string(),
    message: z.string()
  })
  .strict();

export const WriterSubtaskFailedPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    subtaskIndex: z.number().int(),
    intent: z.string(),
    failureKind: z.string(),
    message: z.string()
  })
  .strict();

const CriterionStatus = z
  .object({
    criterion: z.string(),
    satisfied: z.boolean(),
    reason: z.string()
  })
  .strict();

export const CheckerStartedPayload = z
  .object({
    taskKind: z.string()
  })
  .strict();

// checker.completed wraps the legacy CheckAnswer shape and accepts the
// Phase 2 verdict fields as optional.
export const CheckerCompletedPayload = z
  .object({
    done: z.boolean(),
    reason: z.string(),
    suggested_fixes: z.array(z.string()).nullable(),
    // Phase 2 verdict enrichments
    passed: z.boolean().optional(),
    reasoning: z.string().optional(),
    behaviorIdsPassed: z.array(z.string()).optional(),
    behaviorIdsFailed: z.array(z.string()).optional()
  })
  .strict();

export const CheckerVerdictPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    subtaskIndex: z.number().int(),
    passed: z.boolean(),
    reasoning: z.string(),
    behaviorIdsPassed: z.array(z.string()),
    behaviorIdsFailed: z.array(z.string())
  })
  .strict();

export const CheckerFailedPayload = z
  .object({
    kind: z.string(),
    message: z.string()
  })
  .strict();

export const AuditorStartedPayload = z
  .object({
    taskKind: z.string()
  })
  .strict();

export const AuditorCompletedPayload = z
  .object({
    verified: z.boolean(),
    criteria_status: z
      .object({
        criteria: z.array(CriterionStatus).min(1)
      })
      .strict(),
    reason: z.string(),
    // Phase 2 verdict enrichments
    passed: z.boolean().optional(),
    reasoning: z.string().optional(),
    outstandingBehaviorIds: z.array(z.string()).optional(),
    recommendedAction: z.enum(["pass", "loop_to_planner", "halt"]).optional()
  })
  .strict();

export const AuditorVerdictPayload = z
  .object({
    runId: z.string(),
    passed: z.boolean(),
    reasoning: z.string(),
    outstandingBehaviorIds: z.array(z.string()),
    recommendedAction: z.enum(["pass", "loop_to_planner", "halt"])
  })
  .strict();

export const AuditorFailedPayload = z
  .object({
    kind: z.string(),
    message: z.string()
  })
  .strict();

// P2A-0012 rejection events. The planner-feedback-loop emits one of these on
// every rejection, carrying a structured `producer` (which Answerer rejected),
// the rejection `reason`, and the resulting `plannerRerunCount` so the run
// detail timeline can render the loop without joining tasks.
export const PlannerRerequestedPayload = z
  .object({
    runId: z.string(),
    plannerTaskId: z.string(),
    // P3-0005 adds "gate": the deterministic exit-code gate is a third
    // rejection producer alongside the checker and auditor Answerers.
    // P3-0008 adds "reviewer": a changes-requested PR review routed back through
    // the same rework path.
    producer: z.enum(["checker", "auditor", "gate", "reviewer"]),
    rejectionReason: z.string(),
    behaviorIdsFailed: z.array(z.string()),
    plannerRerunCount: z.number().int(),
    maxPlannerRerunsPerSpec: z.number().int()
  })
  .strict();

export const CheckerRejectedPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    subtaskIndex: z.number().int(),
    reason: z.string(),
    behaviorIdsFailed: z.array(z.string())
  })
  .strict();

export const AuditorRejectedPayload = z
  .object({
    runId: z.string(),
    auditTaskId: z.string(),
    reason: z.string(),
    outstandingBehaviorIds: z.array(z.string()),
    recommendedAction: z.enum(["loop_to_planner", "halt"])
  })
  .strict();
