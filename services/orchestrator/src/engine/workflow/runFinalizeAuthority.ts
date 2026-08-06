// THE ONE RUN-FINALIZE AUTHORITY (apex v35 — unified run-finalize lifecycle).
//
// Every attempt maps to exactly one bucket:
//   1. RE-DRIVE — transient/internal/flaky/recoverable faults. Retry without an
//      attempt or time cap while new information appears; only a detected fixed
//      point escalates. Growing bounded backoff prevents hot loops.
//   2. GENUINE-HALT — budget exhaustion, structural misconfiguration/mis-spec,
//      or a real human decision. These alone enter actionable `needs_attention`.
//   3. CONVERGE — merged/done.
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
// This module takes a normalized terminal outcome plus fixed-point evidence and
// returns one bucket identically for workflow, worker, and orphan paths.

import {
  type ClassifiedRunFailure,
  classifyRunFailure,
  explicitRunFailureRetryability,
  type RunFailureCause,
  type RunFailureCode,
} from "../worker/runFailureClassifier.js";
import type { WanderingHaltVerdict } from "./wanderingHaltDetector.js";

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

// A GENUINE-TERMINAL failure CODE: a STRUCTURAL cause a human must fix. These never
// self-heal on retry, so they escalate to `needs_attention` IMMEDIATELY (NOT subject to
// the re-drive convergence detector) with a specific diagnostic. `usage_limit` is NOT here
// (it is the recoverable window-exhausted halt → pause for capacity); `workspace` is NOT
// here (a deps-install / bootstrap fault is transient → re-drive). Everything ELSE
// (`internal`, `merge`, `deploy`, and any unrecognized error → the `internal` default) is
// RETRIABLE — a random fault.
//
// WHAT REMAINS REACHABLE HERE, AND WHY THE SET STAYS. The PRECONDITION check below now runs
// BEFORE this one, and every `credential`-coded class that is merely WAITING on something
// external carries a precondition: `MissingCredentialError`,
// `MissingGithubCredentialRefError` and `MissingGithubAppCredentialRefError` all
// short-circuit into an indefinite re-drive and never reach this line. What is LEFT is the
// scoping-defect pair `UnscopedOrgError` (credential resolution reached without its org
// scope) and `OrgProviderModeUnresolved` (the org row read back empty for a non-empty org id
// — an off-scope / RLS-denied read). Both are `attribution: "tanren"`: defects in the
// orchestrator, with NO external condition that could become true to fix them, so neither
// carries a precondition. Retrying them forever would be a hot loop with no probe — exactly
// what the precondition mechanism is designed to avoid — so they SHOULD halt loudly and
// immediately. The set is therefore live code with two live members — not a vestige. (It is
// spelled by CODE rather than by cause because `code` is the stable public contract; a
// future genuinely-terminal class simply must not carry a precondition.)
const GENUINE_TERMINAL_CODES: ReadonlySet<RunFailureCode> = new Set<RunFailureCode>(["credential"]);

