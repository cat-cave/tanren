// queue/stack statistics (autonomy-engine.md §2d).
// A pure reducer (`deriveQueueStats`) over the native queue's OWN events plus a
// thin DB loader (`computeQueueStats`). No migration, no write path — every
// input event predates this read-model. This is the read-model that surfaces
// what a managed merge queue's dashboard would — from the native queue's own events.
//
// Inputs (all read-only native-queue events):
//   - merge.queued          → an entry ENTERED the queue (time-in-queue start).
//   - merge.queue.advanced  → the coordinator selected a head (depth sample +
//                             the entry leaving the queue = time-in-queue end).
//   - merge.dequeued        → an entry left WITHOUT merging (also a queue exit),
//                             tallied by reason.
//   - merge.batch.{checking,passed,bisecting,culprit} → batch pass-rate +
//                             bisect / culprit counts.
//   - spec_dependencies     → the DAG, for the deepest stack among queued specs.

import type pg from "pg";
import { QueueStats, type QueueDepthPoint } from "./types.js";

const DEFAULT_WINDOW_DAYS = 30;

/** A native-queue event, normalized to the fields the reducer needs. */
export interface QueueEvent {
  eventType:
    | "merge.queued"
    | "merge.queue.advanced"
    | "merge.dequeued"
    | "merge.batch.checking"
    | "merge.batch.passed"
    | "merge.batch.bisecting"
    | "merge.batch.culprit";
  ts: Date;
  /** The spec the event concerns (entry events carry one); null for batch events. */
  specId: string | null;
  /** merge.queue.advanced carries the queue depth at selection. */
  queueDepth: number | null;
  /** merge.dequeued carries the reason. */
  dequeueReason: "conflict" | "blocked" | "failed" | "superseded" | null;
  /** merge.batch.culprit carries the number of sub-batch checks performed. */
  bisectChecks: number | null;
}

/** A directed dependency edge: `fromSpecId` depends on `toSpecId`. */
export interface DependencyEdge {
  fromSpecId: string;
  toSpecId: string;
}

export interface QueueStatsInputs {
  events: QueueEvent[];
  /** Dependency edges among the specs that flowed through the queue. */
  dependencyEdges: DependencyEdge[];
}

export interface DeriveQueueOptions {
  projectId: string;
  windowStart: Date;
  windowEnd: Date;
  windowDays: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Pure queue-stats reducer. Deterministic over its inputs; the DB loader below
 * is the only impure shell. Returns a fully-typed, schema-valid `QueueStats`.
 */
export function deriveQueueStats(inputs: QueueStatsInputs, options: DeriveQueueOptions): QueueStats {
  const events = [...inputs.events].sort((a, b) => a.ts.getTime() - b.ts.getTime());

  // --- queue depth series (from merge.queue.advanced) -----------------------
  const depthSeries: QueueDepthPoint[] = [];
  for (const e of events) {
    if (e.eventType === "merge.queue.advanced" && e.queueDepth !== null) {
      depthSeries.push({ at: e.ts.toISOString(), depth: e.queueDepth });
    }
  }
  const depths = depthSeries.map((p) => p.depth);
  const maxDepth = depths.length === 0 ? null : Math.max(...depths);
  const meanDepth = depths.length === 0 ? null : depths.reduce((a, b) => a + b, 0) / depths.length;

  // --- time in queue: merge.queued → next exit (advanced/dequeued) per spec --
  // Each queued event opens an interval for its spec; the next advanced/dequeued
  // for that spec closes the EARLIEST open interval (FIFO per spec).
  const openQueued = new Map<string, Date[]>();
  const timeInQueue: number[] = [];
  for (const e of events) {
    if (e.specId === null) continue;
    if (e.eventType === "merge.queued") {
      const q = openQueued.get(e.specId) ?? [];
      q.push(e.ts);
      openQueued.set(e.specId, q);
    } else if (e.eventType === "merge.queue.advanced" || e.eventType === "merge.dequeued") {
      const q = openQueued.get(e.specId);
      if (q !== undefined && q.length > 0) {
        const started = q.shift()!;
        const seconds = (e.ts.getTime() - started.getTime()) / 1000;
        if (Number.isFinite(seconds) && seconds >= 0) timeInQueue.push(seconds);
      }
    }
  }
  const medianTimeInQueueSeconds = median(timeInQueue);
  const maxTimeInQueueSeconds = timeInQueue.length === 0 ? null : Math.max(...timeInQueue);

  // --- batch / bisect counts ------------------------------------------------
  const batchesChecked = events.filter((e) => e.eventType === "merge.batch.checking").length;
  const batchesPassed = events.filter((e) => e.eventType === "merge.batch.passed").length;
  const batchesBisected = events.filter((e) => e.eventType === "merge.batch.bisecting").length;
  const culpritEvents = events.filter((e) => e.eventType === "merge.batch.culprit");
  const culpritsIsolated = culpritEvents.length;
  const bisectChecksPerformed = culpritEvents.reduce((sum, e) => sum + (e.bisectChecks ?? 0), 0);
  const batchPassRate = batchesChecked === 0 ? null : batchesPassed / batchesChecked;

  // --- dequeues by reason ---------------------------------------------------
  const dequeues = { conflict: 0, blocked: 0, failed: 0, superseded: 0 };
  for (const e of events) {
    if (e.eventType === "merge.dequeued" && e.dequeueReason !== null) {
      dequeues[e.dequeueReason] += 1;
    }
  }

  // --- stack depth: deepest dependency chain among queued specs -------------
  const queuedSpecs = new Set<string>();
  for (const e of events) if (e.specId !== null) queuedSpecs.add(e.specId);
  const maxStackDepth = deepestChainDepth(inputs.dependencyEdges, queuedSpecs);

  return QueueStats.parse({
    projectId: options.projectId,
    windowStart: options.windowStart.toISOString(),
    windowEnd: options.windowEnd.toISOString(),
    windowDays: options.windowDays,
    depthSeries,
    maxDepth,
    meanDepth,
    medianTimeInQueueSeconds,
    maxTimeInQueueSeconds,
    timeInQueueSample: timeInQueue.length,
    batchesChecked,
    batchesPassed,
    batchPassRate,
    batchesBisected,
    culpritsIsolated,
    bisectChecksPerformed,
    dequeues,
    maxStackDepth,
    computedAt: options.windowEnd.toISOString(),
  });
}

/**
 * Longest dependency chain (in nodes) restricted to `relevant` specs. Edge
 * `from depends on to`, so a chain follows from→to. Cycle-safe via a visiting
 * guard (a cycle contributes its acyclic prefix only).
 */
function deepestChainDepth(edges: ReadonlyArray<DependencyEdge>, relevant: ReadonlySet<string>): number | null {
  if (relevant.size === 0) return null;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!relevant.has(e.fromSpecId) || !relevant.has(e.toSpecId)) continue;
    const list = adj.get(e.fromSpecId) ?? [];
    list.push(e.toSpecId);
    adj.set(e.fromSpecId, list);
  }
  // Longest simple (acyclic) path from `node`, in nodes. `visiting` both
  // terminates cycles and keeps the path simple: a node already on the current
  // path contributes nothing further, so a k-cycle yields a depth of k (its
  // acyclic unrolling), never an infinite loop. No memoization: a value cached
  // mid-cycle would be path-dependent, and the queued-spec set is small.
  const visiting = new Set<string>();
  function depth(node: string): number {
    visiting.add(node);
    let best = 1;
    for (const next of adj.get(node) ?? []) {
      // Already on this path — skip to keep the path simple (cycle-safe).
      if (visiting.has(next)) continue;
      best = Math.max(best, 1 + depth(next));
    }
    visiting.delete(node);
    return best;
  }
  let max = 1;
  for (const spec of relevant) max = Math.max(max, depth(spec));
  return max;
}

