// The pg-backed DagWalker seam wirings (autonomy-engine.md §1a, §2c), split out of
// `walker.ts` to keep each file under the 500-line cap. This module carries the
// three production wirings of the contract seams the EventEmittingDagWalker
// composes:
//   - PgDagReadModel: the org-scoped DAG snapshot read (DAG state is the source of
//     truth; read fresh each tick, RLS-scoped to the project's org).
//   - SpecRunDagEnqueuer: createQueuedRunFromSpec under a platform-admin actor
//     carrying the project's org (the atomic pending→active claim is the
//     idempotency boundary). A speculative start threads the dynamic base + skips
//     the done-only dependency gate (P2c-1).
//   - PgDagEventEmitter: writes dag.spec.enqueued / dag.spec.speculative /
//     dag.spec.speculation_held / dag.drained / dag.budget.paused (the GENUINE
//     dollar-budget pause) / dag.concurrency.saturated (the slot-saturation hold)
//     through the single org-scoped event-writer seam.

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { BudgetPeriod, SpeculationThreshold } from "../config/index.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type {
  DagEnqueuer,
  DagReadModel,
  DagSnapshot,
  DagSpecNode,
  DagSpecPhase,
  DagTickPlan,
} from "../contracts/dagWalker.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import { SpecPriority } from "../state/spec.js";
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
    // NEVER-STRAND escalation: a spec the strand-reconciler gave up re-enqueuing
    // (bounded escalation) is terminal — it FREES its slot and blocks ONLY its
    // dependents (never the whole DAG), exactly like a halted/cancelled spec.
    case "needs_attention":
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
  priority: unknown;
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
 * own DAG. The `priority` column is the primary ordering key (the pure planner's
 * `orderReadySet` sorts P0→tbd first); the `orderKey` (creation order) is the
 * deterministic tiebreak within a priority.
 */
export class PgDagReadModel implements DagReadModel {
  constructor(private readonly pool: pg.Pool) {}

