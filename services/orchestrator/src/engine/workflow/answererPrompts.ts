// Single source of truth for the Checker / Auditor Answerer PROMPT TEXT.
//
// Both answerer paths route through these two builders:
//   - the production run path (`checker.ts` / `auditor.ts`, via `subtaskStages`
//     / `subtaskLoop` and the conflict re-gate), and
//   - the structured-task path (`answererTasks.ts` → phase-1 fixture + the live
//     codex-answerer test).
// Collapsing the prompt text here means prompt-tuning the checker/auditor — a key
// forward activity — is a ONE-place edit.
//
// The output SCHEMAS still differ between the two paths (the production v2
// `passed`/`reasoning`/`behaviorIds*` shape vs the structured-task v1
// `done`/`suggested_fixes` shape), so only the small CLOSING output-field
// instruction differs — it is passed in as `outputInstructions`. Everything that
// is actually tuned (the role framing, the self-inspection `git diff` block, the
// hard boundaries, and the spec/criteria rendering) is single-sourced below.
//
// VERIFIED BEHAVIOR PRESERVED: no diff is injected; the agent self-inspects via
// `git diff <baselineSha> -- . ':(exclude)node_modules'`; the read-only /
// structured-output boundaries are intact.
//
// ENTITY-RISK ORACLE (docs/roadmap/entity-analysis-layer.md §3.1): the checker
// prompt MAY carry a deterministic entity-change risk STEER (engine/oracle) — a
// native, pre-LLM signal Tanren derives from the entity-change map that tells the
// agent WHERE to concentrate scrutiny (skip cosmetic, maximal on a public-API
// signature change). It is a STEER, not injected raw context: the agent still
// inspects the diff itself. When no risk signal is supplied — or it is the
// `unknown` class (sem absent / can't-parse) — NO steer is added and the prompt
// is byte-for-byte the same as the no-oracle path (the graceful fallback).

import { renderRiskPostureLines } from "../oracle/index.js";
import type { EntityRiskSignal } from "../oracle/index.js";

export interface CheckerPromptInput {
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  baselineSha: string;
  // Production passes the subtask under judgement; the structured-task path
  // judges the whole spec and omits it.
  subtask?: {
    index: number;
    title: string;
    intent: string;
    behaviorIds: ReadonlyArray<string>;
  };
  // The schema-specific closing instruction (one element per line). Each caller
  // passes the lines that name its own output schema's fields.
  outputInstructions: ReadonlyArray<string>;
  // OPTIONAL native entity-change risk signal (engine/oracle). When present and
  // NOT the `unknown` class, its posture STEER is appended after the
  // self-inspection block. Absent / `unknown` ⇒ no steer (graceful fallback).
  riskSignal?: EntityRiskSignal;
}

export interface AuditorPromptInput {
  specTitle: string;
  specDescription?: string;
  acceptanceCriteria: ReadonlyArray<string>;
  baselineSha: string;
  // Production passes the executed subtasks; the structured-task path passes the
  // checker's answer instead. Either (or neither) may be present.
  subtasks?: ReadonlyArray<{
    index: number;
    title: string;
    intent: string;
    behaviorIds: ReadonlyArray<string>;
  }>;
  checkAnswer?: unknown;
  // The schema-specific closing instruction (one element per line).
  outputInstructions: ReadonlyArray<string>;
}

// The canonical self-inspection block: the writer's change is committed on the
// current branch of the read-only workspace; the agent diffs it itself (so a huge
// diff is never injected into the prompt, the failure that motivated this).
//
// ENTITY-LEVEL ACCELERATOR (docs/roadmap/entity-analysis-layer.md, increment 1):
// `sem` (an entity-level diff tool on PATH in the runner image) lets the agent
// reason over WHICH functions/classes/types changed (structural vs cosmetic) and a
// change's blast radius, so the audit focuses on the structurally-impactful edits
// and can cheaply skip cosmetic-only ones. It is an OPTIONAL accelerator the agent
// RUNS ITSELF in its sandbox — never Tanren injecting context — and is NOT required:
// when `sem` is absent or cannot parse the stack (it covers many but not all
// languages), the agent falls back to the raw `git diff` below, which remains the
// authoritative inspection. This keeps the lane stack-flexible (no hard sem dep).
function selfInspectionBlock(baselineSha: string): string[] {
  return [
    "The writer's change is committed on the current branch of your read-only",
    "workspace. Inspect it yourself: run",
    `  git diff ${baselineSha} -- . ':(exclude)node_modules'`,
    "to see the change, then read the changed source files. Do NOT expect the diff",
    "to be provided inline — read it from the workspace.",
    "",
    "ACCELERATOR (optional): an entity-level diff tool, `sem`, may be on PATH. When",
    "available, prefer it to focus on what STRUCTURALLY changed before reading files:",
    `  sem diff --from ${baselineSha} --to HEAD --format json`,
    "gives the entity-level change map — which functions/classes/types/methods were",
    "added/modified/deleted/renamed, and which changes are cosmetic-only (formatting/",
    "comments/whitespace). Use it to skip cosmetic-only changes cheaply and to anchor",
    "your judgement on the structurally-impactful entities. For a changed entity, run",
    "  sem impact <entity> --json",
    "to see its blast radius (dependents + affected tests). `sem` is an ACCELERATOR,",
    "NOT a replacement: if `sem` is missing, errors, or reports it cannot parse the",
    "stack (it does not cover every language), fall back to the raw `git diff` above",
    "and the source files — that raw inspection is always authoritative.",
    "Never block or change your verdict because `sem` is unavailable.",
  ];
}

