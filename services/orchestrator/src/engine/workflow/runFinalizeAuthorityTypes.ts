// The run-finalize authority's TYPE surface — the vocabulary the decision core
// (`runFinalizeAuthority.ts`) reasons over: the normalized {@link TerminalOutcome} every
// terminal site maps into, the {@link RunDisposition} bucket it maps out to, and the
// {@link ConvergenceFacts} it consults. Extracted from `runFinalizeAuthority.ts` for the
// 500-line-per-file cap when the precondition-block disposition landed, mirroring the
// sibling split `plannerRunRedriveTypes.ts` already uses for the re-drive contract.
//
// Pure type declarations plus no runtime — and no import back into the authority, so the
// split introduces no cycle. Every name here is RE-EXPORTED from `runFinalizeAuthority.ts`,
// so existing import sites are unchanged.

import type { ClassifiedRunFailure, RunPrecondition } from "../worker/runFailureClassifier.js";
import type { WanderingHaltVerdict } from "./wanderingHaltDetector.js";

/**
 * A terminal run-outcome, expressed in the vocabulary THIS authority decides over. Every
 * terminal site (the workflow error catch, the writer-non-pass exit, the merge-gate /
 * review stalls, the merge-stage outcome, the worker orphan reconciler) normalizes its
 * outcome into ONE of these before asking for a disposition — so the 3-bucket mapping
 * lives in ONE place, never re-implemented per site.
 */
export type TerminalOutcome =
  // A thrown run-error (the workflow catch). The authority classifies it through the
  // SAME closed run-failure vocabulary the public events use.
  | { kind: "error"; error: unknown }
  // An ALREADY-CLASSIFIED failure (the worker orphan path, which classified the raw throw
  // at the worker boundary and carries the result). Skips re-classification entirely.
  //
  // This replaces the old `OrphanFailureProxy` in `runFinalize.ts`, which round-tripped a
  // classification back through a synthetic error NAME (code → error-class name →
  // `classifyRunFailure` → code). That round-trip is LOSSY by construction — it can only
  // carry what the code alone determines — so it silently dropped the `cause`,
  // `attribution` and, critically, the `precondition`. An orphaned run blocked on a
  // missing credential would therefore still have parked. Handing the authority the real
  // classification removes the lossy hop instead of widening it.
  | { kind: "classified_error"; failure: ClassifiedRunFailure }
  // A non-pass planner-loop exit (the writer never converged / a window exhausted / a
  // convergence stall / a merge-gate budget spent / a review stall). ALL transient:
  // the spec re-drives (or, for a `window_exhausted` detail, the run pauses — task
  // #82). The `detail` is a public-safe sub-reason for observability. The
  // OPTIONAL `window` snapshot rides a `window_exhausted` non-pass so the
  // applier can stamp the `run.paused` event with the real provider/slot/percent
  // the subtask loop observed (the diagnostic the prober reads to schedule
  // its capacity re-probe). Absent on every other detail.
  | {
      kind: "non_pass";
      detail: NonPassDetail;
      window?: { provider: string; slot: string; usedPercent: number; resetsAt: string };
    }
  // The merge stage's terminal outcome (see `MergeOutcomeKind`). `merged` converges;
  // a genuine HITL/changes-requested human-decision (`needs_attention`) genuine-halts;
  // every other hold/conflict/handoff re-drives.
  | { kind: "merge"; mergeOutcome: MergeOutcomeForDisposition }
  // A benign ancestor-not-ready wait: the dependent ran ahead of a non-terminal ancestor
  // that has not published its head yet. NOT a fault — a clean re-drive (no failure code,
  // so it never counts toward the consecutive-same-failure cap).
  | { kind: "ancestor_wait" };

/** The public-safe sub-reason for a non-pass planner-loop exit (never the raw error string). */
export type NonPassDetail =
  | "window_exhausted"
  | "convergence_stalled"
  | "merge_gate_unsatisfied"
  | "pre_merge_behavior_unsatisfied"
  | "review_stalled"
  | "halted";

