// The `BatchMergeCoordinator` seam (autonomy-engine.md §2d — speculative batch-check
// + bisect, the intelligence layer ON TOP OF the native merge queue). The native
// queue merges queued runs ONE AT A TIME in DAG order — correct, but it
// can only catch a bad *interaction* (two PRs that each pass alone but break together)
// AFTER a merge, and a single bad head stalls everyone behind it — this layer:
//
//   1. FORMS A BATCH — the DAG-ordered, mutually-eligible prefix of the queue (reuse
//      the queue's eligibility + ordering: `isEligible` + `compareEntries`), capped
//      by a config knob (never silently truncated — a cap is LOGGED).
//   2. BATCH-CHECKS the PROSPECTIVE MERGED STATE — `default_branch + batch PRs`
//      integrated in DAG order over the jj-local integration node, then runs the
//      native CI/gate against that assembled state. It is a SPECULATIVE check — it
//      NEVER touches `default_branch`.
//   3. On PASS — the batch is validated as a combined unit → the coordinator drives
//      its entries' real merges in DAG order through the native queue's drive path (no
//      re-surprises). Serialization + the native queue's ordering/lease guarantees still hold
//      for the ACTUAL merges (the batch check is purely speculative).
//   4. On FAIL — BISECT (the headline capability): binary-search the ordered batch to
//      isolate the SINGLE PR whose inclusion breaks the check, REMOVE it (dequeue it to
//      a RECOVERABLE outcome — routed to the re-execution path, never dropped), and
//      RE-FORM + RE-CHECK the batch WITHOUT the culprit so the innocent PRs still merge.
//
// This module carries the PURE selection/bisect core (no DB, no VCS) + the SEAMS (the
// batch checker + the native queue's merge model/runner), so the batch-formation rule and
// the bisect algorithm are conformance-tested independent of any database or forge.

import { DEFAULT_MAX_BATCH_SIZE } from "../config/shared.js";
import type { GateReworkRouteResult } from "./conflictResolution.js";
import { compareEntries, type MergeQueueEntry, type MergeQueueSnapshot } from "./mergeCoordinator.js";

// Re-export the config default so call sites that already import the batch contract
// (the coordinator) get the knob from one place; the schema default lives in
// config/shared.ts (the single source of truth for config defaults).
export { DEFAULT_MAX_BATCH_SIZE };

// ---- Pure batch formation -------------------------------------------------

/** The outcome of forming a batch from a queue snapshot. */
export interface BatchFormation {
  /**
   * The DAG-ordered, mutually-eligible batch (a prefix of the priority-ordered
   * eligible set). Every entry's ancestors are merged-or-earlier-in-this-batch, so
   * the batch can be speculatively integrated in this exact order without a phantom
   * ancestor. Empty when nothing is eligible.
   */
  batch: MergeQueueEntry[];
  /** True when more entries were eligible than the cap allowed (caller LOGS it). */
  capped: boolean;
  /** The total eligible count BEFORE the cap (for the cap log + queue stats). */
  eligibleCount: number;
}

/**
 * Form the batch to speculatively integrate + check this pass (PURE — no I/O). The
 * batch is the DAG-ordered, MUTUALLY-ELIGIBLE prefix of the queue, capped at
 * `maxBatchSize`:
 *
 *   - SERIALIZATION — if a merge is already in flight (`mergingInFlight`), return an
 *     EMPTY batch (the native queue's one-at-a-time lock dominates; the in-flight merge's
 *     completion re-triggers the pass).
 *   - ELIGIBILITY — reuse the native queue's strict dependency rule against the
 *     snapshot's `mergedSpecIds` AND the batch's own already-included specs (so an
 *     entry whose ancestor is NOT merged but IS earlier in this batch is still
 *     eligible — the batch's ancestor will merge first). An entry whose ancestor is
 *     neither merged nor earlier-in-batch is HELD (never include a dependent whose
 *     ancestor isn't in the batch-or-already-merged).
 *   - ORDER — sort the eligible set by the native queue's `compareEntries` (priority then a
 *     stable tiebreak), then greedily take entries in that order while their ancestors
 *     are merged-or-already-taken. This yields a prefix whose merge order == the order
 *     the one-at-a-time path would have used.
 *   - CAP — take at most `maxBatchSize`; set `capped` when more were eligible so the
 *     caller logs it (no silent truncation). The dropped entries keep their queue
 *     position and are re-considered next pass.
 *
 * TERMINATION/SAFETY: the batch never includes a dependent ahead of an ancestor that
 * is not merged-or-in-the-batch, so the speculative integration order is always valid.
 */
