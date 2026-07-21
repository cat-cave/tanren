// mq-13 production regression attribution — the causal-replay → repair-routing seam. On a
// PRODUCTION regression (after the real rollback), the delivery loop may route ONE member to
// mq-10's `PgAutonomousRepairRouter` ONLY when causal replay localizes the regression to
// EXACTLY one member run. An inconclusive / absent replay ends `needs_attention` with NO
// fabricated repair target (the doctrine: never blame a scapegoat).
//
// The `GroupCausalReplay` port is the injected causal-replay bracket (the production seam for
// rv-16b's `RegressionBisector`). The DEFAULT production impl is CONSERVATIVE + fail-closed:
// without a fully-bracketed healthy→regressed replay it returns `inconclusive`, so the loop
// ends `needs_attention` rather than routing a repair. The repair router is wired + reachable
// (the loop calls `route()` on an `attributed` result), never a fabricated invocation.

import type pg from "pg";
import { createLogger } from "../../observability/logger.js";
import { PgAutonomousRepairRouter } from "../../merge/respecRouterPg.js";
import type { EventStore } from "../../eventStore.js";
import type {
  GroupAttributionResult,
  GroupDeliveryPlan,
  GroupProduction,
  GroupRegressionAttribution,
  PriorGoodRelease,
} from "./groupDeliveryCore.js";

const log = createLogger("land-group-delivery-attribution");

/** The causal-replay localization result — a single culprit member run, or inconclusive. */
export type GroupCausalReplayResult =
  | {
      readonly kind: "localized";
      readonly runId: string;
      readonly specId: string;
      readonly findingIds: readonly string[];
      readonly reasonCodes: readonly string[];
      readonly evaluationId: string;
    }
  | { readonly kind: "inconclusive"; readonly reason: string };

/**
 * The causal-replay bracket seam. A production impl re-proves the regressed behavior across
 * the ordered candidate release window (rv-16b) and localizes the flip to ONE candidate
 * release → its integration node → the member run. Fail-closed to `inconclusive` when it
 * cannot bracket a real healthy→regressed transition.
 */
export interface GroupCausalReplay {
  localize(input: {
    plan: GroupDeliveryPlan;
    production: GroupProduction;
    priorGood: PriorGoodRelease;
  }): Promise<GroupCausalReplayResult>;
}

/**
 * The default CONSERVATIVE production causal replay: it does NOT fabricate an attribution. A
 * production regression that cannot be bracketed to a single member (the common case without a
 * live rv-16b bisection window) is `inconclusive` ⇒ the loop ends `needs_attention`. This is
 * the fail-closed default the card mandates; a fully-bracketed replay is slotted here as its
 * own node without changing the loop.
 */
export class ConservativeGroupCausalReplay implements GroupCausalReplay {
  // eslint-disable-next-line @typescript-eslint/require-await
  async localize(): Promise<GroupCausalReplayResult> {
    return {
      kind: "inconclusive",
      reason: "production regression could not be causally bracketed to a single member run (no live bisection window)",
    };
  }
}

/** Attribution that consults the causal-replay bracket and routes to mq-10 on a single-member localize. */
export class RepairRoutingGroupAttribution implements GroupRegressionAttribution {
  private readonly router: PgAutonomousRepairRouter;

  constructor(
    private readonly replay: GroupCausalReplay,
    deps: { pool: pg.Pool; events?: EventStore },
  ) {
    this.router = new PgAutonomousRepairRouter({
      pool: deps.pool,
      ...(deps.events !== undefined && { events: deps.events }),
    });
  }

  async attribute(input: {
    plan: GroupDeliveryPlan;
    production: GroupProduction;
    priorGood: PriorGoodRelease;
  }): Promise<GroupAttributionResult> {
    const localized = await this.replay.localize(input);
    if (localized.kind === "inconclusive") return { kind: "unattributed", reason: localized.reason };
    return {
      kind: "attributed",
      runId: localized.runId,
      specId: localized.specId,
      findingIds: localized.findingIds,
      reasonCodes: localized.reasonCodes,
      evaluationId: localized.evaluationId,
    };
  }

  async route(input: {
    plan: GroupDeliveryPlan;
    attributed: Extract<GroupAttributionResult, { kind: "attributed" }>;
  }): Promise<void> {
    const { plan, attributed } = input;
    const outcome = await this.router.routeMemberFailure({
      projectId: plan.projectId,
      groupId: plan.landGroupId,
      evaluationId: attributed.evaluationId,
      sourceSpecId: attributed.specId,
      runId: attributed.runId,
      classification: "deterministic_policy",
      findingIds: attributed.findingIds,
      reasonCodes: attributed.reasonCodes,
    });
    log.info("routed production regression repair", {
      landGroupId: plan.landGroupId,
      runId: attributed.runId,
      outcome: outcome.kind,
    });
  }
}
