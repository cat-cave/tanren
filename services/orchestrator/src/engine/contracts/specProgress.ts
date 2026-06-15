// The ONE spec-lifecycle "progressing vs blocked vs orphaned vs re-driving"
// classification, shared by the orphan-slot RECONCILER (the worker-level
// force-halt safety net, `engine/worker/runFinalize.ts`) and the whole-build
// DEADLOCK DETECTOR (`engine/templates/creation/liveBuildDriver.ts`). Both reason
// over the SAME DAG, so they MUST agree on what "can still make forward progress"
// means — a spec the driver counts as progressing must not be a spec the
// reconciler strands, and a deadlock the driver halts on must be a genuine one.
//
// This is a PURE core (no DB / I/O / clock): it derives, from a `DagSnapshot`
// (specs + `dependsOn` edges + the walker-normalized `phase`), the classification
// the autonomy-engine.md walker/reconciler/run-lifecycle sections describe. The
// pg-backed callers feed it a fresh snapshot each tick.
//
// The vocabulary (apex v35 — the entangled walker-lifecycle cluster):
//
//   • DONE          — `phase === "done"` (merged): a satisfied dependency.
//   • IN-FLIGHT     — `phase === "in_flight"` (occupying a slot): a live/queued
//                     run, INCLUDING a freshly re-enqueued (queued/not-yet-live)
//                     one. The re-drive transition (#579: release old run →
//                     enqueue new run) lands the spec back at `in_flight`, so a
//                     just-re-driven spec is in-flight, NOT orphaned.
//   • RE-DRIVING    — a `pending` spec that returned to `open` after a re-drive
//                     (the snapshot normalizes `open`→`pending`). It IS progressing
//                     iff it is not transitively blocked — the walker will re-pick
//                     it on a later tick.
//   • TERMINAL      — `phase === "terminal_blocked"` (halted/cancelled/
//                     needs_attention): a genuine structural halt for THAT spec.
//   • TRANSITIVELY-BLOCKED — a `pending` spec with at least one TERMINAL ancestor
//                     (directly or through a chain of pending ancestors): it can
//                     NEVER run, so it is NOT progressing even though it is pending.
//   • PROGRESSING   — in-flight, OR pending-and-not-transitively-blocked. Forward
//                     progress is still possible (a run can still land), so the
//                     build keeps polling and the reconciler must not strand it.

import type { DagSnapshot, DagSpecNode } from "./dagWalker.js";

/** The progress class a spec occupies, from the shared lifecycle vantage point. */
export type SpecProgressClass =
  // Merged — a satisfied dependency.
  | "done"
  // Occupying a slot with a live OR freshly-queued run (the re-drive lands here).
  | "in_flight"
  // Pending and able to still run (a root, or all ancestors done/in-flight/also-runnable).
  | "runnable_pending"
  // Pending but with a terminal ancestor (transitively): can never run.
  | "transitively_blocked"
  // Terminal for this spec (halted / cancelled / needs_attention).
  | "terminal";

/**
 * Classify EVERY spec in the snapshot into the shared progress vocabulary. The
 * transitive-block computation walks each pending spec's ancestors (memoized) and
 * marks it `transitively_blocked` iff any ancestor (through a chain of pending
 * ancestors) is `terminal`. A pending spec is `runnable_pending` otherwise — it
 * can still run once its in-flight/pending ancestors land.
 *
 * Cycle-safe: a dependency cycle among pending specs is treated as NOT terminal
 * (a cycle is its own readiness problem the walker already handles, never a reason
 * to mis-strand here); only a real path to a TERMINAL ancestor blocks.
 */