  async loadSnapshot(projectId: string): Promise<DagSnapshot> {
    const project = await this.resolveProject(projectId);
    if (project.orgId === null) {
      // No resolvable org ⇒ no DAG the walker may schedule (RLS would deny every
      // read anyway). An empty snapshot drains cleanly rather than throwing.
      return { projectId, nodes: [], archived: false };
    }
    if (project.archived) {
      // Archived ⇒ dormant. Skip the spec read entirely; the walker short-circuits
      // on `archived` and enqueues nothing.
      return { projectId, nodes: [], archived: true };
    }
    const orgId = project.orgId;
    const nodes = await runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<SpecDagRow>(
        `SELECT spec_id, status, depends_on, priority,
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
          // The DB CHECK guarantees a valid value; parse defends the read seam.
          priority: SpecPriority.parse(row.priority),
          orderKey: Number(row.rn),
        }),
      );
    });
    return { projectId, nodes, archived: false };
  }

  private async resolveProject(projectId: string): Promise<{ orgId: string | null; archived: boolean }> {
    return runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null; lifecycle: string }>(
        "SELECT org_id, lifecycle FROM projects WHERE project_id = $1",
        [projectId],
      );
      const row = result.rows[0];
      return { orgId: row?.org_id ?? null, archived: row?.lifecycle === "archived" };
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
  /**
   * @param runStateWriter Plane-split (autonomy loops): when present, the
   *   run-CREATION transaction routes through the control plane (the de-privileged
   *   data plane can no longer write `runs`/`specs`/`tasks`/`events` directly);
   *   absent, `createQueuedRunFromSpec` runs in-process — byte-identical to today.
   */
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter?: RunStateWriter,
  ) {}

  async enqueueSpecRun(input: {
    projectId: string;
    specId: string;
    speculativeBase?: string;
    integratedAncestorShas?: Record<string, string>;
  }): Promise<{ runId: string }> {
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
    const createInput = {
      specId: input.specId,
      trigger: "dag_walker",
      // A speculative start skips the done-only dependency gate and records the
      // integration branch as the run's dynamic base + the per-ancestor head SHA
      // map (the change-percolation divergence key, P2c-2).
      ...(input.speculativeBase !== undefined && {
        speculative: {
          speculativeBase: input.speculativeBase,
          ...(input.integratedAncestorShas !== undefined && {
            integratedAncestorShas: input.integratedAncestorShas,
          }),
        },
      }),
    };
    // Plane-split: route the full multi-table run-CREATE transaction through the
    // control plane when a writer is wired; else create it in-process on the pool.
    // Both run the SAME `createQueuedRunFromSpec` under the actor's org scope.
    const run =
      this.runStateWriter === undefined
        ? await createQueuedRunFromSpec(this.pool, createInput, actor)
        : await this.runStateWriter.createQueuedRun({ input: createInput, actor });
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
  emitSpecSpeculative(input: {
    projectId: string;
    specId: string;
    runId: string;
    unmergedAncestors: string[];
    threshold: SpeculationThreshold;
    integrationBranch: string;
  }): Promise<void>;
  emitSpeculationHeld(input: {
    projectId: string;
    specId: string;
    unmergedAncestors: string[];
    depth: number;
    depthCap: number;
  }): Promise<void>;
  emitDrained(input: { projectId: string; plan: DagTickPlan }): Promise<void>;
  /**
   * The dollar-budget pause: cumulative spend reached the configured ceiling, OR a
   * BUDGET-SAFETY (C1b/M5) fail-closed safety pause (`reason` set).
   */
  emitBudgetPaused(input: {
    projectId: string;
    ceilingUsd: number;
    spentUsd: number;
    period: BudgetPeriod;
    readyHeldBack: number;
    reason?: "unpriced_spend" | "unparseable_config";
  }): Promise<void>;
  /** The concurrency-saturation hold: ready specs held back because no slot is free. */
  emitConcurrencySaturated(input: { projectId: string; plan: DagTickPlan }): Promise<void>;
}

/**
 * The pg-backed dag.* event emitter. Resolves the project's org, then writes each
 * event through the org-scoped PgEventStore (the single event-writer seam). The
 * dag.drained / dag.budget.paused events are PROJECT-scoped (no run/spec) — the
 * eventStore admits a project-only append (run_id/spec_id are nullable columns).
 */
export class PgDagEventEmitter implements DagEventEmitter {
  /**
   * @param runStateWriter Plane-split (autonomy loops): when present, dag.* events
   *   append through the control-plane writer (the de-privileged data plane can no
   *   longer write `events` directly); absent, they append in-process via the
   *   org-scoped `PgEventStore` — byte-identical to today.
   */
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter?: RunStateWriter,
  ) {}

  private async withScopedStore(projectId: string, work: (store: EventStore) => Promise<void>): Promise<void> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) return;
    // Plane-split: when a writer is wired, route the append through the control
    // plane — the writer's `append` resolves the run's org from the ambient
    // per-job org-id, so set it for the duration of the append. Absent, append
    // in-process under a short org scope (byte-identical to today).
    if (this.runStateWriter !== undefined) {
      const writer = this.runStateWriter;
      await runWithJobOrgId(orgId, () => work(writer));
      return;
    }
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

  async emitSpecSpeculative(input: {
    projectId: string;
    specId: string;
    runId: string;
    unmergedAncestors: string[];
    threshold: SpeculationThreshold;
    integrationBranch: string;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        runId: input.runId,
        specId: input.specId,
        projectId: input.projectId,
        eventType: "dag.spec.speculative",
        payload: {
          specId: input.specId,
          runId: input.runId,
          unmergedAncestors: input.unmergedAncestors,
          threshold: input.threshold,
          integrationBranch: input.integrationBranch,
        },
      }),
    );
  }

  async emitSpeculationHeld(input: {
    projectId: string;
    specId: string;
    unmergedAncestors: string[];
    depth: number;
    depthCap: number;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        specId: input.specId,
        projectId: input.projectId,
        eventType: "dag.spec.speculation_held",
        payload: {
          specId: input.specId,
          unmergedAncestors: input.unmergedAncestors,
          depth: input.depth,
          depthCap: input.depthCap,
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

  async emitBudgetPaused(input: {
    projectId: string;
    ceilingUsd: number;
    spentUsd: number;
    period: BudgetPeriod;
    readyHeldBack: number;
    reason?: "unpriced_spend" | "unparseable_config";
  }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        projectId: input.projectId,
        eventType: "dag.budget.paused",
        payload: {
          ceilingUsd: input.ceilingUsd,
          spentUsd: input.spentUsd,
          period: input.period,
          readyHeldBack: input.readyHeldBack,
          ...(input.reason !== undefined && { reason: input.reason }),
        },
      }),
    );
  }

  async emitConcurrencySaturated(input: { projectId: string; plan: DagTickPlan }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        projectId: input.projectId,
        eventType: "dag.concurrency.saturated",
        payload: {
          readyHeldBack: input.plan.readyHeldBack,
          inFlightCount: input.plan.inFlightCount,
          concurrencyCeiling: input.plan.concurrencyCeiling,
        },
      }),
    );
  }
}

export type { DagEventEmitter };