// The authority's TYPE surface (TerminalOutcome / NonPassDetail / MergeOutcomeForDisposition
// / GenuineHaltReason / RunDisposition / ConvergenceFacts) lives in its own module for the
// 500-line cap — see `runFinalizeAuthorityTypes.ts`. RE-EXPORTED here so every existing
// import site keeps importing them from the authority.
export type {
  ConvergenceFacts,
  GenuineHaltReason,
  MergeOutcomeForDisposition,
  NonPassDetail,
  RunDisposition,
  TerminalOutcome,
} from "./runFinalizeAuthorityTypes.js";
import type {
  ConvergenceFacts,
  MergeOutcomeForDisposition,
  NonPassDetail,
  RunDisposition,
  TerminalOutcome,
} from "./runFinalizeAuthorityTypes.js";

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
    // task #82: a `window_exhausted` non-pass routes to the NEW pause bucket
    // (the writer/planner hit the provider's usage window) — UNBOUNDED, never
    // escalates to genuine-halt; capacity always returns and the background
    // prober resumes. Every OTHER non-pass detail (convergence/gate/review)
    // stays on the existing re-drive bucket.
    if (outcome.detail === "window_exhausted") {
      return {
        bucket: "pause_for_capacity",
        provider: "agent",
        summary: nonPassSummary(outcome.detail),
      };
    }
    // A non-pass planner-loop exit (writer never converged / gate budget spent /
    // review stalled). ALL transient: the spec re-drives, UNBOUNDED while the
    // failure keeps changing; it escalates only at a fixed point (the SAME
    // non-pass exit recurring). The distinct WHY rides the run.outcome so
    // recovery keeps it.
    return decideFromCode(
      {
        code: "internal",
        stage: "agent",
        summary: nonPassSummary(outcome.detail),
        // The non-pass exits kept ONE failure code (`internal`) between them, so a spec
        // that stalled, then failed its merge gate, then stalled its review presented
        // three IDENTICAL convergence signatures and read as a fixed point. Each detail
        // now carries its own cause; the public `code` is unchanged.
        cause: nonPassCause(outcome.detail),
        attribution: "unknown",
        runOutcome: nonPassRunOutcome(outcome.detail),
      },
      outcome.detail,
      facts,
    );
  }
  if (outcome.kind === "classified_error") {
    // The worker orphan path already classified the raw throw; decide on it directly so
    // the cause / attribution / precondition survive to the disposition.
    return decideClassifiedFailure(outcome.failure, facts);
  }
  // A thrown run-error: classify it through the SAME closed vocabulary the public events
  // use, then decide on the CODE (a credential misconfiguration genuine-halts;
  // a usage-limit pauses for capacity; everything else re-drives while
  // progressing, escalating only at a fixed point).
  const classified = classifyRunFailure(outcome.error);
  const publicationRetryability = explicitRunFailureRetryability(outcome.error);
  if (publicationRetryability === "retriable") {
    return {
      bucket: "re_drive",
      failure: classified,
      runOutcome: "halted",
      subReason: "simulated_review_publication_retriable",
      backoffSeconds: redriveBackoffSeconds(facts.priorSameFixedPoint),
      consecutiveSameFailure: facts.priorSameFixedPoint + 1,
    };
  }
  if (publicationRetryability === "non_retriable") {
    return {
      bucket: "genuine_halt",
      reason: "persistent_failure",
      failure: classified,
      message: `${classified.summary} (${classified.code} @ ${classified.stage}) — correct the publication configuration or proof before requeueing`,
      consecutiveSameFailure: facts.priorSameFixedPoint + 1,
    };
  }
  return decideClassifiedFailure(classified, facts);
}

/** Decide over an already-classified failure — the shared tail of BOTH the thrown-error
 * path and the worker orphan path, so the two agree by construction. */
function decideClassifiedFailure(classified: ClassifiedRunFailure, facts: ConvergenceFacts): RunDisposition {
  if (classified.code === "usage_limit") {
    // task #82: the answerer-path's `CodexUsageLimitError` / `ClaudeUsageLimitError`
    // (planner / checker / auditor hit the provider window). Routes to the SAME pause
    // bucket as the writer's `window_exhausted` outcome — one disposition for the whole
    // window-pressure family.
    return {
      bucket: "pause_for_capacity",
      provider: "agent",
      summary: classified.summary,
    };
  }
  return decideFromCode({ ...classified, runOutcome: "halted" }, classified.code, facts);
}

/** The classified failure facts the shared decide-core reasons over (error + non-pass).
 *
 * task #82: `window_exhausted` is GONE from this union — a window-pressure
 * outcome routes to the new `pause_for_capacity` bucket at the top of
 * `decideRunDisposition`, never through the re-drive convergence detector. */
interface FailureFacts extends ClassifiedRunFailure {
  runOutcome: "halted" | "convergence_stalled";
}

