// Prompt builders for the spec-loop redesign's NEW answerer stages (TRIAGE,
// CONVERGENCE, DEMO-RUN). Single-sourced here so prompt-tuning these stages — a key
// forward activity — is a one-place edit, mirroring answererPrompts.ts for the
// checker/auditor. All three answerers are READ-ONLY + strict-JSON-schema.
//
// SPEC-LOOP REDESIGN (docs/roadmap/spec-loop-redesign.md).

import type { Finding } from "../contracts/findings.js";
import { totalPScore } from "./loopPolicy.js";

// Render the combined findings (spec-gate CI-as-P0 + auditor + demo) as a stable,
// legible list the triage/convergence answerers reason over. The findings are passed
// in the prompt (not self-inspected) because they are the run's accumulated state,
// not a diff in the workspace.
function renderFindings(findings: ReadonlyArray<Finding>): string[] {
  if (findings.length === 0) {
    return ["(no findings)"];
  }
  return findings.map((f) => `- [${f.severity}] ${f.id}: ${f.title} — ${f.body}`);
}

export interface TriagePromptInput {
  specTitle: string;
  specDescription: string;
  findings: ReadonlyArray<Finding>;
  baselineSha: string;
}

// The TRIAGE prompt: dedup N findings to M ROOT-CAUSE work items, each tagged
// task|spec + severity. The agent self-inspects the change (to judge whether a fix is
// a bounded task or a coherent new unit) and renders NO verdict.
export function buildTriagePrompt(input: TriagePromptInput): string {
  return [
    "You are the Tanren Triage Answerer. You are given ALL findings from this spec's",
    "run (deterministic gate failures as P0, plus the auditor's and demo's findings).",
    "Your job: dedup them to ROOT CAUSES and emit M work items (NOT 1:1 with findings).",
    "",
    "For each root cause, emit one `workItems` entry:",
    "- `kind: task`  — a bounded fix that belongs in THIS spec's task list.",
    "- `kind: spec`  — a coherent, demo-able unit big enough to be its own DAG spec.",
    "- `severity`    — the WORST severity among the findings this item subsumes.",
    "- `findingIds`  — the ids of the findings this item resolves (the dedup trail).",
    "Render NO pass/fail verdict: the loop routes each item by severity + project posture.",
    "",
    `The change is committed on the current branch; inspect it via git diff ${input.baselineSha}`,
    "to judge whether a fix is a bounded task or a coherent new unit. Do NOT edit files,",
    "run mutation commands, or write to the workspace. Return only the structured JSON.",
    "",
    `Spec title: ${input.specTitle}`,
    `Spec description: ${input.specDescription}`,
    "",
    "Findings to triage:",
    ...renderFindings(input.findings),
  ].join("\n");
}

export interface ConvergencePromptInput {
  specTitle: string;
  // The findings kept IN-SPEC this loop (the work the loop is iterating on).
  currentFindings: ReadonlyArray<Finding>;
  // The findings from the PRIOR loop, for the delta read.
  priorFindings: ReadonlyArray<Finding>;
  baselineSha: string;
  loopIndex: number;
}

// The CONVERGENCE prompt: decide progress vs stall vs velocity-defer from the
// finding-DELTA across loops + the diff. The agent renders the assessment; the loop
// applies the configurable policy + the consecutive-stall halt.
export function buildConvergencePrompt(input: ConvergencePromptInput): string {
  return [
    "You are the Tanren Convergence Answerer. Decide whether this spec's rework loop is",
    "making FORWARD PROGRESS or has STALLED. You see the findings kept in-spec this loop",
    "and the prior loop's findings; reason over the DELTA.",
    "",
    "Emit `assessment`:",
    "- `progress`       — the finding-delta is shrinking / root causes are being retired.",
    "- `stalled`        — the same root causes recur with no forward progress (a human",
    "                     action — rework the spec / stronger model / fix the env — is",
    "                     the genuine next step).",
    "- `velocity_defer` — only MILD leftovers remain (e.g. P3-only after several rounds);",
    "                     defer them as specs and allow the spec to pass.",
    "In `reasoning`, cite which root causes were retired, which recurred, and whether the",
    "total P-score is decreasing. Do NOT edit files or write to the workspace.",
    "",
    `The change is committed on the current branch; inspect it via git diff ${input.baselineSha}.`,
    "Return only the structured JSON.",
    "",
    `Spec: ${input.specTitle}`,
    `Loop index: ${input.loopIndex}`,
    // The total P-score (P0=4 … P3=1) this loop vs the prior — a decreasing score is the
    // clearest progress signal the policy weighs.
    `Total P-score this loop: ${totalPScore(input.currentFindings)} (prior loop: ${totalPScore(input.priorFindings)})`,
    "",
    "Findings kept in-spec THIS loop:",
    ...renderFindings(input.currentFindings),
    "",
    "Findings from the PRIOR loop:",
    ...renderFindings(input.priorFindings),
  ].join("\n");
}

export interface DemoRunPromptInput {
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  baselineSha: string;
}

// The DEMO-RUN prompt: exercise the real user-flow the spec promised and emit
// findings (explicit P0–P3) for whatever did not work. Distinct from the checker
// (per-task completeness) and the auditor (quality). Findings-only, no verdict.
export function buildDemoRunPrompt(input: DemoRunPromptInput): string {
  return [
    "You are the Tanren Demo-Run Answerer. Your job: actually EXERCISE the user-flow /",
    "end-to-end behavior the spec was written for, and report what did NOT work as",
    "`findings` (each with an explicit severity P0–P3). This is distinct from the checker",
    "(per-task completeness) and the auditor (quality) — you verify the thing a human",
    "wanted actually works.",
    "",
    "Emit an EMPTY `findings` list when the promised behavior works end-to-end. In",
    "`summary`, describe the steps you exercised. Render NO pass/fail verdict — the loop",
    "routes your findings through triage. Do NOT edit source files (you may run/observe",
    "the app read-only). Return only the structured JSON.",
    "",
    `The change is committed on the current branch; inspect it via git diff ${input.baselineSha}.`,
    "",
    `Spec title: ${input.specTitle}`,
    `Spec description: ${input.specDescription}`,
    "Acceptance criteria (the promise to demonstrate):",
    ...input.acceptanceCriteria.map((criterion) => `- ${criterion}`),
  ].join("\n");
}
