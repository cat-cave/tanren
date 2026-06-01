// The production DagWalker (autonomy-engine.md §1a — the keystone). A per-project
// background SCHEDULER over the EXISTING run executor (it mirrors how the
// BenchmarkRunner schedules trials — it does NOT execute runs itself). It loads
// the spec DAG under RLS, plans the tick with the pure `planDagTick` core, and
// enqueues up to the governed concurrency headroom of ready specs through the
// SAME createQueuedRunFromSpec path a manual operator trigger uses. The parallel
// run-executor worker then runs them.
//
// This module carries the three production wirings of the contract seams:
//   - PgDagReadModel: the org-scoped snapshot read (DAG state is the source of
//     truth; read fresh each tick, RLS-scoped to the project's org).
//   - SpecRunDagEnqueuer: createQueuedRunFromSpec under a platform-admin actor
//     carrying the project's org (the atomic pending→active claim is the
//     idempotency boundary — a spec already in-flight is never re-enqueued).
//   - EventEmittingDagWalker: ties read model + enqueuer + the pure planner
//     together and emits dag.spec.enqueued / dag.drained / dag.budget.paused.
//
// The LISTEN/NOTIFY subscriber that runs the walker on startup + on every
// run.*-terminal / merge.completed notification lives in `subscriber.ts`.

import { getSystemPool, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { resolveWorkerConcurrency } from "../config/index.js";
import {
  type DagEnqueuer,
  type DagReadModel,
  type DagSnapshot,
  type DagSpecNode,
  type DagSpecPhase,
  type DagWalker,
  type DagTickPlan,
  planDagTick,
  type WalkResult,
} from "../contracts/dagWalker.js";
import { PgEventStore } from "../eventStore.js";
import { createQueuedRunFromSpec } from "../workflow/projectSpec.js";

/**
 * Normalize a persisted spec status (either the Phase-0/1 `pending/active/done`
 * enum or the Phase-2 `open/in_flight/review/merged/...` enum) into the walker's
 * three scheduling buckets. A spec the walker may START is `pending`; one already
 * OCCUPYING A SLOT (claimed or running) is `in_flight`; a SATISFIED DEPENDENCY is
 * `done` — and a merged spec counts as done for readiness (§1a: "all deps
 * merged/done"). A terminally-halted/cancelled spec is neither a candidate nor a
 * satisfied dependency: it blocks any dependent (which is correct — the dependent
 * cannot run on a halted ancestor until an operator routes past it).
 */
export function classifySpecStatus(status: string): DagSpecPhase {
  switch (status) {
    case "pending":
      return "pending";
    case "active":
    case "open":
    case "in_flight":
    case "review":
      return "in_flight";
    case "done":
    case "merged":
      return "done";
    case "halted":
    case "cancelled":
      return "terminal_blocked";
    default:
      // An unknown status is treated as occupying a slot, never as a satisfied
      // dependency — the walker must never run a dependent on an unrecognized
      // ancestor state, and must never re-enqueue an unrecognized spec.
      return "in_flight";
  }
}

interface SpecDagRow {
  spec_id: string;
  status: string;
  depends_on: unknown;
  rn: string | number;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The pg-backed DAG read model. Resolves the project's org (system-scoped, the
 * same bootstrap the worker + benchmark use to discover an org before any tenant
 * work), then reads the project's specs UNDER THAT ORG SCOPE (RLS). A read off
 * the wrong scope sees zero rows — so the snapshot is always exactly the project's
 * own DAG. The `orderKey` is the row's creation order (a stable, monotonic
 * tiebreak); P1b layers priority on top in the pure planner's `orderReadySet`.
 */
export class PgDagReadModel implements DagReadModel {
  constructor(private readonly pool: pg.Pool) {}

