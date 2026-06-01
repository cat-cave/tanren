// The `DagWalker` seam: the per-project background scheduler that turns the spec
// DAG into self-driving execution (autonomy-engine.md §1a — the keystone). It is
// a SCHEDULER over the EXISTING run executor, mirroring how the BenchmarkRunner
// schedules trials — NOT a second executor. On startup and on every
// run.*-terminal / merge.completed notification for a project, the walker:
//
//   1. Loads the project's spec DAG (specs + dependsOn edges + status) under RLS
//      — DAG state is the source of truth, never in-memory.
//   2. Computes the READY SET: pending specs whose dependencies are all DONE
//      (the same predicate the manual-trigger path enforces via
//      ensureSpecDependenciesDone). Speculative readiness (§2c) is Phase 2;
//      Phase-1 readiness = all deps merged/done.
//   3. Orders the ready set deterministically (priority comes in P1b; here a
//      stable creation-order tiebreak, with a clean seam for priority ordering).
//   4. Enqueues up to the GOVERNED CONCURRENCY HEADROOM (the config ceiling from
//      P1·0, never an env var) of ready specs via createQueuedRunFromSpec — the
//      SAME parallel worker runs them.
//
// Idempotent: a spec already in-flight (active / building / pr_open / running) is
// never re-enqueued; it stops when the DAG is drained, budget is exhausted, or it
// is blocked on human input. Milestones are LABELS, never gates — the walker
// never pauses at a milestone boundary.
//
// This contract carries the SEAMS (read model + enqueuer) and the PURE planner
// (`planDagTick`) so the scheduling decision is conformance-tested independent of
// any database or worker. The pg-backed read model + the createQueuedRunFromSpec
// enqueuer + the LISTEN/NOTIFY subscriber live in `engine/dag/walker.ts`.

// ---- DAG snapshot ---------------------------------------------------------

/**
 * The lifecycle states a spec can occupy from the walker's vantage point,
 * normalized from the run-lifecycle spec status (engine/state/spec.ts) into the
 * three buckets that drive scheduling. The Phase-0/1 enum the run loop persists
 * is `pending → active → done`; the Phase-2 canonical enum adds
 * `open/in_flight/review/merged/halted/cancelled`. The walker only needs to know
 * whether a spec is a candidate (pending), occupying a slot (in-flight), or a
 * satisfied dependency (done) — `classifySpecStatus` maps both enums onto these.
 */
export type DagSpecPhase = "pending" | "in_flight" | "done" | "terminal_blocked";

/** One spec node in the project's DAG, as the walker reasons over it. */
export interface DagSpecNode {
  specId: string;
  /** The walker-relevant phase, already normalized from the persisted status. */
  phase: DagSpecPhase;
  /** The spec ids this spec depends on (its `depends_on` edges). */
  dependsOn: string[];
  /**
   * A stable, monotonic ordering key for the deterministic tiebreak (creation
   * order). Priority ordering (P1b) layers ON TOP of this; until then this is the
   * sole order. Lower sorts first.
   */
  orderKey: number;
}

/** A point-in-time snapshot of a project's spec DAG, loaded under RLS. */
export interface DagSnapshot {
  projectId: string;
  nodes: DagSpecNode[];
}

// ---- Tick plan (the pure scheduling decision) -----------------------------

/** Why a walker tick produced the outcome it did — drives the emitted event. */
export type DagTickStatus =
  // The walker enqueued one or more ready specs this tick.
  | "enqueued"
  // No pending spec is ready (all deps done) AND no slot pressure — every spec is
  // done or in-flight, or pending specs remain blocked on unfinished deps.
  | "drained"
  // Ready specs exist but the concurrency ceiling is already saturated — the
  // walker held them back (the Phase-1 throttle; budget proper halts downstream).
  | "budget_paused";

/** The deterministic plan a tick produces from a snapshot + a ceiling. */
export interface DagTickPlan {
  status: DagTickStatus;
  /** Spec ids to enqueue THIS tick, in deterministic order, capped to headroom. */
  toEnqueue: string[];
  /** In-flight count at plan time (specs occupying a slot). */
  inFlightCount: number;
  /** Done-spec count (satisfied dependencies). */
  doneCount: number;
  /** Pending specs NOT ready — blocked on an unfinished dependency. */
  blockedCount: number;
  /** Ready specs that did not fit under the ceiling (the held-back count). */
  readyHeldBack: number;
  /** The governed concurrency ceiling the plan respected. */
  concurrencyCeiling: number;
}

