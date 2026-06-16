// The pg-backed dag.* event emitter (autonomy-engine.md §1a, §2c), split out of `walkerPg.ts`
// for the 500-line cap. Resolves the project's org, then writes each event through the
// org-scoped PgEventStore (the single event-writer seam). The dag.drained / dag.budget.paused
// events are PROJECT-scoped (no run/spec) — the eventStore admits a project-only append
// (run_id/spec_id are nullable columns). Plane-split: when a `runStateWriter` is wired, events
// append through the control-plane writer instead of the de-privileged data plane.

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { BudgetPeriod, SpeculationThreshold } from "../config/index.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { DagTickPlan } from "../contracts/dagWalker.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import type { ConfigCorruptInput, DagEventEmitter } from "./walkerPg.js";

/**
 * The pg-backed dag.* event emitter. Resolves the project's org, then writes each event through
 * the org-scoped PgEventStore (the single event-writer seam).
 */
export class PgDagEventEmitter implements DagEventEmitter {
  /**
   * @param runStateWriter Plane-split (autonomy loops): when present, dag.* events append
   *   through the control-plane writer (the de-privileged data plane can no longer write
   *   `events` directly); absent, they append in-process via the org-scoped `PgEventStore`.
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
    // Plane-split: when a writer is wired, route the append through the control plane — the
    // writer's `append` resolves the run's org from the ambient per-job org-id, so set it for
    // the duration of the append. Absent, append in-process under a short org scope.
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

  async emitAncestorNotReady(input: {
    projectId: string;
    specId: string;
    ancestorSpecId: string;
    ancestorPhase: "pending" | "in_flight";
  }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        specId: input.specId,
        projectId: input.projectId,
        eventType: "dag.spec.ancestor_not_ready",
        payload: {
          specId: input.specId,
          // No run was created — the cheap pre-check deferred BEFORE provisioning.
          runId: "",
          ancestorSpecId: input.ancestorSpecId,
          ancestorPhase: input.ancestorPhase,
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
   * org-scoped tx, skip if a `dag.budget.milestone` for this band already exists in the current
   * calendar window (return false; the walker logs the dedup, never silent), else append. A
   * concurrent double-walk is benign (at worst a duplicate heads-up, never missed).
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
// `budgetGate.ts` so a milestone re-arms at the SAME calendar boundary the spend window resets
// at. The period is a frozen `BudgetPeriod` enum member (never user input), so the trunc unit is
// constant and the query stays parameter-free for project + band.
function budgetMilestoneWindowClause(period: BudgetPeriod): string {
  // `total` is the lifetime cap (no clause); the rest are calendar-anchored.
  const trunc: Record<Exclude<BudgetPeriod, "total">, string> = {
    monthly: "month",
    quarterly: "quarter",
    annual: "year",
  };
  return period === "total" ? "" : ` AND ts >= date_trunc('${trunc[period]}', now())`;
}
