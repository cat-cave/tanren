// The `MergeCoordinator` seam: Tanren's OWN native intelligent merge queue
// (autonomy-engine.md §2d — the headline P2d capability). Under the
// `native_queue` merge integration, a ready-to-merge run ENTERS this queue
// instead of merging immediately; the coordinator then ORDERS ready runs in DAG
// order (ancestor before dependent, priority within a layer, deterministic
// tiebreak) and SERIALIZES their merges — one at a time — by driving the EXISTING
// per-run merge path (P2a up-to-date/rebase + P2b conflict-resolution + P2c-1
// retarget-to-default_branch → merge). It is NOT a second merge implementation; it
// is a SCHEDULER over the existing merge stage, mirroring how the DagWalker is a
// scheduler over the existing run executor.
//
// The queue logic here is PURE Tanren (DAG-order + priority + tiebreak) — only the
// VCS/CI calls inside the per-run merge path go through the `VcsProvider`, so the
// coordinator is provider-agnostic (§1.1: the pluggable seam is the VcsProvider,
// NOT the queue).
//
// This contract carries the SEAMS (queue model + per-run merge runner) and the
// PURE selection core (`selectNextMerge`), so the ordering decision is conformance-
// tested independent of any database or VCS. The pg-backed queue model + the
// mergeForRun-driven runner + the LISTEN/NOTIFY subscriber live in
// `engine/merge/coordinator.ts` + `engine/merge/coordinatorPg.ts`.

import { priorityRank, type SpecPriority } from "../state/spec.js";

// ---- Queue snapshot (the ordering input) ----------------------------------

/** The outcome of driving one entry's merge through the per-run merge path. */
export type MergeDriveOutcome =
  // The merge landed on `default_branch` (terminal-success for the entry).
  | { kind: "merged"; mergeSha?: string }
  // A real conflict (or a held/blocked posture/speculative state) — recoverable:
  // the entry leaves the head so independent items proceed, and is re-queued when
  // the next signal clears it. `reason` distinguishes conflict from a posture/
  // speculative block for the merge.dequeued event + the liveness story.
  | { kind: "conflict"; message: string }
  | { kind: "blocked"; message: string }
  // The merge failed terminally — the entry is removed (NOT re-queued).
  | { kind: "failed"; message: string };

/**
 * One ready-to-merge run in the native queue, as the coordinator orders it. DAG
 * state is the source of truth (§1.7): `dependsOn` + `priority` + `orderKey` are
 * read fresh each pass from `specs`/`merge_queue`, never cached. `dependencyMerged`
 * says whether EACH dependency has GENUINELY merged (spec done/merged) — the
 * ordering invariant the coordinator enforces (a dependent is never selected while
 * any ancestor is unmerged, so a dependent never merges before its ancestors).
 */
export interface MergeQueueEntry {
  queueId: string;
  runId: string;
  specId: string;
  prUrl: string;
  prNumber: number;
  /** The spec ids this entry's spec depends on (its `depends_on` edges). */
  dependsOn: string[];
  /** The execution priority (P1b) — the ordering key WITHIN a DAG layer. */
  priority: SpecPriority;
  /** Stable creation-order tiebreak (lower sorts first) AFTER priority. */
  orderKey: number;
}

/**
 * A point-in-time snapshot of a project's native merge queue + the DAG facts the
 * coordinator needs to order it, loaded under RLS. `mergedSpecIds` is the set of
 * specs that have GENUINELY merged (status done/merged) — used to test whether an
 * entry's ancestors are satisfied. `mergingInFlight` is whether ANOTHER entry is
 * already claimed (`status = 'merging'`) — the SERIALIZATION signal (at most one
 * merge in flight per project).
 */
export interface MergeQueueSnapshot {
  projectId: string;
  /** The QUEUED (not-yet-merged, not-yet-claimed) entries — the ready candidates. */
  entries: MergeQueueEntry[];
  /** Spec ids that have genuinely merged (done/merged) — satisfied ancestors. */
  mergedSpecIds: Set<string>;
  /** True when another entry is already `merging` (serialization: hold this pass). */
  mergingInFlight: boolean;
}

// ---- The pure selection core ----------------------------------------------

