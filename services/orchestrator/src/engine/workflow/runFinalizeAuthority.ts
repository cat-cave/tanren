// THE ONE RUN-FINALIZE AUTHORITY (apex v35 — unified run-finalize lifecycle).
//
// Every run attempt has exactly ONE terminal outcome, and that outcome maps to
// exactly ONE of THREE buckets — the product owner's binding model:
//
//   1. RE-DRIVE (retry) — any RANDOM / TRANSIENT / internal / flaky / writer-mistake /
//      codex-hiccup / merge-conflict-resolvable / crashed-run / orphaned-slot fault.
//      The spec returns to a runnable state (`open`) and the walker enqueues a
//      successor run. Random failures are NEVER tolerable as terminal. UNBOUNDED while
//      it is making PROGRESS — there is NO attempt cap, NO `K`, NO wall-clock deadline.
//      A re-drive escalates ONLY at an intelligently-detected FIXED POINT (the SAME
//      classified failure recurring with no new information — the shared
//      `convergenceDetector`); ANY progress / a DIFFERENT failure keeps it re-driving,
//      forever, while it converges. Backoff (grows with the stuck streak) prevents a
//      hot-loop WITHOUT a counter.
//
//   2. GENUINE-HALT — ONLY: budget exhaustion · misconfiguration (missing/unscoped
//      credential, provider-mode unresolved) · mis-spec (a spec structurally
//      unsatisfiable) · a genuine human-decision (a real product/architecture decision
//      a human must MAKE — e.g. a HITL hold or changes-requested-at-land-time, or a
//      genuinely-irreconcilable merge conflict). These → `needs_attention` with a
//      SPECIFIC, actionable reason (or the budget halt). `needs_attention` is RESERVED
//      for these.
//
//   3. CONVERGE — success (merged / done).
//
// THE FRAGMENTATION THIS REPLACES (the whack-a-mole): the disposition decision used to
// live in SIX scattered sites, each hard-coding its own spec disposition —
//   • the generic-error re-drive/escalate (`plannerRunRedrive.ts`),
//   • the workspace-bootstrap / usage-limit / ancestor-wait error branches
//     (`finalizeWorkflowError`),
//   • the writer-non-pass / convergence-stall / window-exhausted exit
//     (`finalizeNonPassAndPark`),
//   • the merge-gate budget-spent halt (`applyFailedMergeGate`),
//   • the review-verdict stall/changes-requested-exhausted halt (`applyReviewVerdict`),
//   • the merge-stage outcome mapping (`finalizeMergeOutcome`),
//   • and the worker orphan reconciler (`runFinalize.ts`).
// Three of those (writer-non-pass, merge-gate halt, review-stall) PARKED transient
// faults at `needs_attention` instead of re-driving — and three different strand
// reasons (`halted_reexec`, `no_live_run`, `persistent_failure`) surfaced the SAME
// class of transient failure run-to-run. This module is the SINGLE decision: it takes a
// terminal outcome + the consecutive-same-failure count and returns ONE bucket, applied
// identically whether the outcome arrives via the workflow path, the worker path, or the
// orphan reconciler. The per-path strand logic collapses into routing this verdict.

import { classifyRunFailure, type RunFailureCode, type RunFailureStage } from "../worker/runFailureClassifier.js";

// The base backoff (seconds) between re-drives + the per-attempt growth, so the
// re-enqueue does not hot-loop. The walker honors `backoffSeconds` (the cooldown before
// it re-picks the `open` spec). Grows linearly with the consecutive-same-failure count,
// capped, so an early flake retries promptly while a repeatedly-failing spec backs off.
const REDRIVE_BACKOFF_BASE_SECONDS = 30;
const REDRIVE_BACKOFF_MAX_SECONDS = 600;

/** The walker-honored re-drive backoff (seconds) for the Nth consecutive same-failure re-drive. */
export function redriveBackoffSeconds(consecutiveSameFailure: number): number {
  const grown = REDRIVE_BACKOFF_BASE_SECONDS * Math.max(1, consecutiveSameFailure);
  return Math.min(grown, REDRIVE_BACKOFF_MAX_SECONDS);
}

// A GENUINE-TERMINAL failure CODE: a STRUCTURAL cause a human must fix (a
// misconfiguration / missing-or-unscoped credential / unresolvable provider mode). These
// never self-heal on retry, so they escalate to `needs_attention` IMMEDIATELY (NOT subject
// to the re-drive convergence detector) with a specific diagnostic. `usage_limit` is NOT here (it is the
// recoverable window-exhausted halt → re-drive); `workspace` is NOT here (a deps-install /
// bootstrap fault is transient → re-drive). Everything ELSE (`internal`, `merge`, `deploy`,
// and any unrecognized error → the `internal` default) is RETRIABLE — a random fault.
const GENUINE_TERMINAL_CODES: ReadonlySet<RunFailureCode> = new Set<RunFailureCode>(["credential"]);