export function classifySpecProgress(snapshot: DagSnapshot): Map<string, SpecProgressClass> {
  const byId = new Map<string, DagSpecNode>();
  for (const node of snapshot.nodes) byId.set(node.specId, node);

  // Memoized "does this spec have a terminal ancestor (transitively, through
  // pending links)?" The `visiting` set breaks cycles (a cycle contributes no
  // terminal path of its own).
  const transitivelyTerminal = new Map<string, boolean>();
  const visiting = new Set<string>();

  const hasTerminalAncestor = (specId: string): boolean => {
    const cached = transitivelyTerminal.get(specId);
    if (cached !== undefined) return cached;
    // Cycle guard — a cycle contributes no terminal path of its own.
    if (visiting.has(specId)) return false;
    const node = byId.get(specId);
    // A missing edge is a readiness problem (the walker holds it), not a terminal block.
    if (node === undefined) return false;
    visiting.add(specId);
    let blocked = false;
    for (const depId of node.dependsOn) {
      const dep = byId.get(depId);
      // A missing dependency is held by readiness, not terminal here.
      if (dep === undefined) continue;
      if (dep.phase === "terminal_blocked") {
        blocked = true;
        break;
      }
      // A terminal block PROPAGATES only through still-pending ancestors. A `done`
      // ancestor is satisfied; an `in_flight` ancestor is still live (it may merge),
      // so neither carries a block downward. Only a pending ancestor that is ITSELF
      // transitively blocked taints its dependents.
      if (dep.phase === "pending" && hasTerminalAncestor(depId)) {
        blocked = true;
        break;
      }
    }
    visiting.delete(specId);
    transitivelyTerminal.set(specId, blocked);
    return blocked;
  };

  const result = new Map<string, SpecProgressClass>();
  for (const node of snapshot.nodes) {
    switch (node.phase) {
      case "done":
        result.set(node.specId, "done");
        break;
      case "in_flight":
        result.set(node.specId, "in_flight");
        break;
      case "terminal_blocked":
        result.set(node.specId, "terminal");
        break;
      case "pending":
        result.set(node.specId, hasTerminalAncestor(node.specId) ? "transitively_blocked" : "runnable_pending");
        break;
    }
  }
  return result;
}

/** The aggregate progress tally the build's deadlock detector reasons over. */
export interface BuildProgressTally {
  total: number;
  done: number;
  /** In-flight OR runnable-pending — forward progress is still possible. */
  progressing: number;
  /** Genuinely terminal specs (halted / cancelled / needs_attention). */
  terminalSpecIds: string[];
  /** Pending specs that can NEVER run because a terminal ancestor blocks them. */
  transitivelyBlockedSpecIds: string[];
}

/**
 * Tally a snapshot into the build-level progress figures the deadlock detector
 * uses. `progressing` counts ONLY specs that can still make forward progress
 * (in-flight or runnable-pending) — a transitively-blocked pending spec is NOT
 * progressing (it can never run), closing the false-"progressing" hang.
 */
export function tallyBuildProgress(snapshot: DagSnapshot): BuildProgressTally {
  const classes = classifySpecProgress(snapshot);
  let done = 0;
  let progressing = 0;
  const terminalSpecIds: string[] = [];
  const transitivelyBlockedSpecIds: string[] = [];
  for (const node of snapshot.nodes) {
    switch (classes.get(node.specId)) {
      case "done":
        done += 1;
        break;
      case "in_flight":
      case "runnable_pending":
        progressing += 1;
        break;
      case "terminal":
        terminalSpecIds.push(node.specId);
        break;
      case "transitively_blocked":
        transitivelyBlockedSpecIds.push(node.specId);
        break;
    }
  }
  return {
    total: snapshot.nodes.length,
    done,
    progressing,
    terminalSpecIds,
    transitivelyBlockedSpecIds,
  };
}

/**
 * The build CONVERGED — every spec merged (and at least one spec exists).
 * (Convergence and deadlock are mutually exclusive: convergence ⇒ no non-done spec.)
 */
export function isConverged(tally: BuildProgressTally): boolean {
  return tally.total > 0 && tally.done === tally.total;
}

/**
 * The build is in a GENUINE structural deadlock — no spec can EVER make forward
 * progress (zero in-flight, zero runnable-pending) yet it has not converged. This
 * is true exactly when the remaining specs are {terminal ∪ transitively-blocked}.
 * The build must HALT LOUD here (surfacing the terminal specs as the human-decision
 * blockers), NOT hang. While ANY spec is still progressing (in-flight / runnable),
 * this is false and the build keeps polling indefinitely (no wall-clock).
 */
export function isDeadlocked(tally: BuildProgressTally): boolean {
  return !isConverged(tally) && tally.progressing === 0 && tally.total > 0;
}