/** The subset of `MergeOutcomeKind` this authority decides over (mirrors mergeDispatchTypes). */
export type MergeOutcomeForDisposition =
  | "merged"
  | "queued"
  | "handed_off"
  | "conflict"
  | "failed"
  | "blocked"
  // A post-auto-rebase native re-gate not yet terminal (still running / infra blip) — a
  // recoverable hold the recovery surface re-drives (same bucket as `blocked`/`conflict`).
  | "re_gate_pending"
  | "needs_attention";

/**
 * The diagnostic sub-reason carried on a disposition — folded into the OBSERVABLE event
 * payload (the old per-path strand reasons live on here as a DIAGNOSTIC detail, NOT as a
 * distinct terminal behavior). For a re-drive it is the failure code that the
 * consecutive-same-failure counter keys off; for a genuine-halt it names WHY a human is
 * needed.
 */
export type GenuineHaltReason =
  // A structural misconfiguration a human must fix (credential / provider-mode).
  | "misconfiguration"
  // The SAME classified failure recurring at a FIXED POINT (identical failure + identical
  // work, no new information) — a genuinely stuck spec (bug/mis-spec), NOT a flake.
  | "persistent_failure"
  // A genuine human-decision at the merge boundary (HITL hold / changes-requested at land).
  | "human_decision";

/**
 * The disposition the authority returns: the bucket + the diagnostic detail every caller
 * needs to drive the lifecycle writes (the run terminal status, the spec status, the
 * observable event). A pure value — the I/O (the run/spec UPDATE, the event append) is the
 * caller's, so this module stays a clock-free, DB-free decision core.
 *
 * task #82 (window-pause auto-resume): the FOURTH bucket — `pause_for_capacity` —
 * is the doctrine extension. A provider whose usage window is currently exhausted
 * is NOT dead (it is gated on a refresh signal that can land via the natural
 * reset OR a free reset the provider awards at any time); routing it through
 * `re_drive` would burn fresh runs / converge to `needs_attention` (the v62
 * wedge). Instead the run flips to the NEW non-terminal `paused` status, the
 * SPEC stays `in_flight`, and a background prober resumes it when capacity
 * returns — sign-of-life, never a wall-clock deadline.
 */