/**
 * A terminal run-outcome, expressed in the vocabulary THIS authority decides over. Every
 * terminal site (the workflow error catch, the writer-non-pass exit, the merge-gate /
 * review stalls, the merge-stage outcome, the worker orphan reconciler) normalizes its
 * outcome into ONE of these before asking for a disposition — so the 3-bucket mapping
 * lives in ONE place, never re-implemented per site.
 */
export type TerminalOutcome =
  // A thrown run-error (the workflow catch / the worker orphan path). The authority
  // classifies it through the SAME closed run-failure vocabulary the public events use.
  | { kind: "error"; error: unknown }
  // A non-pass planner-loop exit (the writer never converged / a window exhausted / a
  // convergence stall / a merge-gate budget spent / a review stall). ALL transient:
  // the spec re-drives. The `detail` is a public-safe sub-reason for observability.
  | { kind: "non_pass"; detail: NonPassDetail }
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
 */
export type RunDisposition =
  | {
      bucket: "re_drive";
      // The public-safe classified failure code (the consecutive-same-failure key) +
      // stage + a FIXED safe summary. `undefined` for a benign ancestor-wait (no fault).
      failure?: { code: RunFailureCode; stage: RunFailureStage; summary: string };
      // The recoverable run.outcome to persist — `halted` for most re-drives, but a
      // `window_exhausted` / `convergence_stalled` non-pass preserves its distinct WHY on
      // the run row (the recovery surface keys off it) while the SPEC still re-drives.
      runOutcome: "halted" | "window_exhausted" | "convergence_stalled";
      // The public-safe sub-reason for the timeline (the old strand reasons as diagnostics).
      subReason: string;
      // The walker-honored cooldown before the spec is re-picked.
      backoffSeconds: number;
      // The consecutive-same-failure count (this failure included); 0 for a no-fault re-drive.
      consecutiveSameFailure: number;
    }
  | {
      bucket: "genuine_halt";
      reason: GenuineHaltReason;
      // The classified failure (for a misconfiguration / persistent-failure halt).
      failure?: { code: RunFailureCode; stage: RunFailureStage; summary: string };
      // A SPECIFIC, actionable human-decision message (never a bare "an error occurred").
      message: string;
      // The escalating consecutive-same-failure count, for the persistent-failure case.
      consecutiveSameFailure: number;
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
}

/**
 * THE decision. Maps a terminal outcome (+ the convergence facts the caller read from the
 * durable event log via the shared `convergenceDetector`) to exactly ONE of the three
 * buckets. PURE — no I/O, no clock; the caller applies the verdict's writes.
 *
 * The invariant this enforces (NO hardcoded attempt cap — apex v35): a
 * RANDOM/TRANSIENT/internal/crash/orphan/conflict-resolvable fault ALWAYS re-drives (it is
 * NEVER terminal) while it is making PROGRESS — a DIFFERENT failure or DIFFERENT produced
 * work keeps it re-driving UNBOUNDED. It escalates ONLY at an intelligently-detected FIXED
 * POINT (`priorSameFixedPoint >= 1`: the same classified failure recurring with the same —
 * or unobservable — work, no new information). A misconfiguration / a genuine human-decision
 * genuine-halts IMMEDIATELY; success converges. No path silently drops a random failure.
 */
export function decideRunDisposition(outcome: TerminalOutcome, facts: ConvergenceFacts): RunDisposition {
  if (outcome.kind === "ancestor_wait") {
    // A benign wait the dependent ran ahead of — a clean, NO-FAULT re-drive (it never
    // counts toward the convergence detector; the ancestor WILL publish its head).
    return {
      bucket: "re_drive",
      runOutcome: "halted",
      subReason: "ancestor_not_ready",
      backoffSeconds: 0,
      consecutiveSameFailure: 0,
    };
  }
  if (outcome.kind === "merge") {
    return decideMergeOutcome(outcome.mergeOutcome);
  }
  if (outcome.kind === "non_pass") {
    // A non-pass planner-loop exit (writer never converged / window exhausted / gate
    // budget spent / review stalled). ALL transient: the spec re-drives, UNBOUNDED while
    // the failure keeps changing; it escalates only at a fixed point (the SAME non-pass
    // exit recurring). The distinct WHY rides the run.outcome so recovery keeps it.
    return decideFromCode(
      {
        code: "internal",
        stage: "agent",
        summary: nonPassSummary(outcome.detail),
        runOutcome: nonPassRunOutcome(outcome.detail),
      },
      outcome.detail,
      facts,
    );
  }
  // A thrown run-error: classify it through the SAME closed vocabulary the public events
  // use, then decide on the CODE (a credential misconfiguration genuine-halts; everything
  // else re-drives while progressing, escalating only at a fixed point).
  const classified = classifyRunFailure(outcome.error);
  return decideFromCode({ ...classified, runOutcome: "halted" }, classified.code, facts);
}

/** The classified failure facts the shared decide-core reasons over (error + non-pass). */
interface FailureFacts {
  code: RunFailureCode;
  stage: RunFailureStage;
  summary: string;
  runOutcome: "halted" | "window_exhausted" | "convergence_stalled";
}

