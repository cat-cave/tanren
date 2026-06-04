// The NEVER-STRAND reconciler seam: the DAG's self-healing safety net. A spec can
// get stuck `active`/`in_flight` while OCCUPYING A DAG SLOT with NO live run — the
// recurring stranding bug. The canonical cause: a change-percolation §2c re-exec
// halts, so the spec stays `active` with BOTH its runs terminal (the prior run
// `cancelled` + the re-exec `halted`), the percolation read model excludes terminal
// runs so it can't self-heal the orphaned marker, and `classifySpecStatus` maps the
// `active` column straight to `in_flight` without ever checking for a live run. The
// slot is occupied forever — a permanent strand.
//
// This seam carries the PURE strand predicate (`decideStrand`) so the EXACT safe
// condition is conformance-tested with no database — mirroring the DagWalker's pure
// `planDagTick` and the percolation `decidePercolation`. The pg-backed read model +
// the flip/clear writer + the event emitter live in `engine/dag/specStrandReconcilerPg.ts`,
// and the coordinator that composes them in `engine/dag/specStrandReconciler.ts`.
//
// The condition is DELIBERATELY conservative: a spec is reconcilable (flip
// `active → pending`, re-enqueue) ONLY when EVERY one of five conditions holds, so a
// spec that is legitimately running / queued / merge-queued / mid-LIVE-percolation is
// NEVER yanked. The reconciler runs LAST in the walk chain (walk → percolate →
// reconcile), so percolation owns any spec whose marker points at a LIVE run
// (condition 4 hand-off) and the reconciler only acts on what neither legitimately
// claimed.

import { classifySpecStatus } from "../dag/walkerPg.js";

/**
 * The run statuses that mean a run is LIVE (still doing work) vs. TERMINAL. The
 * column the strand classifier (`classifySpecStatus`) ignores: a spec can read
 * `active` while every one of its runs is in a terminal state.
 */
const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["queued", "running"]);

/** True iff a run status means the run is still LIVE (queued/running). */
export function isLiveRunStatus(status: string): boolean {
  return LIVE_RUN_STATUSES.has(status);
}

/** One of the spec's runs, as the strand predicate reasons over it. */
export interface StrandRunView {
  runId: string;
  status: string;
  /**
   * The decoded in-flight percolation marker carried on this run (if any), with the
   * re-exec run it points at — and whether THAT re-exec run is itself still LIVE.
   * A marker on a TERMINAL run with a TERMINAL (or absent) re-exec is the orphaned
   * strand marker the reconciler clears; a marker whose re-exec is LIVE means
   * percolation owns the spec → the reconciler must leave it (condition 4).
   */
  percolationPending?: {
    reexecRunId: string;
    /** Whether the run the marker points at (`reexecRunId`) is still queued/running. */
    reexecRunLive: boolean;
  };
}

/** The point-in-time snapshot of ONE spec the strand predicate decides over. */
export interface SpecStrandSnapshot {
  specId: string;
  /** The persisted `specs.status` column value (the one the classifier reads). */
  status: string;
  /** Every run the spec owns, with status + any percolation marker. */
  runs: StrandRunView[];
  /**
   * True iff ANY of the spec's runs has a non-terminal (`queued`/`merging`)
   * `merge_queue` entry — the spec's PR is queued/settling and must NOT be yanked.
   */
  hasActiveMergeQueueEntry: boolean;
}

/** Why a confirmed strand is reconcilable — surfaced on the dag.spec.unstranded event. */
export type StrandReason = "halted_reexec" | "orphaned_marker" | "no_live_run";

/** The pure verdict: is this spec a confirmed strand, and if so why + which marker to clear. */
export interface StrandDecision {
  /** True iff EVERY one of the five safe conditions holds (a confirmed strand). */
  reconcilable: boolean;
  /** The reason label (only meaningful when `reconcilable`). */
  reason: StrandReason;
  /**
   * The run ids carrying an ORPHANED percolation marker the reconciler must clear
   * (a marker on a terminal run whose re-exec is not live), so it isn't re-detected.
   * Empty when the strand has no marker (a plain no-live-run strand).
   */
  orphanedMarkerRunIds: string[];
  /** The spec's run ids + statuses (for the loud event payload — no secrets). */
  terminalRuns: Array<{ runId: string; status: string }>;
}

/**
 * The PURE strand predicate (no DB, no I/O, no clock). A spec is reconcilable —
 * flip `active → pending` and re-enqueue — ONLY when ALL FIVE hold:
 *
 *   1. The spec OCCUPIES A SLOT: `classifySpecStatus(status) === "in_flight"`
 *      (active/open/in_flight/review) — never done/merged/halted/cancelled/needs_attention.
 *   2. NO LIVE RUN: zero runs in (`queued`,`running`) — the column the classifier ignores.
 *   3. NOT MID-MERGE-QUEUE: no active (`queued`/`merging`) merge_queue entry for any run.
 *   4. NO LIVE PERCOLATION MARKER: no run carries a `percolation_pending` whose
 *      re-exec run is still LIVE. A marker on a TERMINAL run (the strand) is
 *      reconcilable; a marker whose re-exec is LIVE means percolation owns it → leave it.
 *   5. ALL RUNS TERMINAL: every run is terminal (done-not-merged / halted / failed /
 *      cancelled). (Equivalent to condition 2 given the spec has runs, but stated
 *      explicitly so a spec with ZERO runs is NOT treated as a strand — a brand-new
 *      `active` spec mid-creation has no terminal runs yet and must be left alone.)
 *
 * The reason is derived from the marker shape: an orphaned marker on a terminal run
 * ⇒ `halted_reexec` (the canonical §2c cause) or `orphaned_marker`; no marker at all
 * ⇒ `no_live_run`.
 */