export type RunDisposition =
  | {
      bucket: "re_drive";
      // The public-safe classified failure: code + stage + a FIXED safe summary, PLUS the
      // fine-grained `cause` / `attribution` (and `precondition`, when blocked). The
      // convergence key is now the CAUSE, not the code. `undefined` for a benign
      // ancestor-wait (no fault).
      failure?: ClassifiedRunFailure;
      /**
       * PRECONDITION BLOCK (the never-park fix). Present exactly when this re-drive exists
       * because the run is waiting on a NAMED external condition rather than because it
       * hit a fault it could retry. The applier tags the emitted `dag.spec.redriven` with
       * `source: "precondition_block"` + this name, and BOTH convergence readers filter
       * those rows out — so waiting can never accumulate toward a fixed point, and the
       * spec resumes on its own the moment the condition clears.
       */
      preconditionBlock?: RunPrecondition;
      // The recoverable run.outcome to persist — `halted` for most re-drives, but a
      // `convergence_stalled` non-pass preserves its distinct WHY on the run row
      // (the recovery surface keys off it) while the SPEC still re-drives.
      runOutcome: "halted" | "convergence_stalled";
      // The public-safe sub-reason for the timeline (the old strand reasons as diagnostics).
      subReason: string;
      // The walker-honored cooldown before the spec is re-picked.
      backoffSeconds: number;
      // The consecutive-same-failure count (this failure included); 0 for a no-fault re-drive.
      consecutiveSameFailure: number;
    }
  | {
      // task #82 — window-pause auto-resume. The run hit a provider usage-window
      // exhaustion (writer's `window_exhausted` exit / answerer's
      // `CodexUsageLimitError` / preflight pressure escalation). UNBOUNDED — a
      // window pressure never escalates to `genuine_halt`; capacity always returns
      // (natural reset or free reset). The applier writes the run to the
      // NON-TERMINAL `paused` status, leaves the spec `in_flight`, and emits
      // `run.paused`; the background prober owns the resume.
      bucket: "pause_for_capacity";
      // The provider hint (writer's CLI label, e.g. "codex") — diagnostic, not
      // used by the convergence detector (window pressure has no fixed-point cap).
      provider: string;
      // A safe human-readable summary for the timeline ("the writer's usage
      // window was exhausted mid-subtask" / "the planner hit the codex usage limit").
      summary: string;
    }
  | {
      bucket: "genuine_halt";
      reason: GenuineHaltReason;
      // The classified failure (for a misconfiguration / persistent-failure halt), including
      // the fine-grained cause + the attribution the parked-state event now surfaces.
      failure?: ClassifiedRunFailure;
      // A SPECIFIC, actionable human-decision message (never a bare "an error occurred").
      message: string;
      // The escalating consecutive-same-failure count, for the persistent-failure case.
      consecutiveSameFailure: number;
      // apex v67 #122 — which detector fired the genuine-halt: the existing FIXED-POINT
      // detector ("strand", the default — the SAME-failure-repeating case) OR the NEW
      // WANDERING-HALT detector ("wandering_halt" — N re-drives with different failures
      // but no deliverable progress). Surfaces on the `dag.spec.needs_attention` event's
      // `source` field so operators can distinguish the two halt patterns. Defaults to
      // "strand" so every existing call site keeps its prior behavior.
      source?: "strand" | "wandering_halt";
      // apex v67 #122 — the wandering-halt diagnostics. Present ONLY when
      // `source === "wandering_halt"`; absent on the strand path so the existing payload
      // shape is unchanged for the fixed-point case.
      wanderingDiagnostics?: {
        totalRedrives: number;
        noProgressStreak: number;
        distinctFailureCodes: string[];
      };
    }
  | { bucket: "converge" };

/**
 * The CONVERGENCE FACTS the authority reasons over, instead of a hardcoded cap: the count
 * of CONSECUTIVE prior re-drives at the SAME structural fixed point (the same classified
 * failure AND — when observable — the same produced work), read from the durable event
 * log. `0` ⇒ the first attempt / a different failure than last time (progress) ⇒ ALWAYS
 * re-drive. `>= 1` ⇒ the loop is at a fixed point (this attempt is structurally identical
 * to the prior) ⇒ the run-finalize escalation rule fires (a PROVEN dead-end — no count).
 *
 * `priorSameFixedPoint` is the trailing run length the caller computed via the shared
 * `convergenceDetector` over the spec's `dag.spec.redriven` history (matching BOTH the
 * failure code AND, when present, the produced-work signature). A different failure code OR
 * a different produced-work signature breaks the run (progress), so the loop is UNBOUNDED
 * while it keeps changing the failure or the work — exactly the binding principle.
 */
export interface ConvergenceFacts {
  priorSameFixedPoint: number;
  /**
   * apex v67 #122 — the SECOND convergence signal: a wandering halt (N consecutive
   * re-drives with DIFFERENT failure codes but ZERO deliverable progress between them).
   * Computed by the caller via `assessWanderingHalt` over the spec's full re-drive
   * history + the spec-level PR/merge progress markers (see
   * `engine/workflow/wanderingHaltDetector.ts`). The fixed-point detector
   * (`priorSameFixedPoint`) keys on the SAME failure repeating; the wandering-halt
   * detector catches the changing-failure-no-progress trap the fixed-point judge
   * structurally cannot see.
   *
   * Optional + defaults to `{ wandering: false }` for back-compat with call sites that
   * have not been wired (e.g. the worker-orphan path, which has no spec-level PR/merge
   * facts at hand). When omitted, the authority falls back to the fixed-point-only
   * behavior — never a regression.
   */
  wandering?: WanderingHaltVerdict;
}