/** Decide the disposition for a classified failure (the error + non-pass shared core). */
function decideFromCode(failureFacts: FailureFacts, subReason: string, facts: ConvergenceFacts): RunDisposition {
  const { code, stage, summary, runOutcome } = failureFacts;
  const failure = { code, stage, summary };
  const { priorSameFixedPoint } = facts;
  // A STRUCTURAL misconfiguration (credential / provider-mode) — a human must fix it; it
  // never self-heals, so it genuine-halts IMMEDIATELY (not subject to the convergence detector).
  if (GENUINE_TERMINAL_CODES.has(code)) {
    return {
      bucket: "genuine_halt",
      reason: "misconfiguration",
      failure,
      message: `${summary} (${code} @ ${stage}) — a structural cause a human must fix; requeue after addressing it`,
      consecutiveSameFailure: priorSameFixedPoint + 1,
    };
  }
  // The shared CONVERGENCE DETECTOR decides — NOT a count. `priorSameFixedPoint === 0`
  // means this attempt made PROGRESS (the first of its kind, or a DIFFERENT failure /
  // DIFFERENT produced work than last time) ⇒ RE-DRIVE, UNBOUNDED. `>= 1` means the loop is
  // at a structural FIXED POINT (the same classified failure recurring with the same — or
  // unobservable — work, no new information) ⇒ a PROVEN dead-end ⇒ escalate ONCE. There is
  // no attempt cap: a flapping-but-changing spec re-drives forever; only a genuinely stuck
  // one (identical failure + identical work) surfaces as a human-decision.
  const atFixedPoint = priorSameFixedPoint >= 1;
  if (!atFixedPoint) {
    // A usage-limit fault halts the run `window_exhausted` (the distinct recovery WHY) even
    // when it arrives via the error path, not just a non-pass loop exit.
    const effectiveRunOutcome = code === "usage_limit" ? "window_exhausted" : runOutcome;
    return {
      bucket: "re_drive",
      failure,
      runOutcome: effectiveRunOutcome,
      subReason,
      backoffSeconds: redriveBackoffSeconds(priorSameFixedPoint),
      consecutiveSameFailure: priorSameFixedPoint + 1,
    };
  }
  return {
    bucket: "genuine_halt",
    reason: "persistent_failure",
    failure,
    message:
      `the run reached a FIXED POINT (${code} @ ${stage}: ${summary}) — it produced the identical failure ` +
      `(and identical work, where observable) with no new information across re-drives; the spec is ` +
      `genuinely stuck (a bug or mis-spec, not a flake), so a human must intervene; requeue after addressing the cause`,
    consecutiveSameFailure: priorSameFixedPoint + 1,
  };
}

/**
 * Map the merge stage's terminal outcome to a bucket. `merged` CONVERGES; a genuine
 * HITL/changes-requested human-decision (`needs_attention`) GENUINE-HALTS; EVERY other
 * hold (`blocked` — a transient authority refusal / CAS race), `conflict` (resolvable),
 * `handed_off`, `queued` (a non-native enqueue), and `failed` (a transient merge fault)
 * RE-DRIVES — the work is never discarded, the walker re-attempts the merge.
 */
function decideMergeOutcome(mergeOutcome: MergeOutcomeForDisposition): RunDisposition {
  if (mergeOutcome === "merged") return { bucket: "converge" };
  if (mergeOutcome === "needs_attention") {
    return {
      bucket: "genuine_halt",
      reason: "human_decision",
      message:
        "the merge authority requires a human decision (a HITL hold or changes-requested at land time); " +
        "resolve the review and requeue",
      consecutiveSameFailure: 0,
    };
  }
  // A `queued` native-queue enqueue is the coordinator's continuation (not a halt) — the
  // caller converges the RUN but leaves the spec non-done; a `queued` non-native enqueue,
  // a `blocked`/`conflict`/`handed_off`/`failed` are transient holds the recovery surface
  // re-drives. Either way this is a re-drive bucket from the spec's vantage; the caller
  // distinguishes the native-queue-completed run write from the spec disposition.
  return {
    bucket: "re_drive",
    runOutcome: "halted",
    subReason: `merge_${mergeOutcome}`,
    backoffSeconds: 0,
    consecutiveSameFailure: 0,
  };
}

/** The recoverable run.outcome a non-pass exit persists (preserves the distinct WHY for recovery). */
function nonPassRunOutcome(detail: NonPassDetail): "halted" | "window_exhausted" | "convergence_stalled" {
  if (detail === "window_exhausted") return "window_exhausted";
  if (detail === "convergence_stalled") return "convergence_stalled";
  return "halted";
}

/** A FIXED, public-safe summary for each non-pass sub-reason (never the raw error string). */
function nonPassSummary(detail: NonPassDetail): string {
  const summaries: Record<NonPassDetail, string> = {
    window_exhausted: "the agent's usage window was exhausted mid-run",
    convergence_stalled: "the planner loop stalled without converging",
    merge_gate_unsatisfied: "the pre-merge gate was not satisfied within the self-heal budget",
    review_stalled: "the review did not resolve within the poll/rework budget",
    halted: "the run halted without producing a mergeable change",
  };
  return summaries[detail];
}