export function decideStrand(snapshot: SpecStrandSnapshot): StrandDecision {
  const terminalRuns = snapshot.runs.map((r) => ({ runId: r.runId, status: r.status }));
  const notReconcilable = (): StrandDecision => ({
    reconcilable: false,
    reason: "no_live_run",
    orphanedMarkerRunIds: [],
    terminalRuns,
  });

  // Condition 1: the spec must classify as occupying a slot.
  if (classifySpecStatus(snapshot.status) !== "in_flight") return notReconcilable();

  // Condition 5: a spec with NO runs at all is not a strand (it's mid-creation) —
  // and conditions 2/5 require at least one run, all terminal.
  if (snapshot.runs.length === 0) return notReconcilable();

  // Conditions 2 + 5: NO live run / ALL runs terminal.
  if (snapshot.runs.some((r) => isLiveRunStatus(r.status))) return notReconcilable();

  // Condition 3: not mid-merge-queue.
  if (snapshot.hasActiveMergeQueueEntry) return notReconcilable();

  // Condition 4: no LIVE percolation marker (a marker whose re-exec is still
  // queued/running means percolation owns it → leave it for the percolation pass).
  const liveMarker = snapshot.runs.some((r) => r.percolationPending?.reexecRunLive === true);
  if (liveMarker) return notReconcilable();

  // CONFIRMED STRAND. Collect the orphaned markers to clear (markers on terminal
  // runs whose re-exec is itself terminal/absent) + derive the reason.
  const orphanedMarkerRunIds = snapshot.runs.filter((r) => r.percolationPending !== undefined).map((r) => r.runId);
  const anyRunHalted = snapshot.runs.some((r) => r.status === "halted");
  const reason: StrandReason =
    orphanedMarkerRunIds.length > 0 ? (anyRunHalted ? "halted_reexec" : "orphaned_marker") : "no_live_run";

  return { reconcilable: true, reason, orphanedMarkerRunIds, terminalRuns };
}

/**
 * The read model the reconciler loads each pass: every spec currently OCCUPYING A
 * SLOT (classifies `in_flight`) with its runs + merge-queue + percolation-marker
 * facts, plus the per-spec prior-unstrand-attempt count (the bounded-escalation
 * key). Read fresh + RLS-scoped (DAG state is the source of truth).
 */
export interface SpecStrandReadModel {
  /** Load the project's slot-occupying specs + the facts the predicate needs. */
  loadStrandCandidates(projectId: string): Promise<SpecStrandSnapshot[]>;
  /**
   * How many times the reconciler has already re-enqueued this spec (the count of
   * prior `dag.spec.unstranded` events for it). Drives the bounded escalation: once
   * this EXCEEDS the cap the next reconcile escalates to `needs_attention` instead.
   */
  countPriorUnstrands(input: { projectId: string; specId: string }): Promise<number>;
}

/** The writes the reconciler drives — flip the spec + clear orphaned markers (plane-split safe). */
export interface SpecStrandWriter {
  /**
   * ATOMICALLY flip a confirmed strand `active → pending` (re-enqueue), re-checking
   * the FULL strand invariant INSIDE the same UPDATE (still `active`, no live run, not
   * merge-queued, no live-re-exec marker). Returns whether a row moved: `false` ⇒ a
   * concurrent percolation re-exec reclaimed the spec / created a live run between the
   * reconciler's read and the flip, so the heal is a safe no-op (no double-run) and
   * the reconciler MUST NOT emit / clear the marker.
   */
  reEnqueueSpec(input: { projectId: string; specId: string }): Promise<{ flipped: boolean }>;
  /**
   * ATOMICALLY escalate a bounded-exceeded strand `active → needs_attention` (frees
   * the slot, blocks only dependents) under the SAME atomic strand guard. Returns
   * whether a row moved — `false` when a concurrent re-exec won the race (no-op).
   */
  escalateSpec(input: { projectId: string; specId: string }): Promise<{ flipped: boolean }>;
  /** Clear an orphaned percolation marker on a terminal run so it isn't re-detected. */
  clearOrphanedMarker(input: { projectId: string; runId: string }): Promise<void>;
}

/** The loud, observable events the reconciler emits — every action surfaces one. */
export interface SpecStrandEventEmitter {
  /** A confirmed strand was re-enqueued (`active → pending`). */
  emitUnstranded(input: {
    projectId: string;
    specId: string;
    reason: StrandReason;
    terminalRuns: Array<{ runId: string; status: string }>;
    attempt: number;
  }): Promise<void>;
  /** A strand exceeded the bounded re-enqueue cap and was escalated to needs_attention. */
  emitNeedsAttention(input: {
    projectId: string;
    specId: string;
    reason: StrandReason;
    terminalRuns: Array<{ runId: string; status: string }>;
    attempts: number;
    /** The decision-framed ask (the escalation discipline) — "can't make progress, decide", not an error. */
    message: string;
  }): Promise<void>;
}

/** The reconciler the subscriber composes (mirrors the DagWalker / percolation seams). */
export interface SpecStrandReconcilerContract {
  /** Run one strand-detection + heal/escalate pass over a project's slot-occupying specs. */
  reconcile(projectId: string): Promise<SpecStrandReconcilePassResult>;
}

/** What one reconcile pass produced (for the subscriber + tests). */
export interface SpecStrandReconcilePassResult {
  projectId: string;
  /** Spec ids re-enqueued this pass (confirmed strands under the escalation cap). */
  reEnqueued: string[];
  /** Spec ids escalated to needs_attention this pass (over the bounded cap). */
  escalated: string[];
}
