// Prompt builders for the spec-loop redesign's NEW answerer stages (TRIAGE,
// CONVERGENCE, DEMO-RUN). Single-sourced here so prompt-tuning these stages — a key
// forward activity — is a one-place edit, mirroring answererPrompts.ts for the
// checker/auditor. All three answerers are READ-ONLY + strict-JSON-schema.
//
// SPEC-LOOP REDESIGN (docs/roadmap/spec-loop-redesign.md).

import { SPEC_QUALITY_CONTRACT_PROMPT } from "../forge/specQuality/index.js";
import { type Finding, maxSeverity } from "../contracts/findings.js";
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
    "",
    // apex v79 FIX: on v79, triage kept CROSS-SCOPE findings in-spec (e.g. an
    // "entrypoint-not-deployed" finding on a `scaffold` spec — a deploy concern),
    // so each iteration surfaced a NEW out-of-scope finding, the auditor findings
    // ROTATED across 5 iterations (leftover-rails-cta → entrypoint-not-deployed →
    // linkly-env-not-consumed → identity-linkly-instead-of-scaffold → pnpm-workspace-
    // toolchain-edited), findings.length never reached 0, and the subtask loop never
    // returned "passed" — zero github.pr.created events after 5h runtime. The fix is
    // to ROUTE OUT-OF-SCOPE work OUT as `kind: spec`, so this spec's findings can
    // converge to 0 and the loop can publish. This routing rule is the primary
    // convergence lever — a `kind: task` on an out-of-scope finding will never close.
    "SCOPE ROUTING RULE (critical):",
    "- The spec you are triaging for has a specific TITLE and DESCRIPTION (below).",
    "- If a finding's SCOPE is CLEARLY out-of-band for this spec's title/description",
    '  — e.g. a "deploy is missing" finding on a "scaffold identity" spec, or an',
    '  "analytics view not implemented" finding on a "redirect route" spec — emit',
    "  it as `kind: spec`. It becomes a NEW DAG spec so THIS spec can converge.",
    "- Only findings that are IN-SCOPE for THIS spec's stated purpose should be",
    "  `kind: task`.",
    "- The rotating-findings anti-pattern: if each iteration surfaces a NEW",
    "  out-of-scope finding, this spec will NEVER converge. Route the cross-scope",
    "  work OUT as `kind: spec` — that lets this spec's findings.length reach 0 and",
    '  lets the loop return "passed" to publish.',
    "",
    "Render NO pass/fail verdict: the loop routes each item by severity + project posture.",
    "",
    // WORKSTREAM 1 — a `kind: spec` item becomes a NEW DAG spec, so it must meet the
    // SAME spec-quality bar every spec-emitter is held to (and is gated against it
    // before it materializes). Author each `spec` item's title/body to satisfy this:
    "A `kind: spec` item is emitted as a NEW DAG spec and is GATED against the",
    "spec-quality contract below — author its `title` + `body` to MEET this bar (a",
    "spec that fails is looped back to you):",
    SPEC_QUALITY_CONTRACT_PROMPT,
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
  // The stable blocking-root-cause ids the answerer assigned on EARLIER loops, oldest→newest
  // (excluding this loop). The answerer reuses the SAME id when the same underlying blocker
  // recurs (even reworded) so a return to a previously-seen root cause reads as an
  // OSCILLATION, not progress. Empty on the first convergence check.
  priorBlockingRootCauseIds: ReadonlyArray<string>;
}

