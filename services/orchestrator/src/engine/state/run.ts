import { z } from "zod";

// Source-of-truth Zod enums for run state. The committed SQL CHECK
// constraints in db/migrations/0002 are generated from these via
// scripts/generate-state-checks.mjs and verified by the drift check.

// The single, canonical run-status vocabulary (v21). A successful run ends at
// `completed` — there is NO second `done` value, so every producer/consumer reads
// one vocabulary.
//
// `paused` (task #82 — window-pause auto-resume): a NON-TERMINAL "alive but
// not actively executing, waiting for capacity to refresh" state, distinct from
// `halted`. A `window_exhausted` writer outcome (or a `CodexUsageLimitError`
// from the answerer path) routes the run here — the spec stays `in_flight`
// (no successor enqueue) and the background prober transitions the run BACK
// to `halted` (recoverable) when capacity returns, at which point the walker
// re-drives the spec. This extends the timeout-eradication doctrine
// (sign-of-life, not wall-clock) to provider usage windows: a provider whose
// window is currently exhausted is NOT dead, it is gated on a refresh signal.
export const RunStatus = z.enum(["queued", "running", "paused", "halted", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;

// The run-outcome vocabulary. `ok` is the generic success outcome a completed run
// carries; the escape-hatch / exhaustion values name WHY a run ended. (The dead
// Phase-0/1/2 acceptance-fixture residue — `hello_complete`,
// `phase1_fixture_complete`, `phase2_easy_complete`, `phase2_medium_complete`, plus
// the older `hello_world_complete` + `pending` — were pruned: nothing on the live
// run path ever wrote them; only the old hello/phase validation fixtures did.)
//
// `window_paused` (task #82): the outcome stamped on a run that paused on a
// usage-window exhaustion — distinct from the legacy `window_exhausted` (which
// halted recoverable but kept escalating through the convergence detector). A
// `paused` run carries `window_paused` while waiting on the prober's resume;
// the resume flips the run to `halted` with the SAME `window_paused` outcome
// so the recovery surface keeps the distinct WHY without re-classifying.
//
// `provider_unhealthy` (task #82): the outcome a `paused` run terminates with
// when the prober detects the provider's probe ITSELF is broken (auth revoked,
// account suspended, CLI binary missing) — distinct from a recoverable
// capacity gap; escalates the spec to `needs_attention` so an operator can act.
export const RunOutcome = z.enum([
  "ok",
  "halted",
  "escape_hatch_hit",
  "retry_budget_exhausted",
  // SPEC-LOOP REDESIGN (docs/roadmap/spec-loop-redesign.md): the convergence answerer's
  // consecutive-stall HALT — the SOLE loop halt (besides budget). Replaces the purged
  // retry-cap halt as the in-loop "a human action is the genuine next step" outcome.
  "convergence_stalled",
  "window_exhausted",
  "window_paused",
  "provider_unhealthy",
  "cancelled",
  "failed",
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

// Legal status transitions per the spec. A successful run lands at `completed`.
// The operator cancel-spec/cancel-run action (workflow/cancelSpec) can cancel a run
// from ANY non-terminal status — including a still-`queued` run that never started —
// so `queued → cancelled` is legal (the operator decided the work should not proceed).
//
// task #82: `paused` is a non-terminal "awaiting capacity" state. A `running`
// run that hits `window_exhausted` flips to `paused`; the background prober
// resumes it by flipping to `halted` (re-drive, walker re-enqueues) once
// capacity returns, or terminates it `failed` when the provider is
// structurally unhealthy. A `queued` run that the preflight catches at
// window pressure can flip straight to `paused` without ever `running`.
const allowedRunTransitions: Record<RunStatus, ReadonlyArray<RunStatus>> = {
  queued: ["running", "paused", "cancelled"],
  running: ["paused", "halted", "completed", "failed", "cancelled"],
  paused: ["halted", "failed", "cancelled"],
  halted: ["running", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isAllowedRunTransition(from: RunStatus, to: RunStatus): boolean {
  return allowedRunTransitions[from].includes(to);
}

export class IllegalRunTransitionError extends Error {
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(`illegal run transition: ${from} -> ${to}`);
  }
}

// transitionRun fails at runtime on illegal transitions; the overload
// shape lets the compiler narrow that the to/from pair was checked. Callers
// should pass values whose types are already RunStatus (decoded by the
// repository) so the compiler proves they are valid enum members.
export function transitionRun(from: RunStatus, to: RunStatus): asserts to is RunStatus {
  if (!isAllowedRunTransition(from, to)) {
    throw new IllegalRunTransitionError(from, to);
  }
}

export function listAllowedRunTransitions(from: RunStatus): ReadonlyArray<RunStatus> {
  return allowedRunTransitions[from];
}