export function formBatch(snapshot: MergeQueueSnapshot, maxBatchSize: number): BatchFormation {
  if (maxBatchSize < 1) {
    throw new Error(`maxBatchSize must be a positive integer, got ${maxBatchSize}`);
  }
  if (snapshot.mergingInFlight || snapshot.entries.length === 0) {
    return { batch: [], capped: false, eligibleCount: 0 };
  }

  // Greedy fixed point over the priority-ordered queue: an entry joins the batch once
  // every ancestor it depends on is merged OR already in the batch. We loop until no
  // more entries become eligible, so a chain A→B→C all enters one batch in order.
  const ordered = [...snapshot.entries].sort(compareEntries);
  const batchSpecIds = new Set<string>();
  const batch: MergeQueueEntry[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const entry of ordered) {
      if (batchSpecIds.has(entry.specId)) continue;
      // Eligible iff every dep is merged OR already taken into THIS batch (its
      // ancestor will merge first within the batch).
      const ready = entry.dependsOn.every((depId) => snapshot.mergedSpecIds.has(depId) || batchSpecIds.has(depId));
      if (!ready) continue;
      batch.push(entry);
      batchSpecIds.add(entry.specId);
      added = true;
    }
  }

  // `batch` is now in greedy-discovery order. Re-sort it into a strict DAG +
  // priority order so the speculative integration + the real merges run in the
  // canonical one-at-a-time order (ancestors first). A topological sort by
  // dependency-closure-within-batch, breaking ties by `compareEntries`.
  const dagOrdered = orderBatchTopologically(batch, batchSpecIds);

  const eligibleCount = dagOrdered.length;
  const capped = eligibleCount > maxBatchSize;
  return { batch: dagOrdered.slice(0, maxBatchSize), capped, eligibleCount };
}

/**
 * Order the formed batch so every entry comes AFTER every batch-internal ancestor it
 * depends on, breaking ties by the native queue's `compareEntries` (priority + stable
 * tiebreak). A stable topological sort over the batch's internal dependency edges;
 * the batch is acyclic (DAG), so it always terminates. After this, slicing to the cap
 * yields a valid PREFIX — capping never strands a dependent ahead of its ancestor,
 * because an ancestor always sorts before its dependent.
 */
function orderBatchTopologically(batch: MergeQueueEntry[], batchSpecIds: Set<string>): MergeQueueEntry[] {
  const remaining = [...batch].sort(compareEntries);
  const placedSpecIds = new Set<string>();
  const result: MergeQueueEntry[] = [];
  while (remaining.length > 0) {
    // The first entry (in priority order) all of whose in-batch ancestors are placed.
    const idx = remaining.findIndex((entry) =>
      entry.dependsOn.every((depId) => !batchSpecIds.has(depId) || placedSpecIds.has(depId)),
    );
    // `idx` is always >= 0 for a DAG: at least one un-placed entry has all its
    // in-batch ancestors placed (otherwise there is a cycle, impossible in the DAG).
    const pick = Math.max(idx, 0);
    const [entry] = remaining.splice(pick, 1);
    if (entry === undefined) break;
    result.push(entry);
    placedSpecIds.add(entry.specId);
  }
  return result;
}

// ---- Pure bisect core -----------------------------------------------------

/**
 * The result of bisecting a failed batch. `culpritIndex` is the position (in the
 * batch's DAG order) of the SINGLE PR whose inclusion flips the check from pass to
 * fail — the offending PR. `innocentPrefix` is the batch entries BEFORE the culprit
 * (they pass together WITHOUT it, so they are provably innocent and may proceed).
 * `checks` is the count of sub-batch checks the bisect performed (bounded by
 * `O(log n)` — surfaced for the termination assertion + cost stats).
 */
export interface BisectResult {
  culpritIndex: number;
  culprit: MergeQueueEntry;
  innocentPrefix: MergeQueueEntry[];
  checks: number;
}

