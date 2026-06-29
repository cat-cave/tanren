// checker module for the spec-implementation loop. Builds the
// per-subtask check prompt against the typed CheckAnswer schema
// and exposes a `decideCheckerOutcome` helper the subtask loop uses to
// branch into the rework path.
//
// SPEC-LOOP REDESIGN (docs/roadmap/spec-loop-redesign.md): the checker is
// COMPLETENESS-FINDINGS-ONLY. There is NO binary `passed`. `decideCheckerOutcome`
// reads the emitted `findings` (all P0): NO findings ⇒ the task is complete; ANY
// finding ⇒ the task is incomplete and routes straight back to the writer. The
// checker answers strictly "is THIS task complete for what downstream tasks need".
import { answererOutputSchemaFor, CheckAnswer } from "../../answerers/schemas/index.js";
import type { CheckFinding, PlanSubtask } from "../../answerers/schemas/index.js";
import type { EntityRiskSignal } from "../../oracle/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import type { SpecMode } from "../../state/spec.js";
import { buildCheckerPrompt as buildCheckerPromptText } from "../answererPrompts.js";

// The v3 CheckAnswer (completeness findings + reasoning) closing instruction. The
// shared body lives in answererPrompts.ts; only this schema-specific tail names the
// production checker's output fields.
const CHECKER_V3_OUTPUT_INSTRUCTIONS = [
  "Emit your answer as a `findings` list — one entry per concrete way THIS task is",
  "not yet complete for what DOWNSTREAM tasks build on. Every such finding is",
  "blocking (treated as P0): nothing about delivering a task another task depends on",
  "is deferrable. Give each a stable slug `id`, a short `title`, a `body` with enough",
  "context to act on, and the `behaviorId` it blocks (or null). Emit an EMPTY",
  "`findings` list when the task is complete for downstream needs — never invent a",
  "finding. In `reasoning`, cite each acceptance criterion / behavior the downstream",
  "depends on and state whether the change delivers it (mark any test/build/lint-",
  "outcome criterion as gate-owned, NOT a finding). Do NOT render a pass/fail",
  "judgment — the loop decides complete-vs-incomplete from your findings.",
];

export interface CheckerSubtaskContext {
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  subtask: PlanSubtask;
  // The run base the writer's change is diffed against. The checker runs INSIDE
  // the writer's read-only workspace and inspects the change itself (rather than
  // having a potentially huge diff injected into the prompt).
  baselineSha: string;
  // OPTIONAL native entity-change risk signal (engine/oracle, §3.1). When present
  // and not the `unknown` class, its posture steers where the checker concentrates
  // scrutiny. Absent / `unknown` ⇒ the checker proceeds on the raw diff as today.
  riskSignal?: EntityRiskSignal;
  // OPTIONAL spec writer-prompt MODE (task #86 — v64 root-cause class one rung
  // downstream from PR #704's writer-prompt fix). When `specialize_seed`, the prompt
  // appends a seeded-mode tail block telling the checker the composed seed is pre-
  // existing + proven green, so pre-existing seed surfaces (manifest, lockfile,
  // tsconfig, lint/test/build configs, contract files, source skeleton, demo) are
  // NOT completeness findings — only gaps in the product-specific surfaces this
  // spec was supposed to deliver. Absent / `from_scratch` ⇒ byte-identical to the
  // legacy checker prompt (the brownfield/legacy default).
  specMode?: SpecMode;
}

export interface CheckerInvokeInput {
  context: CheckerSubtaskContext;
  workspace?: string;
}

export interface CheckerInvocationResult {
  verdict: CheckAnswer;
  schemaId: string;
}

export async function invokeChecker(
  checker: AnswererAdapter<CheckAnswer>,
  input: CheckerInvokeInput,
): Promise<CheckerInvocationResult> {
  const outputSchema = answererOutputSchemaFor("check", CheckAnswer);
  const prompt = buildCheckerPrompt(input.context);
  const verdict = await checker.runAnswerer({
    prompt,
    workspace: input.workspace,
    outputSchema,
  });
  return { verdict, schemaId: outputSchema.name };
}

