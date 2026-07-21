// The durable stage-confirmation signal PORT for the delivery DAG.
//
// The delivery DAG REUSES the existing idempotent post-merge effect seams — the
// `DeployOnMergeWatcher` (materialize → prove → attach → trigger → verify) and the
// `DemoOnDeployWatcher` (establish Given → perform When → observe Then) — rather than
// reinventing their careful gating. Those watchers write an append-only, org-scoped TRAIL
// of terminal + progress events. This port reads that durable trail (plus the project's
// provisioned secret refs) so each delivery stage CONFIRMS its specific external effect
// from OBSERVED state, never from an assumption.
//
// It is an INTERFACE so the stage executors are unit-testable with a fake; the production
// `PgDeliverySignals` is the ONLY delivery-stage collaborator that touches the DB directly.
// All reads are org-/system-scoped and only ever read the run's OWN events + the project's
// OWN rows.

import { runWithSystemScope, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { DeliveryLineage } from "./stageModel.js";

/** How far the deploy cluster (materialize → attach → deploy → verify) durably reached. */
export type DeployReach = "none" | "expected" | "attached" | "triggered" | "verified";

/** How far the demo/A3 cluster (stimulate → observe) durably reached. */
export type DemoReach = "none" | "expected" | "failed" | "observed";

export interface DeliverySignals {
  /** The durably-observed reach of the deploy cluster (folds a pre-event materialize throw). */
  deployReach(lineage: DeliveryLineage, runnerThrew: boolean): Promise<DeployReach>;
  /** The durably-observed reach of the demo/A3 cluster given the deploy reach. */
  demoReach(lineage: DeliveryLineage, deployReach: DeployReach): Promise<DemoReach>;
  /** Exact release-required A3 requirement set and the subset with positive, bound provider evidence. */
  releaseRequiredA3Count(
    lineage: DeliveryLineage,
    deliveryRunId: string,
  ): Promise<{ required: number; confirmed: number }>;
  /** The project's provisioned PRODUCTION secret refs (what an activation lease scopes over). */
  provisionedProductionSecretRefs(lineage: DeliveryLineage): Promise<string[]>;
  /** The verified deployment's provider handle, when a deploy verified. */
  verifiedDeploymentId(lineage: DeliveryLineage): Promise<string | undefined>;
  /** Whether a `delivery.completed` was already appended for this run (resume idempotency). */
  deliveryCompletedExists(lineage: DeliveryLineage): Promise<boolean>;
  /** Whether a TERMINAL demo event (`demo.completed` OR `demo.failed`) exists — the demo effect committed. */
  demoTerminalExists(lineage: DeliveryLineage): Promise<boolean>;
  /**
   * Whether a demo fire-intent (`delivery.demo_stimulus_started`) exists — recorded as the
   * LAST step before the (non-idempotent) demo effect is dispatched. Present WITHOUT a
   * terminal demo event ⇒ the effect MAY have dispatched ⇒ never re-fire (degrade). Absent ⇒
   * the effect never fired ⇒ safe to fire.
   */
  demoStimulusIntentExists(lineage: DeliveryLineage): Promise<boolean>;
}

const DEPLOY_TRAIL_EVENTS = [
  "deploy.verified",
  "deploy.triggered",
  "deploy.failed",
  "deploy.skipped",
  "app_env.runtime_attached",
] as const;

const DEMO_TRAIL_EVENTS = ["demo.completed", "demo.failed"] as const;

async function presentEventTypes(
  client: Pick<pg.PoolClient, "query">,
  lineage: DeliveryLineage,
  eventTypes: readonly string[],
): Promise<Set<string>> {
  const result = await client.query<{ event_type: string }>(
    `SELECT DISTINCT event_type FROM events
      WHERE run_id = $1 AND org_id = $2 AND project_id = $3 AND event_type = ANY($4::text[])`,
    [lineage.runId, lineage.orgId, lineage.projectId, [...eventTypes]],
  );
  return new Set(result.rows.map((row) => row.event_type));
}

/** The production, DB-backed delivery-signal reader. */
export class PgDeliverySignals implements DeliverySignals {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * `runnerThrew` folds in a materialize/proof-phase throw that fails BEFORE any deploy
   * event is written (e.g. the in-15 appEnvHash proof gate blocking fail-closed): a deploy
   * was EXPECTED but did not even attach, so it is `expected`, not `none`.
   */
  async deployReach(lineage: DeliveryLineage, runnerThrew: boolean): Promise<DeployReach> {
    const present = await runWithSystemScope(this.pool, (client) =>
      presentEventTypes(client, lineage, DEPLOY_TRAIL_EVENTS),
    );
    if (present.has("deploy.verified")) return "verified";
    if (present.has("deploy.triggered")) return "triggered";
    if (present.has("app_env.runtime_attached")) return "attached";
    if (present.has("deploy.failed") || present.has("deploy.skipped") || runnerThrew) return "expected";
    return "none";
  }

  /**
   * `none` when there is no verified deploy (nothing live to observe → a legitimate no-op);
   * `observed` on `demo.completed` (the independent live exercise recorded per-behavior
   * evidence — the A3 Then); `failed` on `demo.failed` (the stimulus ran but the effect was
   * NOT confirmed); `expected` when the deploy verified but no demo terminal exists yet.
   */
  async demoReach(lineage: DeliveryLineage, deployReach: DeployReach): Promise<DemoReach> {
    if (deployReach !== "verified") return "none";
    const present = await runWithSystemScope(this.pool, (client) =>
      presentEventTypes(client, lineage, DEMO_TRAIL_EVENTS),
    );
    if (present.has("demo.completed")) return "observed";
    if (present.has("demo.failed")) return "failed";
    return "expected";
  }

  /**
   * Positive A3 evidence only: every release-required requirement must have one
   * sealed binding generation, a post-merge passed behavior verdict, and a
   * `behavior.effect.observed` event carrying that SAME behavior + binding generation.
   * Empty/missing/extra evidence therefore never completes a delivery.
   */
  async releaseRequiredA3Count(
    lineage: DeliveryLineage,
    deliveryRunId: string,
  ): Promise<{ required: number; confirmed: number }> {
    const result = await runWithSystemScope(this.pool, (client) =>
      client.query<{ required: string; confirmed: string }>(
        `WITH required_requirements AS (
           SELECT id FROM integration_requirements
            WHERE org_id = $1 AND project_id = $2 AND plane = 'product'
              AND status = 'active' AND criticality = 'release_required'
         ), confirmed_requirements AS (
           SELECT DISTINCT r.id
             FROM required_requirements r
             JOIN delivery_run_bindings drb
               ON drb.org_id = $1 AND drb.project_id = $2 AND drb.delivery_run_id = $4
             JOIN integration_binding_generations g
               ON g.org_id = drb.org_id AND g.project_id = drb.project_id
              AND g.binding_id = drb.binding_id AND g.generation = drb.binding_generation
              AND g.requirement_id = r.id
             JOIN behavior_integration_requirements bir
               ON bir.org_id = $1 AND bir.project_id = $2 AND bir.requirement_id = r.id
              AND bir.relation_role = 'requires'
             JOIN behavior_verification_runs vr
               ON vr.org_id = $1 AND vr.project_id = $2 AND vr.run_id = $3
              AND vr.purpose = 'post_merge_production' AND vr.status = 'completed'
             JOIN behavior_verdicts v
               ON v.org_id = vr.org_id AND v.project_id = vr.project_id AND v.run_id = vr.id
              AND v.behavior_revision_id = bir.behavior_revision_id AND v.outcome = 'passed'
             JOIN events e
               ON e.org_id = $1 AND e.project_id = $2 AND e.run_id = $3
              AND e.event_type = 'behavior.effect.observed'
              AND e.payload->>'behaviorRevisionId' = bir.behavior_revision_id
              AND e.payload->>'shardId' = ('a3:' || g.binding_id || ':' || g.generation::text)
         )
         SELECT (SELECT count(*)::text FROM required_requirements) AS required,
                (SELECT count(*)::text FROM confirmed_requirements) AS confirmed`,
        [lineage.orgId, lineage.projectId, lineage.runId, deliveryRunId],
      ),
    );
    const row = result.rows[0];
    if (row === undefined || !/^[0-9]+$/u.test(row.required) || !/^[0-9]+$/u.test(row.confirmed)) {
      throw new Error("release-required A3 evidence count is unreadable");
    }
    return { required: Number(row.required), confirmed: Number(row.confirmed) };
  }

  async provisionedProductionSecretRefs(lineage: DeliveryLineage): Promise<string[]> {
    return runWithOrgScope(this.pool, lineage.orgId, (client) =>
      client
        .query<{ value_ref: string }>(
          `SELECT DISTINCT value_ref FROM project_app_env
            WHERE org_id = $1 AND project_id = $2 AND environment = 'production'
              AND source = 'provisioned' AND value_ref IS NOT NULL`,
          [lineage.orgId, lineage.projectId],
        )
        .then((r) => r.rows.map((row) => row.value_ref)),
    );
  }

  async verifiedDeploymentId(lineage: DeliveryLineage): Promise<string | undefined> {
    const result = await runWithSystemScope(this.pool, (client) =>
      client.query<{ payload: unknown }>(
        `SELECT payload FROM events WHERE run_id = $1 AND org_id = $2 AND project_id = $3
           AND event_type = 'deploy.verified' ORDER BY ts DESC, id DESC LIMIT 1`,
        [lineage.runId, lineage.orgId, lineage.projectId],
      ),
    );
    const payload = result.rows[0]?.payload;
    if (typeof payload !== "object" || payload === null) return undefined;
    const id = (payload as Record<string, unknown>)["deploymentId"];
    return typeof id === "string" && id.trim() !== "" ? id : undefined;
  }

  async deliveryCompletedExists(lineage: DeliveryLineage): Promise<boolean> {
    const result = await runWithSystemScope(this.pool, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM events WHERE run_id = $1 AND org_id = $2 AND project_id = $3
           AND event_type = 'delivery.completed' LIMIT 1`,
        [lineage.runId, lineage.orgId, lineage.projectId],
      ),
    );
    return result.rows[0] !== undefined;
  }

  async demoTerminalExists(lineage: DeliveryLineage): Promise<boolean> {
    const present = await runWithSystemScope(this.pool, (client) =>
      presentEventTypes(client, lineage, DEMO_TRAIL_EVENTS),
    );
    return present.has("demo.completed") || present.has("demo.failed");
  }

  async demoStimulusIntentExists(lineage: DeliveryLineage): Promise<boolean> {
    const result = await runWithSystemScope(this.pool, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM events WHERE run_id = $1 AND org_id = $2 AND project_id = $3
           AND event_type = 'delivery.demo_stimulus_started' LIMIT 1`,
        [lineage.runId, lineage.orgId, lineage.projectId],
      ),
    );
    return result.rows[0] !== undefined;
  }
}
