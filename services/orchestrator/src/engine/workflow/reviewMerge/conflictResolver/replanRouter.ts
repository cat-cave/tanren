// The replan router (autonomy-engine.md §2b — "intent stays alive"). On an
// irreconcilable conflict (or a resolution that fails its re-gate), ONE spec is
// routed back to the planner with the OTHER spec's change as new context — so
// the intent is RE-PLANNED, never silently dropped or merged.
//
// Production wiring: it sets the routed spec's status back to a status that can
// be re-planned (`in_flight`, the same state a review-rework re-entry uses) so the spec
// is alive for a fresh planner pass, and records the new planning context as an
// inspectable event the next planner pass reads. It routes the status write
// through the run-state writer when wired (remote control plane) and otherwise
// runs the in-process org-scoped UPDATE — the same dual path setSpecStatus uses.

import type pg from "pg";
import type { RunStateWriter } from "../../../contracts/runStateWriter.js";
import type { EventStore } from "../../../eventStore.js";
import type { ReplanRouter } from "../../../contracts/conflictResolution.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface SpecStatusReplanRouterDeps {
  pool: QueryClient;
  runStateWriter?: RunStateWriter;
  orgId?: string;
  eventStore: EventStore;
  runId: string;
  projectId: string;
  /** The status a routed-back spec returns to so it can be re-planned (default `in_flight`). */
  replanStatus?: string;
}

export class SpecStatusReplanRouter implements ReplanRouter {
  constructor(private readonly deps: SpecStatusReplanRouterDeps) {}

  async routeBackToPlanner(input: { specId: string; newContext: string; otherSpecId?: string }): Promise<void> {
    const status = this.deps.replanStatus ?? "in_flight";
    if (this.deps.runStateWriter !== undefined && this.deps.orgId !== undefined) {
      await this.deps.runStateWriter.setSpecStatus({ specId: input.specId, orgId: this.deps.orgId, status });
    } else {
      await this.deps.pool.query("UPDATE specs SET status = $2 WHERE spec_id = $1", [input.specId, status]);
    }
    // Record the new planning context so the next planner pass re-plans the spec
    // ON TOP of the other's change — the durable carrier that keeps intent alive.
    await this.deps.eventStore.append({
      runId: this.deps.runId,
      specId: input.specId,
      projectId: this.deps.projectId,
      eventType: "merge.conflict.replan_routed",
      payload: {
        specId: input.specId,
        ...(input.otherSpecId !== undefined && { otherSpecId: input.otherSpecId }),
        newContext: input.newContext,
        replanStatus: status,
      },
    });
  }
}