/**
 * Bisect a failed batch to isolate the SINGLE offending PR (PURE driver — the only
 * I/O is the injected `checkPrefix`). Binary search over the DAG-ordered batch:
 *
 *   - INVARIANT: the empty prefix PASSES (just `default_branch` — the batch is only
 *     formed from individually-ready entries, so the base is green) and the FULL batch
 *     FAILS (this is only called after a failed batch check). We binary-search the
 *     boundary `k` where `prefix[0..k-1]` PASSES but `prefix[0..k]` FAILS — index `k`
 *     is the culprit: adding exactly that PR is what breaks the check.
 *   - `checkPrefix(n)` runs the speculative integration + CI for the FIRST `n` batch
 *     entries (`n = 0` ⇒ base only). The driver maintains `lo` (a known-PASSING prefix
 *     length, starts 0) and `hi` (a known-FAILING prefix length, starts `batch.length`)
 *     and narrows `lo`/`hi` until `hi == lo + 1`. Then `batch[lo]` is the culprit.
 *
 * WHY IT CANNOT BLAME AN INNOCENT: the culprit `batch[lo]` is, by the maintained
 * invariant, a PR such that the prefix WITHOUT it (`prefix[0..lo]`, length `lo`)
 * PASSES and the prefix WITH it (length `lo+1`) FAILS — i.e. a sub-batch passes
 * without it and fails with it. That is the definition of "the offending PR"; no PR
 * the check tolerates is ever named.
 *
 * WHY IT TERMINATES: each step strictly shrinks the suspect window `[lo, hi]` (we
 * always probe a `mid` strictly between `lo` and `hi` and move one bound to it), so
 * `hi - lo` halves each step and the loop runs at most `ceil(log2(batch.length)) + 1`
 * times — it cannot loop forever.
 */
export async function bisectCulprit(
  batch: ReadonlyArray<MergeQueueEntry>,
  checkPrefix: (prefixLength: number) => Promise<"pass" | "fail">,
): Promise<BisectResult> {
  if (batch.length === 0) {
    throw new Error("bisectCulprit called on an empty batch (nothing to bisect)");
  }
  // `lo` = a prefix length known to PASS (the empty prefix = base only). `hi` = a
  // prefix length known to FAIL (the full batch — the failed check that triggered the
  // bisect). The culprit is at index `lo` once `hi == lo + 1`.
  let lo = 0;
  let hi = batch.length;
  let checks = 0;
  while (hi - lo > 1) {
    // `mid` is strictly between `lo` and `hi`, so the window always shrinks.
    const mid = lo + Math.floor((hi - lo) / 2);
    checks += 1;
    const verdict = await checkPrefix(mid);
    if (verdict === "pass") {
      // prefix[0..mid-1] passes ⇒ the culprit is at or after `mid`.
      lo = mid;
    } else {
      // prefix[0..mid-1] fails ⇒ the culprit is before `mid`.
      hi = mid;
    }
  }
  const culprit = batch[lo];
  if (culprit === undefined) {
    throw new Error(`bisect produced an out-of-range culprit index ${lo} for batch of ${batch.length}`);
  }
  return { culpritIndex: lo, culprit, innocentPrefix: batch.slice(0, lo), checks };
}

// ---- The batch-gate rework router (the integrated-tree gate-fail self-heal) ----

/**
 * Routes a GATE-FAIL batch-check culprit back to the WRITER for rework (v35 — the
 * batch-gate-fail-strand fix). When the batch check's GATE/CI fails on the PROSPECTIVE
 * MERGED state and the bisect isolates ONE culprit PR, that culprit authored work that
 * passed its OWN per-iteration + pre-merge branch gates but breaks ONLY when integrated
 * (e.g. a config file not covered by the integrated tsconfig). Dequeuing it without
 * re-work STRANDS the spec — it can never fix an integration-only failure it cannot see,
 * and the build can never converge (downstream specs cascade-block on it).
 *
 * This seam re-authors the culprit on the SAME never-discard re-plan-with-steering
 * mechanism a conflict-replan uses, but carrying the BATCH GATE'S failing tier/step/
 * output as steering so the writer fixes the RIGHT thing (no_silent_fallback — never
 * rework blind). It is DISTINCT from {@link ReplanRouter}: a batch CONFLICT (spec-vs-spec
 * or spec-vs-base) still routes to the conflict resolver / replan; a batch GATE-FAIL
 * routes HERE to writer rework. A culprit is handled by exactly ONE of the two.
 *
 * BOUNDED: a spec re-worked the cap number of times for the SAME batch-gate failure that
 * STILL fails the integrated gate is genuinely stuck — the impl ESCALATES it as a loud
 * `needs_attention` (persistent_failure) instead of re-working forever (never a strand,
 * never a hot-loop).
 */
