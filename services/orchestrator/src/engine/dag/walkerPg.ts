// The pg-backed DagWalker seam wirings (autonomy-engine.md §1a, §2c), split out of
// `walker.ts` to keep each file under the 500-line cap. This module carries the
// three production wirings of the contract seams the EventEmittingDagWalker
// composes:
//   - PgDagReadModel: the org-scoped DAG snapshot read (DAG state is the source of
//     truth; read fresh each tick, RLS-scoped to the project's org).
//   - SpecRunDagEnqueuer: createQueuedRunFromSpec under a platform-admin actor carrying
//     the project's org (the atomic pending→active claim is the idempotency boundary). A
//     speculative start threads the dynamic base + skips the done-only dependency gate.
//   - PgDagEventEmitter: writes the dag.* events (enqueued / speculative /
//     speculation_held / drained / budget.paused / budget.milestone /
//     concurrency.saturated / config.corrupt) through the single org-scoped
//     event-writer seam.

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
import type { DagConfigCorruptPayload } from "../events/schemas/dag.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import { SpecPriority } from "../state/spec.js";
import { createQueuedRunFromSpec } from "../workflow/projectSpec.js";
import type { AncestorStack } from "./ancestorStack.js";

/**
 * Map a persisted spec status (the SINGLE canonical `open/in_flight/review/merged/
 * halted/cancelled/needs_attention` vocabulary) onto the walker's three scheduling
 * buckets. A spec the walker may START (`open`) maps to the `pending` bucket; one
 * already OCCUPYING A SLOT (`in_flight`/`review`) maps to `in_flight`; the
 * SATISFIED-DEPENDENCY terminal (`merged`) maps to `done` (§1a: "all deps merged").
 * A terminally-halted/cancelled/needs_attention spec is neither a candidate nor a
 * satisfied dependency: it blocks any dependent (correct — the dependent cannot run
 * on a halted ancestor until an operator routes past it). There is no second status
 * vocabulary to normalize: every writer speaks this one.
 */
export function classifySpecStatus(status: string): DagSpecPhase {
  switch (status) {
    case "open":
      return "pending";
    case "in_flight":
    case "review":
      return "in_flight";
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
    ancestorStack?: AncestorStack;
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
      // integration branch as the run's dynamic base + the per-ancestor head SHA map.
      ...(input.speculativeBase !== undefined && {
        speculative: {
          speculativeBase: input.speculativeBase,
          ...(input.integratedAncestorShas !== undefined && {
            integratedAncestorShas: input.integratedAncestorShas,
          }),
          // WS-A PR-1: dual-write the ordered ancestor stack (additive, unread for now).
          ...(input.ancestorStack !== undefined && { ancestorStack: input.ancestorStack }),
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

/** The `dag.config.corrupt` emit input: the project + the event payload. */
export type ConfigCorruptInput = { projectId: string } & DagConfigCorruptPayload;

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
  /**
   * A budget FRACTION milestone (50% / 80% of the ceiling crossed before the terminal
   * pause). IDEMPOTENT per band per budget window: appends ONLY if no `dag.budget.milestone`
   * for the same band exists in the current calendar window (so re-walks never re-ping).
   * Returns true when appended, false when deduped — the walker logs the dedup, never silent.
   */
  emitBudgetMilestone(input: {
    projectId: string;
    band: 50 | 80;
    ceilingUsd: number;
    spentUsd: number;
    period: BudgetPeriod;
  }): Promise<boolean>;
  /** The concurrency-saturation hold: ready specs held back because no slot is free. */
  emitConcurrencySaturated(input: { projectId: string; plan: DagTickPlan }): Promise<void>;
  /** no_silent_fallbacks (LOUD-DEFAULT): a corrupt persisted project config the walker
   * read while resolving a NON-merge eagerness knob; it proceeds at the SAFE default but
   * surfaces the corruption here (and logs) rather than swallowing it. */
  emitConfigCorrupt(input: ConfigCorruptInput): Promise<void>;
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
    const { doneCount, inFlightCount, blockedCount } = input.plan;
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        projectId: input.projectId,
        eventType: "dag.drained",
        payload: { doneCount, inFlightCount, blockedCount },
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
    const { projectId, ceilingUsd, spentUsd, period, readyHeldBack, reason } = input;
    await this.withScopedStore(projectId, (store) =>
      store.append({
        projectId,
        eventType: "dag.budget.paused",
        payload: { ceilingUsd, spentUsd, period, readyHeldBack, ...(reason !== undefined && { reason }) },
      }),
    );
  }

  /**
   * Append a budget milestone (50% / 80%) IDEMPOTENTLY per band per budget window: in ONE
   * org-scoped tx, skip if a `dag.budget.milestone` for this band already exists in the
   * current calendar window (return false; the walker logs the dedup, never silent), else
   * append. A concurrent double-walk is benign (at worst a duplicate heads-up, never missed).
   */
  async emitBudgetMilestone(input: {
    projectId: string;
    band: 50 | 80;
    ceilingUsd: number;
    spentUsd: number;
    period: BudgetPeriod;
  }): Promise<boolean> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [input.projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) return false;
    const windowClause = budgetMilestoneWindowClause(input.period);
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM events
          WHERE project_id = $1
            AND event_type = 'dag.budget.milestone'
            AND (payload->>'band')::int = $2${windowClause}
          LIMIT 1`,
        [input.projectId, input.band],
      );
      if (existing.rows.length > 0) return false;

      const store: EventStore = this.runStateWriter ?? new PgEventStore(client);
      const append = () =>
        store.append({
          projectId: input.projectId,
          eventType: "dag.budget.milestone",
          payload: {
            band: input.band,
            ceilingUsd: input.ceilingUsd,
            spentUsd: input.spentUsd,
            period: input.period,
          },
        });
      if (this.runStateWriter === undefined) {
        await append();
      } else {
        await runWithJobOrgId(orgId, append);
      }
      return true;
    });
  }

  async emitConcurrencySaturated(input: { projectId: string; plan: DagTickPlan }): Promise<void> {
    const { readyHeldBack, inFlightCount, concurrencyCeiling } = input.plan;
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        projectId: input.projectId,
        eventType: "dag.concurrency.saturated",
        payload: { readyHeldBack, inFlightCount, concurrencyCeiling },
      }),
    );
  }

  async emitConfigCorrupt({ projectId, ...payload }: ConfigCorruptInput): Promise<void> {
    await this.withScopedStore(projectId, (store) =>
      store.append({ projectId, eventType: "dag.config.corrupt", payload }),
    );
  }
}

// The `ts` window clause for a budget milestone dedup — mirrors the budget-sum window in
// `budgetGate.ts` so a milestone re-arms at the SAME calendar boundary the spend window
// resets at. The period is a frozen `BudgetPeriod` enum member (never user input), so the
// trunc unit is constant and the query stays parameter-free for project + band.
function budgetMilestoneWindowClause(period: BudgetPeriod): string {
  // `total` is the lifetime cap (no clause); the rest are calendar-anchored.
  const trunc: Record<Exclude<BudgetPeriod, "total">, string> = {
    monthly: "month",
    quarterly: "quarter",
    annual: "year",
  };
  return period === "total" ? "" : ` AND ts >= date_trunc('${trunc[period]}', now())`;
}

export type { DagEventEmitter };