/**
 * The selection decision: either pick exactly ONE entry to merge this pass (the
 * DAG-ordered, all-ancestors-merged head), or hold (nothing mergeable / a merge is
 * already in flight). `blockedByDependency` carries the entries that ARE ready by
 * priority but whose ancestors are still unmerged — surfaced for visibility +
 * liveness (they are not dead, just waiting on their chain).
 */
export interface MergeSelection {
  /** The single entry to merge this pass, or undefined to hold. */
  next?: MergeQueueEntry;
  /** Why nothing was selected (only set when `next` is undefined). */
  holdReason?: "serialized" | "empty" | "all_blocked";
  /** Entries skipped because an ancestor is still unmerged (DAG-order liveness). */
  blockedByDependency: MergeQueueEntry[];
}

/**
 * The PURE selection core (no DB, no I/O): given a queue snapshot, choose the next
 * single entry to merge. This is the behavior the conformance suite pins.
 *
 * Rules:
 *   1. SERIALIZE — if another entry is already `merging`, select NOTHING this pass
 *      (one merge at a time). The in-flight merge's completion re-triggers the
 *      coordinator, which then picks the next.
 *   2. DAG ORDER — an entry is ELIGIBLE only when EVERY id in its `dependsOn` has
 *      genuinely merged (in `mergedSpecIds`) OR is not itself a queued entry's spec
 *      (an external/already-handled dependency). An entry with an ancestor that is
 *      STILL QUEUED is held (it would merge a dependent before its ancestor) and
 *      surfaced in `blockedByDependency`. This is the invariant that makes P2c-1's
 *      ordered merge real: A merges, THEN B, THEN C — never a dependent first.
 *   3. PRIORITY + TIEBREAK — among eligible entries, pick the one that sorts first
 *      by priority (P0 → tbd), then `orderKey`, then `specId` (total determinism).
 *
 * LIVENESS: a non-eligible head (ancestor still queued) does NOT block eligible
 * later entries — we scan ALL eligible entries and pick the best, so an independent
 * item merges even when some chain is mid-flight. A failed/blocked merge dequeues
 * the entry (it leaves the queue), so it never deadlocks the head.
 */
export function selectNextMerge(snapshot: MergeQueueSnapshot): MergeSelection {
  if (snapshot.mergingInFlight) {
    return { holdReason: "serialized", blockedByDependency: [] };
  }
  if (snapshot.entries.length === 0) {
    return { holdReason: "empty", blockedByDependency: [] };
  }

  // The set of specs that have a STILL-QUEUED entry — an ancestor in this set is
  // not yet merged, so a dependent on it must wait (DAG order).
  const queuedSpecIds = new Set(snapshot.entries.map((e) => e.specId));

  const eligible: MergeQueueEntry[] = [];
  const blockedByDependency: MergeQueueEntry[] = [];
  for (const entry of snapshot.entries) {
    if (isEligible(entry, snapshot.mergedSpecIds, queuedSpecIds)) {
      eligible.push(entry);
    } else {
      blockedByDependency.push(entry);
    }
  }

  if (eligible.length === 0) {
    return { holdReason: "all_blocked", blockedByDependency };
  }

  const next = [...eligible].sort(compareEntries)[0];
  return { next, blockedByDependency };
}

/**
 * An entry is eligible to merge iff every dependency has genuinely merged. A
 * dependency that is STILL QUEUED (has a queued entry) blocks it — a dependent
 * never merges before its ancestor. A dependency that is neither merged nor queued
 * is treated as satisfied: it is outside the queue's concern (already merged
 * earlier, never queued, or handled by another path) — the queue only serializes
 * the runs it actually holds, and the merge stage's own speculative-hold gate is
 * the backstop that no unmerged ancestor code reaches `main`.
 */
function isEligible(entry: MergeQueueEntry, mergedSpecIds: Set<string>, queuedSpecIds: Set<string>): boolean {
  return entry.dependsOn.every((depId) => mergedSpecIds.has(depId) || !queuedSpecIds.has(depId));
}

/** DAG layer is enforced by eligibility; within it, priority then a stable tiebreak. */
function compareEntries(a: MergeQueueEntry, b: MergeQueueEntry): number {
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;
  if (a.orderKey !== b.orderKey) return a.orderKey - b.orderKey;
  return a.specId < b.specId ? -1 : a.specId > b.specId ? 1 : 0;
}