// EMPTY-INCREMENTAL-DIFF (v35): judge the RESULTING STATE, not the diff's size. A
// spec can be RE-DRIVEN (the unified finalize re-drive) — or a scaffold spec whose
// whole job is an already-committed template seed — so its prior iteration's work is
// already committed in the base. Then `git diff <baselineSha> HEAD` is correctly
// EMPTY even though the criteria ARE satisfied by the committed tree. An empty diff
// is "no new regression to review", NOT an incompleteness: a checker that emitted a
// finding here ("no change delivers the intent") would loop the writer (which
// correctly adds nothing → the diff stays empty → the same finding) into a false
// `persistent_failure` escalation. So: when the diff is empty, INSPECT THE COMMITTED
// TREE (read the files the criteria name, e.g. `ls`/`cat`/read the package manifest)
// and emit findings ONLY for criteria the TREE genuinely fails to satisfy — never a
// finding whose only basis is "the incremental diff is empty".
const emptyDiffBlock: string[] = [
  "",
  "EMPTY-DIFF RULE: judge the RESULTING STATE against the criteria, not the size of",
  "the diff. If the diff is EMPTY (the work was already committed in a prior",
  "iteration, or this is a scaffold spec whose seed is already in the tree), that is",
  "NOT an incompleteness — it means there is no new regression to review. Inspect the",
  "COMMITTED TREE directly (read the files the criteria name) and emit a finding ONLY",
  "for a criterion the TREE genuinely fails to satisfy. NEVER emit a finding whose",
  "only basis is that the diff is empty / has no changes — if the criteria are met by",
  "the tree, emit an EMPTY findings list (the task is complete).",
];

// Render the optional entity-risk posture STEER as a leading-blank-line block, or
// EMPTY when no signal is supplied or the signal is the `unknown` class (sem
// absent / can't-parse). Empty ⇒ the prompt is byte-identical to the no-oracle
// path, so the graceful fallback is verifiable.
function riskSteerBlock(riskSignal: EntityRiskSignal | undefined): string[] {
  if (riskSignal === undefined) {
    return [];
  }
  const lines = renderRiskPostureLines(riskSignal);
  return lines.length === 0 ? [] : ["", ...lines];
}

export function buildCheckerPrompt(input: CheckerPromptInput): string {
  return [
    "You are the Tanren Checker Answerer. Your ONLY job is to judge COMPLETENESS for",
    "downstream tasks: does the writer's change deliver the subtask intent and each",
    "explicit acceptance criterion that LATER tasks build on? Judge by reading the",
    "change and the spec — nothing else. Emit a completeness finding per incompleteness.",
    "",
    ...selfInspectionBlock(input.baselineSha),
    ...riskSteerBlock(input.riskSignal),
    ...emptyDiffBlock,
    "",
    "Hard boundaries (a separate deterministic gate, not you, owns correctness):",
    "- Do NOT run, simulate, invoke, or shell out to tests, builds, type checks,",
    "  linters, or any command. The workspace may be unbuilt; that is expected",
    "  and is NOT your concern.",
    "- Do NOT assert, claim, predict, or report whether tests/build/lint pass or",
    "  fail. A separate in-loop deterministic gate verifies correctness; never",
    "  base your verdict on it or speculate about its result.",
    "- Do NOT edit files, run mutation commands, create commits, or write to the",
    "  workspace.",
    "- Judge intent only. 'The code looks like it might fail to compile/test' is",
    "  out of scope: if the intent and criteria are addressed by the diff, that",
    "  satisfies you.",
    "- An acceptance criterion that is INHERENTLY a test/build/lint OUTCOME (e.g.",
    "  'the test suite passes', 'the build succeeds', 'CI is green', 'lint is",
    "  clean') is owned by the deterministic gate, NOT by you. Treat such a",
    "  criterion as DEFERRED — note it in `reasoning` as gate-owned, and do NOT",
    "  emit a finding for it. You verify only that the diff implements the behavior",
    "  such a test would exercise.",
    "",
    "Return only the structured JSON required by the provided schema.",
    "",
    `Spec title: ${input.specTitle}`,
    `Spec description: ${input.specDescription}`,
    "Explicit acceptance criteria (judge each one):",
    ...input.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    ...(input.subtask === undefined
      ? []
      : [
          "",
          `Subtask [${input.subtask.index}]: ${input.subtask.title}`,
          `Subtask intent: ${input.subtask.intent}`,
          `Subtask behavior ids: ${input.subtask.behaviorIds.join(", ") || "(none)"}`,
        ]),
    "",
    ...input.outputInstructions,
  ].join("\n");
}

export function buildAuditorPrompt(input: AuditorPromptInput): string {
  return [
    "You are the Tanren Auditor Answerer. Audit whether the executed subtask plan satisfies the spec.",
    "Return only the structured JSON required by the provided schema.",
    "Do not edit files, run mutation commands, create commits, or write to the workspace.",
    "",
    ...selfInspectionBlock(input.baselineSha),
    "",
    `Spec title: ${input.specTitle}`,
    ...(input.specDescription === undefined ? [] : [`Spec description: ${input.specDescription}`]),
    "Acceptance criteria:",
    ...input.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    ...(input.subtasks === undefined
      ? []
      : [
          "",
          "Executed subtasks:",
          ...input.subtasks.map(
            (subtask) =>
              `- [${subtask.index}] ${subtask.title} (intent: ${subtask.intent}, behaviors: ${subtask.behaviorIds.join(", ") || "(none)"})`,
          ),
        ]),
    ...(input.checkAnswer === undefined ? [] : ["", "Checker answer:", JSON.stringify(input.checkAnswer, null, 2)]),
    "",
    ...input.outputInstructions,
  ].join("\n");
}
