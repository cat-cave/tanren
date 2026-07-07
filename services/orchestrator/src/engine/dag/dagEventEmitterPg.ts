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
import { createLogger } from "../observability/logger.js";
import type { ConfigCorruptInput, DagEventEmitter } from "./walkerPg.js";

const log = createLogger("dag-event-emitter");

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

  private async withScopedStore(
    projectId: string,
    eventKind: string,
    work: (store: EventStore, orgId: string) => Promise<void>,
  ): Promise<void> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) {
      // OBSERVABILITY GAP FIX (task #38, follow-up to PR #753 budget fails-closed):
      // this branch used to silently return when the project row was missing or its
      // org_id was NULL — the fail-closed `dag.budget.paused` (or any other dag.*)
      // event was dropped so the operator could not see WHY the walker halted
      // without grepping engine logs. The safety invariant still held (walker
      // returned `budget_paused`, subscriber short-circuited), but the reason
      // was invisible from the events timeline. Fail LOUD instead: log at ERROR
      // with the projectId + event kind + reason so an operator has a grep-able
      // signal in the log stream. We do NOT durably append the event under a
      // synthesized org (events.org_id is NOT NULL + FK-tied to organizations —
      // see jobReaper.ts's v68-fix rationale: never fake tenancy to satisfy a
      // NOT NULL). The deeper option-1 fix (nullable events.org_id + system-scoped
      // emergency append) is out of scope for an observability-only follow-up.
      log.error("dag event DROPPED — project org unresolvable", {
        projectId,
        eventKind,
        reason: "unresolvable_project_org",
      });
      return;
    }
    // Plane-split: when a writer is wired, route the append through the control plane — the
    // writer's `append` resolves the run's org from the ambient per-job org-id, so set it for
    // the duration of the append. Absent, append in-process under a short org scope.
    if (this.runStateWriter !== undefined) {
      const writer = this.runStateWriter;
      await runWithJobOrgId(orgId, () => work(writer, orgId));
      return;
    }
    await runWithOrgScope(this.pool, orgId, (client) => work(new PgEventStore(client), orgId));
  }

  async emitSpecEnqueued(input: {
    projectId: string;
    specId: string;
    runId: string;
    satisfiedDependsOn: string[];
    inFlightBefore: number;
    concurrencyCeiling: number;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, "dag.spec.enqueued", (store, orgId) =>
      store.append({
        runId: input.runId,
        specId: input.specId,
        projectId: input.projectId,
        orgId,
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
    await this.withScopedStore(input.projectId, "dag.spec.speculative", (store, orgId) =>
      store.append({
        runId: input.runId,
        specId: input.specId,
        projectId: input.projectId,
        orgId,
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
    await this.withScopedStore(input.projectId, "dag.spec.speculation_held", (store, orgId) =>
      store.append({
        specId: input.specId,
        projectId: input.projectId,
        orgId,
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
    await this.withScopedStore(input.projectId, "dag.spec.ancestor_not_ready", (store, orgId) =>
      store.append({
        specId: input.specId,
        projectId: input.projectId,
        orgId,
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
    await this.withScopedStore(input.projectId, "dag.drained", (store, orgId) =>
      store.append({
        projectId: input.projectId,
        orgId,
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
    reason?: "unpriced_spend" | "unparseable_config" | "unresolvable_project_org";
  }): Promise<void> {
    const { projectId, ceilingUsd, spentUsd, period, readyHeldBack, reason } = input;
    await this.withScopedStore(projectId, "dag.budget.paused", (store, orgId) =>
      store.append({
        projectId,
        orgId,
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
    if (orgId === null) {
      // Same observability-gap fail-loud posture as {@link withScopedStore} above
      // (task #38 follow-up to PR #753). A null-org project row here silently
      // suppressed the 50% / 80% milestone ping; log at ERROR with the projectId
      // + event kind + reason so an operator has a grep-able signal (the milestone
      // event still cannot land — events.org_id is NOT NULL).
      log.error("dag event DROPPED — project org unresolvable", {
        projectId: input.projectId,
        eventKind: "dag.budget.milestone",
        reason: "unresolvable_project_org",
      });
      return false;
    }
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
          orgId,
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
    await this.withScopedStore(input.projectId, "dag.concurrency.saturated", (store, orgId) =>
      store.append({
        projectId: input.projectId,
        orgId,
        eventType: "dag.concurrency.saturated",
        payload: { readyHeldBack, inFlightCount, concurrencyCeiling },
      }),
    );
  }

  async emitConfigCorrupt({ projectId, ...payload }: ConfigCorruptInput): Promise<void> {
    await this.withScopedStore(projectId, "dag.config.corrupt", (store, orgId) =>
      store.append({ projectId, orgId, eventType: "dag.config.corrupt", payload }),
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