// ---- Seams ----------------------------------------------------------------

/**
 * The persisted, RLS-scoped native-queue model. DAG state is the source of truth,
 * so this holds ONLY queue membership + the serialization claim — ordering is
 * DERIVED in `selectNextMerge` from the snapshot. Every method org-scopes under
 * RLS; an off-scope call sees zero rows. The queue SURVIVES A RESTART: a crash
 * mid-merge leaves a `merging` row that `recoverStaleClaims` returns to `queued`.
 */
export interface MergeQueueModel {
  /**
   * Add a ready-to-merge run to the queue (IDEMPOTENT): if the run already has an
   * active (queued/merging) entry, this is a no-op returning the existing entry.
   * Returns the entry + whether it was newly created (so the caller emits
   * merge.queued only once).
   */
  enqueue(input: {
    projectId: string;
    runId: string;
    specId: string;
    prUrl: string;
    prNumber: number;
  }): Promise<{ queueId: string; created: boolean }>;

  /** Load the project's queue snapshot + the DAG facts to order it, under RLS. */
  loadSnapshot(projectId: string): Promise<MergeQueueSnapshot>;

  /**
   * ATOMICALLY claim an entry for merging (queued → merging) — the SERIALIZATION
   * lock. Returns true iff THIS call won the claim (a concurrent coordinator pass
   * loses), so two passes never drive the same merge or two merges at once.
   */
  claim(queueId: string): Promise<boolean>;

  /** Mark a claimed entry as terminally MERGED (merging → merged). */
  markMerged(queueId: string): Promise<void>;

  /**
   * Mark an entry as DEQUEUED (left the queue without merging) with the reason —
   * `conflict`/`blocked` are recoverable (a re-ready run re-enqueues a new entry);
   * `failed` is terminal. The entry is removed from the ready set either way, so a
   * blocked head never deadlocks independent later items (liveness).
   */
  markDequeued(queueId: string, reason: "conflict" | "blocked" | "failed"): Promise<void>;

  /**
   * Crash recovery: return any entries left `merging` (a coordinator died
   * mid-merge) back to `queued` so the queue is recoverable on restart. Returns the
   * count recovered. Idempotent (no stale claims ⇒ 0). The actual GitHub merge is
   * itself idempotent (a re-driven already-merged PR is a no-op), so re-queuing is
   * safe.
   */
  recoverStaleClaims(projectId: string): Promise<number>;
}

/**
 * Drives ONE queued run's merge through the EXISTING per-run merge path (NOT a
 * second merge impl). Production wires this to `mergeForRun` in its `native_queue`
 * DRIVE mode — which runs the SAME directMerge logic (P2a up-to-date/rebase + P2b
 * conflict-resolution + P2c-1 retarget). Tests inject a fake. Returns the drive
 * outcome the coordinator maps to a queue-state transition + event.
 */
export interface MergeRunner {
  driveMerge(input: { runId: string; projectId: string }): Promise<MergeDriveOutcome>;
}

/**
 * The per-project native MergeCoordinator. `coordinate(projectId)` performs one
 * full pass: recover stale claims → load the queue snapshot → select the single
 * DAG-ordered head (or hold) → claim it → drive its merge → record the outcome +
 * emit the queue events. The subscriber calls it on startup and on every relevant
 * notification (a run finishing, a merge completing) for the project. `coordinate`
 * is the unit of work the conformance suite drives.
 */
export interface MergeCoordinator {
  coordinate(projectId: string): Promise<CoordinateResult>;
}

/** What one coordinate pass produced — surfaced for the subscriber + tests. */
export interface CoordinateResult {
  projectId: string;
  /** The entry merged this pass (its spec id), if any. */
  mergedSpecId?: string;
  /** The entry dequeued this pass (conflict/blocked/failed), if any. */
  dequeuedSpecId?: string;
  /** Why the pass selected nothing (serialized / empty / all_blocked), if it held. */
  holdReason?: "serialized" | "empty" | "all_blocked";
  /** The queue depth (ready entries) observed this pass — queue statistics. */
  queueDepth: number;
}