export interface ComputeQueueStatsOptions {
  projectId: string;
  now?: Date;
  windowDays?: number;
}

interface QueueEventQueryRow {
  event_type: string;
  spec_id: string | null;
  payload: unknown;
  ts: Date;
}
interface DependencyEdgeQueryRow {
  from_spec_id: string;
  to_spec_id: string;
}

const QUEUE_EVENT_TYPES = [
  "merge.queued",
  "merge.queue.advanced",
  "merge.dequeued",
  "merge.batch.checking",
  "merge.batch.passed",
  "merge.batch.bisecting",
  "merge.batch.culprit",
] as const;

/**
 * Load the native-queue events + the project's dependency edges for a window
 * and reduce them to `QueueStats`. Touches only `events` and `spec_dependencies`.
 */
export async function computeQueueStats(
  pool: Pick<pg.Pool, "query">,
  options: ComputeQueueStatsOptions,
): Promise<QueueStats> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const eventsResult = await pool.query<QueueEventQueryRow>(
    `SELECT event_type, spec_id, payload, ts
       FROM events
       WHERE project_id = $1
         AND event_type = ANY($2::text[])
         AND ts >= $3
       ORDER BY ts ASC`,
    [options.projectId, [...QUEUE_EVENT_TYPES], since],
  );

  const edgesResult = await pool.query<DependencyEdgeQueryRow>(
    `SELECT d.from_spec_id, d.to_spec_id
       FROM spec_dependencies d
       INNER JOIN specs fs ON fs.spec_id = d.from_spec_id
      WHERE fs.project_id = $1`,
    [options.projectId],
  );

  return deriveQueueStats(
    {
      events: eventsResult.rows.map(normalizeQueueEvent),
      dependencyEdges: edgesResult.rows.map((r) => ({ fromSpecId: r.from_spec_id, toSpecId: r.to_spec_id })),
    },
    { projectId: options.projectId, windowStart: since, windowEnd: now, windowDays },
  );
}

/** Normalize a raw event row to the reducer's `QueueEvent`. Pure. */
export function normalizeQueueEvent(row: QueueEventQueryRow): QueueEvent {
  const payload = (row.payload ?? {}) as {
    queueDepth?: unknown;
    reason?: unknown;
    checks?: unknown;
    specId?: unknown;
  };
  const dequeueReason =
    payload.reason === "conflict" ||
    payload.reason === "blocked" ||
    payload.reason === "failed" ||
    payload.reason === "superseded"
      ? payload.reason
      : null;
  // batch.culprit carries its own specId in payload (the events row spec_id may
  // be null for batch events); prefer the row spec_id, fall back to payload.
  const specId = row.spec_id ?? (typeof payload.specId === "string" ? payload.specId : null);
  return {
    eventType: row.event_type as QueueEvent["eventType"],
    ts: new Date(row.ts),
    specId,
    queueDepth: typeof payload.queueDepth === "number" ? payload.queueDepth : null,
    dequeueReason,
    bisectChecks: typeof payload.checks === "number" ? payload.checks : null,
  };
}