/**
 * The PURE scheduling core (no DB, no I/O, no clock): given a DAG snapshot and
 * the governed concurrency ceiling, decide exactly which specs to enqueue this
 * tick and classify the outcome. This is the behavior the conformance suite pins.
 *
 * Readiness predicate (Phase-1 baseline, mirrors ensureSpecDependenciesDone): a
 * `pending` spec is ready iff EVERY id in its `dependsOn` resolves to a node in
 * `done` phase. A dependency that is missing, pending, in-flight, or terminally
 * blocked makes the spec NOT ready. A `pending` spec with no dependencies is
 * always ready (a root).
 *
 * Ordering: ready specs sort by `orderKey` ascending (the stable creation-order
 * tiebreak). `orderReadySet` is the single seam P1b extends to sort by priority
 * first, then this tiebreak — the planner calls it so the seam is honored here.
 *
 * Headroom: enqueue at most `max(0, ceiling - inFlightCount)` specs. A spec
 * already in-flight is NEVER re-enqueued (idempotency) — it is counted as a slot
 * consumer, not a candidate.
 */
export function planDagTick(snapshot: DagSnapshot, concurrencyCeiling: number): DagTickPlan {
  if (!Number.isInteger(concurrencyCeiling) || concurrencyCeiling < 1) {
    throw new RangeError(`concurrencyCeiling must be a positive integer, got ${concurrencyCeiling}`);
  }
  const byId = new Map<string, DagSpecNode>();
  for (const node of snapshot.nodes) {
    byId.set(node.specId, node);
  }

  const doneCount = snapshot.nodes.filter((n) => n.phase === "done").length;
  const inFlightCount = snapshot.nodes.filter((n) => n.phase === "in_flight").length;

  const pending = snapshot.nodes.filter((n) => n.phase === "pending");
  const ready = pending.filter((n) => isReady(n, byId));
  const blockedCount = pending.length - ready.length;

  const ordered = orderReadySet(ready);
  const headroom = Math.max(0, concurrencyCeiling - inFlightCount);
  const toEnqueue = ordered.slice(0, headroom).map((n) => n.specId);
  const readyHeldBack = ordered.length - toEnqueue.length;

  const status: DagTickStatus = toEnqueue.length > 0 ? "enqueued" : readyHeldBack > 0 ? "budget_paused" : "drained";

  return {
    status,
    toEnqueue,
    inFlightCount,
    doneCount,
    blockedCount,
    readyHeldBack,
    concurrencyCeiling,
  };
}

/**
 * The Phase-1 readiness predicate: a pending spec is ready iff every dependency
 * resolves to a DONE node. A missing dependency (an edge to an id not in the
 * snapshot) is treated as unsatisfied — the spec is held, never run on a phantom.
 */
function isReady(node: DagSpecNode, byId: Map<string, DagSpecNode>): boolean {
  return node.dependsOn.every((depId) => byId.get(depId)?.phase === "done");
}

/**
 * Order the ready set deterministically. Phase-1: the stable creation-order
 * tiebreak (`orderKey` ascending, then `specId` for total determinism). This is
 * the SINGLE seam P1b extends to sort by `priority` first, then this tiebreak —
 * keeping the planner's ordering call site unchanged.
 */
export function orderReadySet(ready: ReadonlyArray<DagSpecNode>): DagSpecNode[] {
  return [...ready].sort((a, b) =>
    a.orderKey === b.orderKey ? compareIds(a.specId, b.specId) : a.orderKey - b.orderKey,
  );
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- Seams ----------------------------------------------------------------

/**
 * Loads a project's spec-DAG snapshot under RLS. DAG state is the source of
 * truth (autonomy-engine.md §1.7) — the read happens fresh every tick, never
 * cached in memory. The pg-backed impl org-scopes the read; an off-scope read
 * sees zero rows (RLS denies by default), so the snapshot is always the calling
 * org's DAG.
 */
export interface DagReadModel {
  loadSnapshot(projectId: string): Promise<DagSnapshot>;
}

/**
 * Enqueues a run for one ready spec, via the EXISTING createQueuedRunFromSpec
 * path — the SAME path a manual operator trigger uses and the SAME parallel
 * worker then runs. Returns the new run id (for the dag.spec.enqueued event). It
 * atomically claims the pending spec (pending → active), so a concurrent tick can
 * never double-enqueue the same spec — the claim is the idempotency boundary.
 */
export interface DagEnqueuer {
  enqueueSpecRun(input: { projectId: string; specId: string }): Promise<{ runId: string }>;
}

/** What a single walk produced — surfaced for the subscriber + tests to assert. */
export interface WalkResult {
  projectId: string;
  status: DagTickStatus;
  /** The spec ids actually enqueued this walk (in order). */
  enqueuedSpecIds: string[];
  /** The run ids created for them (parallel to enqueuedSpecIds). */
  enqueuedRunIds: string[];
}

/**
 * The per-project DagWalker. `walk(projectId)` performs one full scheduling pass:
 * load the snapshot → plan the tick → enqueue up to headroom → emit the outcome
 * event(s). The subscriber calls it on startup and on every relevant notification
 * for the project. `walk` is the unit of work the conformance suite drives.
 */
export interface DagWalker {
  walk(projectId: string): Promise<WalkResult>;
}