// Production checker prompt: the canonical shared body (answererPrompts.ts) with
// the per-subtask context mapped down to the common input and the v3-schema
// closing instruction supplied.
export function buildCheckerPrompt(context: CheckerSubtaskContext): string {
  return buildCheckerPromptText({
    specTitle: context.specTitle,
    specDescription: context.specDescription,
    acceptanceCriteria: context.acceptanceCriteria,
    baselineSha: context.baselineSha,
    subtask: {
      index: context.subtask.index,
      title: context.subtask.title,
      intent: context.subtask.intent,
      behaviorIds: context.subtask.behaviorIds,
    },
    outputInstructions: CHECKER_V3_OUTPUT_INSTRUCTIONS,
    riskSignal: context.riskSignal,
    // Task #86: thread the spec mode through so the seeded-mode tail block is appended
    // when the spec runs in `specialize_seed` mode. Absent ⇒ no block (byte-identical
    // to the legacy prompt for brownfield/legacy specs).
    ...(context.specMode !== undefined && { specMode: context.specMode }),
  });
}

// CheckerDecision encodes the post-check branch the subtask loop should
// take. The decision is "pure" — it does not append events or persist rows —
// so the loop can replay it deterministically in tests. `reject` carries the
// completeness findings so the writer rework feedback names the concrete gaps.
//
// `reworkable` (on a reject) is the EMPTY-INCREMENTAL-DIFF guard (v35): re-driving
// the writer only helps when there is a diff to grow. When the incremental diff
// (`baselineSha → HEAD`) is deterministically EMPTY — a re-driven, already-complete
// spec whose work was committed in a prior iteration, or a scaffold spec whose whole
// job is the already-committed template seed — re-driving the writer is FUTILE (it
// correctly adds nothing → the diff stays empty → the same finding → an infinite
// `rework` loop that false-escalates `persistent_failure`). On an empty diff a reject
// is therefore `reworkable: false`: it surfaces the residual finding straight to
// triage/convergence INSTEAD of looping the writer. A non-empty diff is reworkable as
// before. NOTE: a `pass` (zero findings) on an empty diff is the COMMON case and is
// the accept the bug demanded — the criteria are met by the committed tree, the empty
// diff is "no regression to review", not an incompleteness.
export type CheckerDecision =
  | { kind: "pass" }
  | {
      kind: "reject";
      reason: string;
      behaviorIdsFailed: ReadonlyArray<string>;
      findings: ReadonlyArray<CheckFinding>;
      // false ⇒ the incremental diff is empty; re-driving the writer cannot help, so
      // the loop must NOT re-enter the writer — the finding goes to triage directly.
      reworkable: boolean;
    };

/**
 * Decide complete-vs-incomplete from the checker's EMITTED completeness findings.
 * NO findings ⇒ the task is complete (`pass`). ANY finding ⇒ incomplete (`reject`):
 * the task routes back to the writer (when the diff is non-empty) OR straight to triage
 * (when the diff is empty — re-driving is futile; see `CheckerDecision`). The reject
 * `reason` is built from the finding titles; `behaviorIdsFailed` collects each finding's
 * `behaviorId` (the downstream-blocked behaviors). `findings` is a REQUIRED field — a
 * parsed verdict ALWAYS carries a real, explicitly-emitted array (an omitted one fails
 * to parse).
 *
 * `emptyIncrementalDiff` is the DETERMINISTIC host-side fact (the entity-risk oracle
 * classified the `baselineSha → HEAD` diff and found ZERO changed entities). It NEVER
 * forces a reject and NEVER fabricates an accept — `findings: []` already passes; it
 * only marks an empty-diff reject as non-reworkable so the loop stops futile re-drives.
 */
export function decideCheckerOutcome(verdict: CheckAnswer, emptyIncrementalDiff = false): CheckerDecision {
  if (verdict.findings.length === 0) {
    return { kind: "pass" };
  }
  const reason = verdict.reasoning === "" ? verdict.findings.map((f) => f.title).join("; ") : verdict.reasoning;
  const behaviorIdsFailed = verdict.findings
    .map((f) => f.behaviorId)
    .filter((id): id is string => id !== null && id !== undefined);
  return {
    kind: "reject",
    reason,
    behaviorIdsFailed,
    findings: verdict.findings,
    reworkable: !emptyIncrementalDiff,
  };
}