/** Decide the disposition for a classified failure (the error + non-pass shared core). */
function decideFromCode(failureFacts: FailureFacts, subReason: string, facts: ConvergenceFacts): RunDisposition {
  const { runOutcome, ...failure } = failureFacts;
  const { code, stage, summary, precondition } = failure;
  const { priorSameFixedPoint } = facts;
  // ── PRECONDITION BLOCK ─────────────────────────────────────────────────────────────
  // Checked FIRST — ahead of the genuine-terminal set and ahead of the convergence
  // detector — because a run blocked on a named external condition is not FAILING, it is
  // WAITING, and neither of those mechanisms is a correct judge of a wait.
  //
  // The doctrine: "Halts are not tolerable. If tanren is working correctly, a user has
  // budget, and the roadmap is not complete, halting means a fundamental failure in
  // tanren." Every blocking cause observed on the live instance — an absent SSH
  // key, an unseeded credential, a mis-set config, a control plane returning 500 — was
  // environmental, and every one of them CLEARED later. Tanren resumed for none of them,
  // because a missing credential parked on its FIRST occurrence and an SSH outage
  // manufactured a false fixed point on its third.
  //
  // The mechanism is deliberately NOT new: it is `usage/pausedRunResumeProber.ts`'s
  // "RE-DRIVE IS THE PROBE" pattern, generalized from the one hard-coded condition it
  // already handles (a provider usage window) to any NAMED condition. The next run's own
  // attempt IS the test of whether the condition cleared — no separate health-check, no
  // new run status, no operator action. Exactly as with `prober_resume`, the emitted row
  // is tagged with a `source` that BOTH history readers exclude, so the wait can never
  // itself become the evidence that the spec is stuck.
  //
  // `consecutiveSameFailure: 0` states the same thing on the payload: a wait is not a
  // strike. The backoff is the base rung of the existing curve — a fixed probe CADENCE
  // (the prober's own model: "sign-of-life, never a deadline"), not an escalating
  // punishment, since there is no streak to escalate against.
  if (precondition !== undefined) {
    return {
      bucket: "re_drive",
      failure,
      runOutcome,
      subReason: `precondition_${precondition}`,
      backoffSeconds: redriveBackoffSeconds(0),
      consecutiveSameFailure: 0,
      preconditionBlock: precondition,
    };
  }
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
    // apex v67 #122 — the SECOND convergence escalation. The fixed-point detector said
    // "progress" (this attempt's failure differs from prior re-drives), but the spec may
    // still be WANDERING — re-driving across a varied failure surface with no deliverable
    // progress. Consulted ONLY at this position (the fixed-point detector wins when both
    // would fire — a same-failure spec escalates as `strand`, not `wandering_halt`).
    const wandering = maybeWanderingHalt(failure, facts.wandering);
    if (wandering !== undefined) return wandering;
    // task #82: `usage_limit` is now routed UPSTREAM (in `decideRunDisposition`)
    // to the `pause_for_capacity` bucket — never reaches this point. The
    // `runOutcome` is the FailureFacts as-passed (`halted` or
    // `convergence_stalled`).
    return {
      bucket: "re_drive",
      failure,
      runOutcome,
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
      `the run reached a FIXED POINT (${failure.cause} / ${code} @ ${stage}: ${summary}) — it produced the identical ` +
      `failure (and identical work, where observable) with no new information across re-drives; the spec is ` +
      `genuinely stuck (a bug or mis-spec, not a flake), so a human must intervene. ` +
      `${attributionAsk(failure.attribution)} Requeue after addressing the cause`,
    consecutiveSameFailure: priorSameFixedPoint + 1,
    source: "strand",
  };
}

/**
 * The human-readable half of the ATTRIBUTION, folded into every parked-state message.
 *
 * A halt is a BUG REPORT, not a terminal state: it means either a bug in tanren or a bug
 * in the target repository, and BOTH get fixed. An operator reading a parked spec should
 * not have to work out which repository to open — the message says so outright. When the
 * classifier honestly cannot tell (a catch-all class), the message says THAT instead of
 * guessing, because a confident wrong answer sends the fix to the wrong codebase.
 */
export function attributionAsk(attribution: ClassifiedRunFailure["attribution"]): string {
  const asks: Record<ClassifiedRunFailure["attribution"], string> = {
    tanren: "ATTRIBUTION: this is a bug in TANREN — fix it in the orchestrator.",
    target_repo: "ATTRIBUTION: this is a bug in the TARGET REPOSITORY — fix it there.",
    environment:
      "ATTRIBUTION: this is an ENVIRONMENT condition (a provisioned resource is absent or " +
      "unreachable) — neither codebase is wrong; restore the resource.",
    unknown:
      "ATTRIBUTION: UNKNOWN — the failure class cannot yet say whether this is tanren's bug " +
      "or the target repository's; narrowing the classifier for this class is itself the fix.",
  };
  return asks[attribution];
}