export interface BatchGateReworkRouter {
  /**
   * Re-author the culprit spec to fix the integrated-tree GATE failure, carrying the
   * batch gate's failing tier/step/output as steering. Returns the disposition so the
   * coordinator settles the OLD queue entry correctly. `owned` carries proof of the
   * fresh/already-running writer rework; `parked` proves the router already moved the
   * spec to `needs_attention`. The caller must derive the dequeue reason from this receipt.
   */
  routeGateFailToRework(input: {
    projectId: string;
    /** The culprit entry bisect isolated (carries the run/spec/PR handles). */
    culprit: MergeQueueEntry;
    /** The batch gate's failure detail (tier/step/output) — the steering the writer fixes against. */
    gateError: string;
  }): Promise<GateReworkRouteResult>;
}

// ---- Seams ----------------------------------------------------------------

/** The outcome of speculatively integrating + CI-checking a set of entries. */
export type BatchCheckVerdict =
  // The prospective merged state (default_branch + the entries, merged in order)
  // integrated cleanly AND its CI/gate is green — safe to merge as a unit.
  | { result: "pass"; integrationBranch: string }
  // The prospective merged state's CI/gate FAILED (a bad interaction) — do NOT merge.
  | { result: "fail"; message: string }
  // The speculative INTEGRATION itself conflicted — `conflictBetween` names the pair.
  //   - `conflictsWithBase: false` (a SPEC-vs-SPEC conflict — two queued entries conflict
  //     with each other) is treated like a fail for bisect: the offending entry is
  //     isolated + dequeued recoverably the same way.
  //   - `conflictsWithBase: true` (`conflictBetween.otherSpecId` is the project's BASE
  //     branch — a single PR dirty against `default_branch`, no other spec involved) is
  //     NOT a batch interaction at all: the coordinator drives the culprit through the
  //     SAME real per-run merge path that already resolves a dirty PR (rebase onto base →
  //     intent-preserving resolver → re-gate → re-push), NEVER bisecting/dequeuing it.
  | {
      result: "conflict";
      message: string;
      conflictsWithBase: boolean;
      conflictBetween?: { specId: string; otherSpecId: string };
    }
  // The prospective merged state's CI is still RUNNING (not yet terminal) — NOT a
  // failure. The coordinator HOLDS this pass (it does NOT bisect a green-but-pending
  // batch, which would falsely blame a PR); the next CI-completion notification
  // re-triggers a fresh pass. `settleAfterMs` is set ONLY for the no-checks settle
  // path (a genuinely-zero-checks repo whose grace window has not yet elapsed): it is
  // the exact remaining ms until the no-checks grace expires, so the coordinator can
  // arm a PRECISE wake-up (Bug B) rather than depending on an external NOTIFY. It is
  // ABSENT for a real `checks_pending` hold (waiting on REGISTERED CI — no settle
  // applies; a CI-completion NOTIFY clears it).
  | { result: "pending"; message: string; settleAfterMs?: number }
  // The check could not be RUN / SET UP at all — a transport/ref/transient INFRA error
  // (e.g. the speculative integration ref reset threw a transient HTTP 422). This is
  // DISTINCT from `fail` (a genuine CI failure), `conflict` (a genuine merge conflict),
  // and `pending` (CI still running): we never even got a verdict for the batch. The
  // coordinator must NEVER treat this as a PR's check-failure — it does NOT bisect and
  // NEVER dequeues/blames a PR. Instead it bounded-retries the SAME batch and, on
  // exhaustion, emits a LOUD `merge.batch.infra_blocked` event + HOLDS (entries stay
  // queued). `retriable` is `false` only for a typed PERMANENT infra error (so the
  // coordinator still holds-not-dequeues, but does not burn its retry budget first).
  | { result: "infra-error"; message: string; retriable: boolean; kind?: "missing_required_credential" };

/**
 * Speculatively integrate the given entries (in the supplied DAG order) onto
 * `default_branch` and run the CI/gate against the prospective merged tree. The
 * production impl assembles the prospective merged state over the jj-local
 * integration node, then runs the native gate over it (proof-reuse where a recorded
 * passing proof matches). It NEVER touches `default_branch`.
 * An empty entry list checks the BASE (`default_branch`) alone — which passes (the
 * base is green) — so the bisect's `checkPrefix(0)` invariant holds without a special
 * case. Tests inject a fake that scripts which entry-sets pass/fail (modelling a
 * bad-interaction PR).
 */
export interface BatchChecker {
  checkBatch(input: { projectId: string; entries: ReadonlyArray<MergeQueueEntry> }): Promise<BatchCheckVerdict>;
}