// The CONVERGENCE prompt: decide progress vs stall vs velocity-defer from the
// finding-DELTA across loops + the diff. The agent renders the assessment; the loop
// applies the configurable policy + the consecutive-stall halt.
//
// v24 CAUSE-NOT-SYMPTOM FIX: the prompt now MANDATES the agent track the BLOCKING root
// cause — the worst-severity / merge-gating finding — across loops by a STABLE id, not
// surface text. On v24 the loop churned 4+ times on the identical blocking `pnpm test
// fails` P1 while it kept reporting `progress` because a peripheral, non-blocking
// finding (an unrelated lockfile fix) changed each round. The blocking-progress signal
// (keyed to a stable root-cause id) is the deterministic stall driver — peripheral
// churn must NOT count as progress on the blocker.
export function buildConvergencePrompt(input: ConvergencePromptInput): string {
  const worstThis = maxSeverity(input.currentFindings);
  return [
    "You are the Tanren Convergence Answerer. Decide whether this spec's rework loop is",
    "making FORWARD PROGRESS or has STALLED. You see the findings kept in-spec this loop",
    "and the prior loop's findings; reason over the DELTA.",
    "",
    "FIRST identify the BLOCKING ROOT CAUSE: the worst-severity / merge-gating finding",
    "that prevents this spec from passing (the highest-severity finding kept in-spec).",
    "Give it a STABLE identity in `blockingRootCauseId` — the finding id or a durable",
    "root-cause label (e.g. `pnpm-test-fails`), NOT its surface text — so the SAME",
    "blocker is recognized as recurring across loops. If the prior loop's worst finding",
    "shares this root cause, it IS the same blocker even if the wording/line changed.",
    'If there is NO blocking finding this loop, set `blockingRootCauseId` to "".',
    "",
    // OSCILLATION (v40 scaffold finding): a loop that retires blocker A, then a NEW",
    // blocker B appears, then A RETURNS is NOT making progress — it is OSCILLATING
    // between the same unresolved root causes (A↔B), even if each individual loop
    // 'retired the old one'. The answerer must recognize a RETURN to a previously-seen
    // root cause as a STALL, not progress. Two levers, BOTH mandatory:
    //   (1) STABLE ids: reuse the SAME id for the same underlying blocker even when it is
    //       reworded (`justfile-redefined` ≈ `justfile-contract-mismatch` ⇒ one id).
    //   (2) RETURN-detection: if THIS loop's blocking root cause id appears among the
    //       earlier-loop ids below, the loop has RETURNED to a blocker it was already
    //       blocked on with no net resolution — treat `blockingRootCauseProgress` as
    //       `regressed` (a stall), NOT `retired`/`reduced`, even if a different blocker
    //       moved this round.
    "OSCILLATION CHECK — assign STABLE root-cause ids (reuse the SAME id for the same",
    "underlying blocker even when reworded: `justfile-redefined` and",
    "`justfile-contract-mismatch` are ONE id). If your `blockingRootCauseId` this loop",
    "matches a root cause this loop's history was ALREADY blocked on before (see the",
    "prior blocking root-cause ids below), the loop has RETURNED to an unresolved blocker",
    "(an A→B→A oscillation) — that is a STALL: set `blockingRootCauseProgress` to",
    "`regressed` and assess `stalled`, NOT progress, even if a DIFFERENT finding moved.",
    "",
    "Then emit `blockingRootCauseProgress` — progress on THAT blocker ONLY (this is the",
    "primary stall signal; peripheral non-blocking findings changing does NOT count):",
    "- `retired`   — the blocking root cause is GONE this loop.",
    "- `reduced`   — materially smaller / lower-severity than the prior loop.",
    "- `unchanged` — the SAME blocking root cause recurs materially unchanged (a STALL,",
    "                even if unrelated findings moved this round).",
    "- `regressed` — the blocking root cause is worse, or a new equal-or-worse blocker",
    "                replaced it (a STALL).",
    "- `none`      — there is NO blocking (merge-gating) finding kept this loop.",
    "",
    "Also emit your overall `assessment`:",
    "- `progress`       — the finding-delta is shrinking / root causes are being retired",
    "                     (INCLUDING magnitude/trajectory: 1000 → 500 → 100 errors is",
    "                     progress at EVERY step even though it still fails — keep going).",
    "- `stalled`        — the same root causes recur with no forward progress.",
    "- `velocity_defer` — only MILD leftovers remain (e.g. P3-only after several rounds);",
    "                     defer them as specs and allow the spec to pass.",
    "",
    "Then emit the INTELLIGENT ESCALATION verdict `escalation` — the gate that decides whether",
    "to STOP the loop and ask a human. The bar is: 'would a human do anything OTHER than say",
    "\"keep going, you're almost there\"?'",
    "- `keep_going` — a human would just say keep going. Use this whenever the loop is merely",
    "                 slow / hard / many-attempts, OR is making ANY progress (different or",
    "                 smaller failure), OR is stuck but a DIFFERENT approach is still worth",
    "                 trying. This is the DEFAULT — escalation must be RARE.",
    "- `escalate`   — ONLY when human input would genuinely CHANGE the outcome: an ambiguous",
    "                 requirement, a missing resource/credential the agent cannot obtain, a",
    "                 genuine product/architecture decision, or a demonstrably-exhausted",
    "                 dead-end (the SAME failure with IDENTICAL work and NO new approach left).",
    "                 'Slow' / 'hard' / 'tried many times' are NEVER reasons to escalate.",
    "When `escalation=escalate`, put the SPECIFIC human-actionable reason in `escalationReason`",
    "(what decision/blocker/dead-end the human must resolve) — never a bare 'stuck'. Otherwise",
    "leave `escalationReason` empty.",
    "In `reasoning`, name the blocking root cause and its progress, then cite which other",
    "root causes were retired, which recurred, and whether the total P-score is",
    "decreasing. Do NOT edit files or write to the workspace.",
    "",
    `The change is committed on the current branch; inspect it via git diff ${input.baselineSha}.`,
    "Return only the structured JSON.",
    "",
    `Spec: ${input.specTitle}`,
    `Loop index: ${input.loopIndex}`,
    // The total P-score (P0=4 … P3=1) this loop vs the prior — a decreasing score is the
    // clearest progress signal the policy weighs.
    `Total P-score this loop: ${totalPScore(input.currentFindings)} (prior loop: ${totalPScore(input.priorFindings)})`,
    `Worst (merge-gating) severity this loop: ${worstThis ?? "(none)"}`,
    "",
    // The earlier-loop blocking root-cause ids (oldest→newest): the answerer cross-checks
    // THIS loop's id against them to detect a RETURN to a prior unresolved blocker (the v40
    // oscillation). Empty on the first convergence check.
    input.priorBlockingRootCauseIds.length === 0
      ? "Prior blocking root-cause ids (earlier loops): (none — first convergence check)"
      : `Prior blocking root-cause ids (earlier loops, oldest→newest): ${input.priorBlockingRootCauseIds.join(", ")}`,
    "",
    "Findings kept in-spec THIS loop (worst severity = the blocking root cause):",
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

// The DEMO-RUN prompt: probe the user-flow the spec promised and emit findings
// (explicit P0–P3) for whatever genuinely did not work. Distinct from the checker
// (per-task completeness) and the auditor (quality). Findings-only, no verdict.
//
// HONESTY: the demo answerer runs in a READ-ONLY sandbox — it
// CANNOT start a server, run the app, or perform live I/O. So the prompt no longer
// mandates the impossible "exercise the app". It asks for STATIC read-only probing
// (read the diff + sources + tests + entrypoints and reason about whether the flow
// would work) and, when the promise CANNOT be verified by static probing alone,
// the honest-skip: emit a single `demo-not-exercisable` info finding rather than
// fabricate a failure for something it could not actually run.
export function buildDemoRunPrompt(input: DemoRunPromptInput): string {
  return [
    "You are the Tanren Demo-Run Answerer. Your job: verify the user-flow / end-to-end",
    "behavior the spec promised actually works, and report what did NOT as `findings`",
    "(each with an explicit severity P0–P3). This is distinct from the checker (per-task",
    "completeness) and the auditor (quality) — you verify the thing a human wanted works.",
    "",
    "IMPORTANT — you run in a READ-ONLY sandbox: you CANNOT start a server, run the app,",
    "or perform live network/process I/O. Probe STATICALLY: read the change, the source,",
    "the tests, and the entrypoints, and reason about whether the promised flow holds.",
    "",
    "Emit findings ONLY for failures you can SUBSTANTIATE from the code you read (e.g. a",
    "missing route, an unhandled case, a contradicted acceptance criterion). NEVER",
    "fabricate a failure for behavior you could not actually exercise.",
    "- If static probing confirms the promised behavior holds end-to-end: emit an EMPTY",
    "  `findings` list and describe what you inspected in `summary`.",
    "- If the promise genuinely CANNOT be judged by static read-only probing (it needs a",
    "  live run you cannot perform): emit a SINGLE info-severity finding with id",
    "  `demo-not-exercisable` saying so — do NOT invent failures.",
    "",
    "Render NO pass/fail verdict — the loop routes your findings through triage. Do NOT",
    "edit source files. Return only the structured JSON.",
    "",
    `The change is committed on the current branch; inspect it via git diff ${input.baselineSha}.`,
    "",
    `Spec title: ${input.specTitle}`,
    `Spec description: ${input.specDescription}`,
    "Acceptance criteria (the promise to demonstrate):",
    ...input.acceptanceCriteria.map((criterion) => `- ${criterion}`),
  ].join("\n");
}
