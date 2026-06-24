import { z } from "zod";
import { oracleEventRegistry } from "./oracle.js";
import { claimEventRegistry } from "./claims.js";

// Semantic-rich planner/writer/checker/auditor event payloads. These fields are what the Forge narration substrate renders directly. The shapes are intentionally a superset of the single-pass emits so the fixture run replays without re-derivation.
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

// writer.subtask.progress — task #24 (apex v52/v53) cross-layer sign-of-life bridge. SSH ActivityWatchdog emits on every tick the WORK SIGNATURE advances; the #21B child-run breaker counts this as worker progress (allowlist `writer.%`). Composes with `MIN_NON_ADVANCING_NEIGHBOR_REPEATS=2` (substrate-internal streak floor) — fix at two layers.
export const WriterSubtaskProgressPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    subtaskIndex: z.number().int(),
    intent: z.string(),
    outputBytesAdvanced: z.number().int(),
    workspaceSignature: z.string().optional(),
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
    // EMPTY-INCREMENTAL-DIFF (v35): the entity-risk oracle deterministically classified
    // `baselineSha → HEAD` and found ZERO changed entities — the re-driven-complete /
    // scaffold-is-the-seed case. Observable so an empty-diff accept (or a non-reworkable
    // empty-diff reject routed to triage) is auditable, never a silent relabel.
    emptyIncrementalDiff: z.boolean(),
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

// AUDIT-POSTURE PREFLIGHT (Loop 3): an AUTONOMOUS run was set up with an `auditPosture`
// that would STRAND scheduled-audit findings (residual not routed/fixed, or blocking
// findings parked with no `autonomousRemediation`). The run FAILS CLOSED at setup; this
// is the loud durable record of WHY (the non-secret posture fields + a reason). The
// scheduled-audit proof (audit → finding → fix → merge) cannot silently no-op.
export const AuditPostureStrandsFindingsPayload = z
  .object({
    blockReviewAt: z.enum(["P0", "P1", "P2", "P3"]),
    p2p3Handling: z.enum(["fix-if-idle", "route-to-dag"]),
    autonomousRemediation: z.boolean(),
    reason: z.string(),
  })
  .strict();

// rejection events. The planner-feedback-loop emits one of these on
// every rejection, carrying a structured `producer` (which Answerer rejected),
// the rejection `reason`, and the running `plannerRerunCount` (a count for the
// timeline — NOT a retry cap) so the run detail timeline can render the loop
// without joining tasks. The loop is bounded by the convergence answerer's
// consecutive-stall HALT (spec-loop-redesign.md), never a per-spec rerun limit —
// so this event carries no retry-cap field.
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

export const DemoRunStartedPayload = z.object({ taskKind: z.string() }).strict();

// demoRun.verdict: the optional "does the thing actually work" gate's findings +
// the narration of what user-flow steps were exercised.
export const DemoRunVerdictPayload = z
  .object({
    runId: z.string(),
    summary: z.string(),
    findings: z.array(SeverityFindingPayload),
  })
  .strict();

// designOracle.{started,verdict}: the native design-fidelity ORACLE (WS-D4) stage —
// mirrors the demo-run gate's event shape; `verificationMode` is the domain-derived
// posture the oracle declared (web → render/inspect; novel → prose/typography; …).
export const DesignOracleStartedPayload = z.object({ taskKind: z.string() }).strict();
export const DesignOracleVerdictPayload = z
  .object({
    runId: z.string(),
    contractVersion: z.number().int(),
    verificationMode: z.string(),
    summary: z.string(),
    findings: z.array(SeverityFindingPayload),
  })
  .strict();

export const TriageStartedPayload = z.object({ taskKind: z.string() }).strict();

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

export const ConvergenceStartedPayload = z.object({ taskKind: z.string() }).strict();

// convergence.assessed: the answerer's progress/stall/velocity read + the INTELLIGENT
// escalation verdict + the loop's applied decision (continue/pass/halt). The HALT is the
// agent's `escalation` verdict ("would a human add value beyond keep going?"), NOT a count
// (apex v35 — there is no `maxConsecutiveStalls`). `consecutiveStalls` rides along as an
// OBSERVABILITY diagnostic only. The v24 cause-not-symptom fix's BLOCKING root cause signal
// (`blockingRootCauseProgress` keyed to the stable `blockingRootCauseId`) stays so a loop
// churning on a stuck blocker while peripheral findings move is visible as the stall it is.
export const ConvergenceAssessedPayload = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    assessment: z.enum(["progress", "stalled", "velocity_defer"]),
    blockingRootCauseProgress: z.enum(["retired", "reduced", "unchanged", "regressed", "none"]),
    blockingRootCauseId: z.string(),
    // The intelligent escalation verdict the halt decision keys off (replacing the count).
    escalation: z.enum(["keep_going", "escalate"]),
    decision: z.enum(["continue", "pass", "halt"]),
    // Observability diagnostic — the consecutive-stall run length, NOT a bound.
    consecutiveStalls: z.number().int(),
    reasoning: z.string(),
  })
  .strict();

// convergence.stalled: the terminal HALT when the answerer's INTELLIGENT escalation verdict
// judged a human must act (a genuine decision/blocker/dead-end) — NOT a consecutive-stall
// count. The SOLE loop halt besides budget. `reason` carries the specific human-actionable
// diagnosis the agent gave.
export const ConvergenceStalledPayload = z
  .object({
    runId: z.string(),
    consecutiveStalls: z.number().int(),
    reason: z.string(),
  })
  .strict();

// SPEC-LOOP REDESIGN stage events (demo-run/triage/convergence) — grouped so EventRegistry spreads them with ONE import (keeps registry.ts under its line + max-dependencies caps). Validation/decoding unchanged.
export const loopEventRegistry = {
  "demoRun.started": DemoRunStartedPayload,
  "demoRun.verdict": DemoRunVerdictPayload,
  "designOracle.started": DesignOracleStartedPayload,
  "designOracle.verdict": DesignOracleVerdictPayload,
  "triage.started": TriageStartedPayload,
  "triage.completed": TriageCompletedPayload,
  "convergence.started": ConvergenceStartedPayload,
  "convergence.assessed": ConvergenceAssessedPayload,
  "convergence.stalled": ConvergenceStalledPayload,
  // §3.1 entity-risk oracle (schemas/oracle.ts) + §3.3 entity-anchored Claims (schemas/claims.ts).
  ...oracleEventRegistry,
  ...claimEventRegistry,
} as const;

// Re-export the Tanren-native templating registry-lifecycle sub-registry so EventRegistry spreads it WITHOUT adding a separate import (keeps registry.ts under its max-dependencies cap). Source of truth: schemas/templates.ts.
export { templateEventRegistry } from "./templates.js";
