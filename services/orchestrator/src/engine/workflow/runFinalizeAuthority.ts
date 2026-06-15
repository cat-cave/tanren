// THE ONE RUN-FINALIZE AUTHORITY (apex v35 — unified run-finalize lifecycle).
//
// Every run attempt has exactly ONE terminal outcome, and that outcome maps to
// exactly ONE of THREE buckets — the product owner's binding model:
//
//   1. RE-DRIVE (retry) — any RANDOM / TRANSIENT / internal / flaky / writer-mistake /
//      codex-hiccup / merge-conflict-resolvable / crashed-run / orphaned-slot fault.
//      The spec returns to a runnable state (`open`) and the walker enqueues a
//      successor run. Random failures are NEVER tolerable as terminal. Bounded ONLY by
//      a CONSECUTIVE-SAME-FAILURE counter (the SAME classified failure K times in a row
//      → escalate as a genuine issue; ANY progress / a DIFFERENT failure resets it) +
//      backoff — NEVER a wall-clock deadline, NEVER an infinite identical hot-loop.
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

// The DEFAULT cap K on CONSECUTIVE SAME-classified-failure re-drives before a spec
// escalates LOUDLY to `needs_attention`. Generous (a random failure resolves on retry;
// the per-spec/per-step timeouts remain the hang-detector), but BOUNDED so a genuinely
// STUCK spec (the same bug/mis-spec every time) surfaces as a human-decision rather than
// hot-looping forever. A DIFFERENT failure code (any progress) resets the count, so a
// spec that is flapping-but-advancing keeps retrying past this flat K.
export const DEFAULT_REDRIVE_ESCALATE_AT = 4;

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
// never self-heal on retry, so they escalate to `needs_attention` IMMEDIATELY (NOT bounded
// by the re-drive counter) with a specific diagnostic. `usage_limit` is NOT here (it is the
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
  // The SAME classified failure K consecutive times — a genuinely stuck spec (bug/mis-spec).
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
 * THE decision. Maps a terminal outcome (+ the consecutive-same-failure count the caller
 * read from the durable event log) to exactly ONE of the three buckets. PURE — no I/O, no
 * clock; the caller applies the verdict's writes. The escalate cap is `escalateAt`.
 *
 * The invariant this enforces: a RANDOM/TRANSIENT/internal/crash/orphan/conflict-resolvable
 * fault ALWAYS re-drives (it is NEVER terminal) UNTIL the same classified failure has
 * recurred K consecutive times; a misconfiguration / a genuine human-decision genuine-halts
 * IMMEDIATELY; success converges. No path silently drops or tolerates a random failure.
 */
export function decideRunDisposition(
  outcome: TerminalOutcome,
  consecutiveSameFailure: number,
  escalateAt: number = DEFAULT_REDRIVE_ESCALATE_AT,
): RunDisposition {
  if (outcome.kind === "ancestor_wait") {
    // A benign wait the dependent ran ahead of — a clean, NO-FAULT re-drive (it never
    // counts toward the consecutive-same-failure cap; the ancestor WILL publish its head).
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
    // budget spent / review stalled). ALL transient: the spec re-drives, bounded by the
    // SAME consecutive-same-failure cap (a spec stalling the SAME way K times is stuck).
    // The distinct WHY rides the run.outcome so the recovery surface keeps it.
    return decideFromCode(
      {
        code: "internal",
        stage: "agent",
        summary: nonPassSummary(outcome.detail),
        runOutcome: nonPassRunOutcome(outcome.detail),
      },
      outcome.detail,
      consecutiveSameFailure,
      escalateAt,
    );
  }
  // A thrown run-error: classify it through the SAME closed vocabulary the public events
  // use, then decide on the CODE (a credential misconfiguration genuine-halts; everything
  // else re-drives under the cap).
  const classified = classifyRunFailure(outcome.error);
  return decideFromCode({ ...classified, runOutcome: "halted" }, classified.code, consecutiveSameFailure, escalateAt);
}

/** The classified failure facts the shared decide-core reasons over (error + non-pass). */
interface FailureFacts {
  code: RunFailureCode;
  stage: RunFailureStage;
  summary: string;
  runOutcome: "halted" | "window_exhausted" | "convergence_stalled";
}

/** Decide the disposition for a classified failure (the error + non-pass shared core). */
function decideFromCode(
  facts: FailureFacts,
  subReason: string,
  consecutiveSameFailure: number,
  escalateAt: number,
): RunDisposition {
  const { code, stage, summary, runOutcome } = facts;
  const failure = { code, stage, summary };
  // A STRUCTURAL misconfiguration (credential / provider-mode) — a human must fix it; it
  // never self-heals, so it genuine-halts IMMEDIATELY (not bounded by the re-drive cap).
  if (GENUINE_TERMINAL_CODES.has(code)) {
    return {
      bucket: "genuine_halt",
      reason: "misconfiguration",
      failure,
      message: `${summary} (${code} @ ${stage}) — a structural cause a human must fix; requeue after addressing it`,
      consecutiveSameFailure,
    };
  }
  // RETRIABLE under the cap ⇒ RE-DRIVE. The SAME classified failure K consecutive times ⇒
  // a genuinely stuck spec (a bug / mis-spec, not a flake) ⇒ escalate ONCE, never a hot-loop.
  if (consecutiveSameFailure < escalateAt) {
    // A usage-limit fault halts the run `window_exhausted` (the distinct recovery WHY) even
    // when it arrives via the error path, not just a non-pass loop exit.
    const effectiveRunOutcome = code === "usage_limit" ? "window_exhausted" : runOutcome;
    return {
      bucket: "re_drive",
      failure,
      runOutcome: effectiveRunOutcome,
      subReason,
      backoffSeconds: redriveBackoffSeconds(consecutiveSameFailure),
      consecutiveSameFailure,
    };
  }
  return {
    bucket: "genuine_halt",
    reason: "persistent_failure",
    failure,
    message:
      `the run failed the same way (${code} @ ${stage}: ${summary}) ${consecutiveSameFailure} times in a row — ` +
      `the spec is genuinely stuck (a bug or mis-spec, not a flake); requeue after addressing the cause`,
    consecutiveSameFailure,
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