  async loadSnapshot(projectId: string): Promise<DagSnapshot> {
    const orgId = await this.resolveProjectOrg(projectId);
    if (orgId === null) {
      // No resolvable org ⇒ no DAG the walker may schedule (RLS would deny every
      // read anyway). An empty snapshot drains cleanly rather than throwing.
      return { projectId, nodes: [] };
    }
    const nodes = await runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<SpecDagRow>(
        `SELECT spec_id, status, depends_on,
                row_number() OVER (ORDER BY ctid) AS rn
           FROM specs
          WHERE project_id = $1`,
        [projectId],
      );
      return result.rows.map(
        (row): DagSpecNode => ({
          specId: row.spec_id,
          phase: classifySpecStatus(row.status),
          dependsOn: asStringArray(row.depends_on),
          orderKey: Number(row.rn),
        }),
      );
    });
    return { projectId, nodes };
  }

  private async resolveProjectOrg(projectId: string): Promise<string | null> {
    return runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
  }
}

/**
 * The production enqueuer: create a queued run for a ready spec via the EXISTING
 * createQueuedRunFromSpec path. It runs as a platform-admin actor carrying the
 * project's org so the run/task/event/job writes are RLS-scoped to the tenant
 * (exactly as the BenchmarkRunner's system-actor provisioning does). The atomic
 * pending→active claim INSIDE createQueuedRunFromSpec is the idempotency boundary:
 * a spec already past `pending` raises SpecNotRunnableError, so a concurrent tick
 * can never double-enqueue it.
 */
export class SpecRunDagEnqueuer implements DagEnqueuer {
  constructor(private readonly pool: pg.Pool) {}

  async enqueueSpecRun(input: { projectId: string; specId: string }): Promise<{ runId: string }> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [input.projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) {
      throw new Error(`cannot enqueue spec ${input.specId}: project ${input.projectId} has no resolvable org`);
    }
    const actor: ActorContext = {
      userId: "dag-walker",
      orgId,
      projectId: input.projectId,
      scopes: ["platform:admin"],
      source: "local_dev",
    };
    const run = await createQueuedRunFromSpec(this.pool, { specId: input.specId, trigger: "dag_walker" }, actor);
    return { runId: run.runId };
  }
}

/** What the walker needs to emit a dag.* event (org-scoped, through eventStore). */
interface DagEventEmitter {
  emitSpecEnqueued(input: {
    projectId: string;
    specId: string;
    runId: string;
    satisfiedDependsOn: string[];
    inFlightBefore: number;
    concurrencyCeiling: number;
  }): Promise<void>;
  emitDrained(input: { projectId: string; plan: DagTickPlan }): Promise<void>;
  emitBudgetPaused(input: { projectId: string; plan: DagTickPlan }): Promise<void>;
}

/**
 * The pg-backed dag.* event emitter. Resolves the project's org, then writes each
 * event through the org-scoped PgEventStore (the single event-writer seam). The
 * dag.drained / dag.budget.paused events are PROJECT-scoped (no run/spec) — the
 * eventStore admits a project-only append (run_id/spec_id are nullable columns).
 */
export class PgDagEventEmitter implements DagEventEmitter {
  constructor(private readonly pool: pg.Pool) {}

  private async withScopedStore(projectId: string, work: (store: PgEventStore) => Promise<void>): Promise<void> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) return;
    await runWithOrgScope(this.pool, orgId, (client) => work(new PgEventStore(client)));
  }

  async emitSpecEnqueued(input: {
    projectId: string;
    specId: string;
    runId: string;
    satisfiedDependsOn: string[];
    inFlightBefore: number;
    concurrencyCeiling: number;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        runId: input.runId,
        specId: input.specId,
        projectId: input.projectId,
        eventType: "dag.spec.enqueued",
        payload: {
          specId: input.specId,
          runId: input.runId,
          satisfiedDependsOn: input.satisfiedDependsOn,
          inFlightBefore: input.inFlightBefore,
          concurrencyCeiling: input.concurrencyCeiling,
        },
      }),
    );
  }

  async emitDrained(input: { projectId: string; plan: DagTickPlan }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        projectId: input.projectId,
        eventType: "dag.drained",
        payload: {
          doneCount: input.plan.doneCount,
          inFlightCount: input.plan.inFlightCount,
          blockedCount: input.plan.blockedCount,
        },
      }),
    );
  }

  async emitBudgetPaused(input: { projectId: string; plan: DagTickPlan }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        projectId: input.projectId,
        eventType: "dag.budget.paused",
        payload: {
          readyHeldBack: input.plan.readyHeldBack,
          inFlightCount: input.plan.inFlightCount,
          concurrencyCeiling: input.plan.concurrencyCeiling,
        },
      }),
    );
  }
}