/**
 * apex v67 #122 — the SECOND convergence escalation: a WANDERING halt. If the caller's
 * wandering verdict says the spec has accumulated N consecutive re-drives with ZERO
 * deliverable progress (a different failure each time, no PR opened, no merge, no new
 * pipeline stage), escalate to `genuine_halt` with `source: "wandering_halt"` and
 * `reason: "persistent_failure"`. The fixed-point detector runs FIRST (in
 * `decideFromCode`); this check is consulted only when the fixed-point detector returned
 * "progress" (so this catches what the fixed-point detector structurally cannot — a
 * varied failure surface with no forward motion).
 *
 * Returns `undefined` when no wandering verdict is supplied (back-compat for orphan-path
 * callers that don't compute wandering facts) OR when the verdict says "not wandering".
 */
function maybeWanderingHalt(
  failure: ClassifiedRunFailure,
  wandering: WanderingHaltVerdict | undefined,
): RunDisposition | undefined {
  if (wandering === undefined || !wandering.wandering) return undefined;
  const { totalRedrives, noProgressStreak, distinctFailureCodes } = wandering;
  return {
    bucket: "genuine_halt",
    reason: "persistent_failure",
    failure,
    message:
      `the spec re-drove ${totalRedrives} times across ${distinctFailureCodes.length} distinct failure ` +
      `classes (${distinctFailureCodes.join(", ")}) without making any deliverable progress (no PR opened, ` +
      `no merge, no new pipeline stage reached) — a WANDERING halt: the autonomous self-heal is changing its ` +
      `failure mode without converging on a solution, so a human must intervene. ` +
      `${attributionAsk(failure.attribution)} Requeue after addressing the cause`,
    consecutiveSameFailure: 0,
    source: "wandering_halt",
    wanderingDiagnostics: { totalRedrives, noProgressStreak, distinctFailureCodes },
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
  // a `blocked`/`conflict`/`re_gate_pending`/`handed_off`/`failed` are transient holds the
  // recovery surface re-drives (a `re_gate_pending` native gate just needs to finish). Either
  // way this is a re-drive bucket from the spec's vantage; the caller distinguishes the
  // native-queue-completed run write from the spec disposition.
  return {
    bucket: "re_drive",
    runOutcome: "halted",
    subReason: `merge_${mergeOutcome}`,
    backoffSeconds: 0,
    consecutiveSameFailure: 0,
  };
}

/** The recoverable run.outcome a non-pass exit persists (preserves the distinct WHY for recovery).
 *
 * task #82: `window_exhausted` is routed to the `pause_for_capacity` bucket
 * upstream, so this never sees it on the re-drive path (defense-in-depth: a
 * future caller hitting this branch with `window_exhausted` would map to
 * `halted` and slot back into the re-drive convergence detector — the prior
 * behavior, never a regression). */
function nonPassRunOutcome(detail: NonPassDetail): "halted" | "convergence_stalled" {
  if (detail === "convergence_stalled") return "convergence_stalled";
  return "halted";
}

/** The FINE-GRAINED cause for each non-pass sub-reason — one per detail, so two different
 * non-pass exits are two different convergence states rather than one repeated `internal`. */
function nonPassCause(detail: NonPassDetail): RunFailureCause {
  const causes: Record<NonPassDetail, RunFailureCause> = {
    // Routed to `pause_for_capacity` upstream, so this arm is only for totality.
    window_exhausted: "provider_usage_window_exhausted",
    convergence_stalled: "planner_convergence_stalled",
    merge_gate_unsatisfied: "merge_gate_unsatisfied",
    pre_merge_behavior_unsatisfied: "pre_merge_behavior_unsatisfied",
    review_stalled: "review_stalled",
    halted: "run_halted_without_change",
  };
  return causes[detail];
}

/** A FIXED, public-safe summary for each non-pass sub-reason (never the raw error string). */
function nonPassSummary(detail: NonPassDetail): string {
  const summaries: Record<NonPassDetail, string> = {
    window_exhausted: "the agent's usage window was exhausted mid-run",
    convergence_stalled: "the planner loop stalled without converging",
    merge_gate_unsatisfied: "the pre-merge gate was not satisfied within the self-heal budget",
    pre_merge_behavior_unsatisfied: "a pre-merge behavior verification failed or could not be proven on the preview",
    review_stalled: "the review did not resolve within the poll/rework budget",
    halted: "the run halted without producing a mergeable change",
  };
  return summaries[detail];
}