/** Resolve the governed concurrency ceiling — the config knob, never an env var. */
export type ConcurrencyResolver = () => number;

export interface DagWalkerDeps {
  readModel: DagReadModel;
  enqueuer: DagEnqueuer;
  events: DagEventEmitter;
  /**
   * The governed concurrency ceiling (autonomy-engine.md §1.4): defaults to the
   * config surface's `AllocatorConfig.concurrency` (the SAME ceiling the worker
   * boots with). Never read from `process.env`. A seam so a future per-project/org
   * resolver (and the live rate-limit/budget throttle) slots in without touching
   * the walk loop.
   */
  concurrency?: ConcurrencyResolver;
}

/**
 * The production DagWalker. `walk(projectId)` performs one full scheduling pass:
 * load the snapshot under RLS → plan the tick with the pure core → enqueue up to
 * headroom through createQueuedRunFromSpec → emit the outcome event(s). It never
 * holds DAG state in memory across ticks (it reloads every walk), so the DAG rows
 * are always the source of truth. The subscriber drives it on startup + on every
 * relevant notification.
 */
export class EventEmittingDagWalker implements DagWalker {
  private readonly concurrency: ConcurrencyResolver;

  constructor(private readonly deps: DagWalkerDeps) {
    this.concurrency = deps.concurrency ?? resolveWorkerConcurrency;
  }

  async walk(projectId: string): Promise<WalkResult> {
    const snapshot = await this.deps.readModel.loadSnapshot(projectId);
    const ceiling = this.concurrency();
    const plan = planDagTick(snapshot, ceiling);

    const enqueuedSpecIds: string[] = [];
    const enqueuedRunIds: string[] = [];

    if (plan.toEnqueue.length > 0) {
      const depsBySpec = new Map(snapshot.nodes.map((n) => [n.specId, n.dependsOn]));
      // inFlightBefore reflects the count at plan time PLUS the specs this walk
      // has already enqueued — so the event narrates the true headroom each spec
      // scheduled into, monotonically toward the ceiling.
      let inFlightBefore = plan.inFlightCount;
      for (const specId of plan.toEnqueue) {
        const { runId } = await this.deps.enqueuer.enqueueSpecRun({ projectId, specId });
        await this.deps.events.emitSpecEnqueued({
          projectId,
          specId,
          runId,
          satisfiedDependsOn: depsBySpec.get(specId) ?? [],
          inFlightBefore,
          concurrencyCeiling: ceiling,
        });
        enqueuedSpecIds.push(specId);
        enqueuedRunIds.push(runId);
        inFlightBefore += 1;
      }
    } else if (plan.status === "budget_paused") {
      await this.deps.events.emitBudgetPaused({ projectId, plan });
    } else {
      await this.deps.events.emitDrained({ projectId, plan });
    }

    return { projectId, status: plan.status, enqueuedSpecIds, enqueuedRunIds };
  }
}

/**
 * Build the production DagWalker from a runtime pool — the single construction
 * site the worker boot + subscriber use. Wires the pg read model, the
 * createQueuedRunFromSpec enqueuer, and the pg event emitter; the concurrency
 * ceiling defaults to the config surface (resolveWorkerConcurrency).
 */
export function buildDagWalker(pool: pg.Pool): DagWalker {
  return new EventEmittingDagWalker({
    readModel: new PgDagReadModel(pool),
    enqueuer: new SpecRunDagEnqueuer(pool),
    events: new PgDagEventEmitter(pool),
  });
}

/** Discover every project id that has a DAG to walk (system-scoped, cross-org). */
export async function listWalkableProjectIds(pool: pg.Pool): Promise<string[]> {
  const system = getSystemPool() ?? pool;
  return runWithSystemScope(system, async (client) => {
    const result = await client.query<{ project_id: string }>(
      "SELECT DISTINCT project_id FROM specs WHERE project_id IS NOT NULL ORDER BY project_id",
    );
    return result.rows.map((row) => row.project_id);
  });
}

export type { DagEventEmitter };
