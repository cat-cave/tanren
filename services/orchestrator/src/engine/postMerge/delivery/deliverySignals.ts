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
import { a3CorrelationId } from "../../verification/acceptance/httpCauseDriver.js";
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
    return runWithSystemScope(this.pool, async (client) => {
      const [required, observed] = await Promise.all([
        client.query<ReleaseRequiredA3Row>(
          `WITH sealed_bindings AS (
             SELECT g.requirement_id, g.binding_id, g.generation AS binding_generation
               FROM delivery_run_bindings drb
               JOIN integration_binding_generations g
                 ON g.org_id = drb.org_id AND g.project_id = drb.project_id
                AND g.binding_id = drb.binding_id AND g.generation = drb.binding_generation
              WHERE drb.org_id = $1 AND drb.project_id = $2 AND drb.delivery_run_id = $4
           )
           SELECT r.id AS requirement_id, bir.behavior_revision_id, sb.binding_id, sb.binding_generation,
                  EXISTS (
                    SELECT 1
                      FROM behavior_verification_runs vr
                      JOIN behavior_verdicts v
                        ON v.org_id = vr.org_id AND v.project_id = vr.project_id AND v.run_id = vr.id
                     WHERE vr.org_id = $1 AND vr.project_id = $2 AND vr.run_id = $3
                       AND vr.purpose = 'post_merge_production' AND vr.status = 'completed'
                       AND v.behavior_revision_id = bir.behavior_revision_id AND v.outcome = 'passed'
                  ) AS passed
             FROM integration_requirements r
             LEFT JOIN behavior_integration_requirements bir
               ON bir.org_id = r.org_id AND bir.project_id = r.project_id AND bir.requirement_id = r.id
              AND bir.relation_role = 'requires'
             LEFT JOIN sealed_bindings sb ON sb.requirement_id = r.id
            WHERE r.org_id = $1 AND r.project_id = $2 AND r.plane = 'product'
              AND r.status = 'active' AND r.criticality = 'release_required'
            ORDER BY r.id, bir.behavior_revision_id, sb.binding_id, sb.binding_generation`,
          [lineage.orgId, lineage.projectId, lineage.runId, deliveryRunId],
        ),
        client.query<{ payload: unknown }>(
          `SELECT payload FROM events
            WHERE org_id = $1 AND project_id = $2 AND run_id = $3
              AND event_type = 'behavior.effect.observed'`,
          [lineage.orgId, lineage.projectId, lineage.runId],
        ),
      ]);
      return countExactReleaseRequiredA3Evidence(
        required.rows,
        observed.rows.map((row) => row.payload),
        deliveryRunId,
      );
    });
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

export interface ReleaseRequiredA3Row {
  readonly requirement_id: unknown;
  readonly behavior_revision_id: unknown;
  readonly binding_id: unknown;
  readonly binding_generation: unknown;
  readonly passed: unknown;
}

interface ReleaseRequiredA3Coordinate {
  readonly requirementId: string;
  readonly behaviorRevisionId: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
}

interface ObservedA3Effect {
  readonly behaviorRevisionId: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly deliveryRunId: string;
  readonly correlationId: string;
  readonly causeOrdinal: number;
  readonly occurrenceCount: number;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

/**
 * Count only the exact A3 multiset: one passed behavior per release-required
 * requirement/binding coordinate, and one observation for each coordinate.
 * An absent binding, an unpassed behavior, a wrong delivery/correlation, or a
 * duplicate observation leaves that coordinate unconfirmed rather than letting
 * an unrelated positive event complete the delivery.
 */
export function countExactReleaseRequiredA3Evidence(
  requiredRows: readonly ReleaseRequiredA3Row[],
  eventPayloads: readonly unknown[],
  deliveryRunId: string,
): { required: number; confirmed: number } {
  if (requiredRows.length === 0) return { required: 0, confirmed: 0 };
  const rows = requiredRows.map((row) => parseRequiredA3Row(row));
  if (rows.some((row) => row === undefined)) return { required: requiredRows.length, confirmed: 0 };
  const expected = rows as readonly (ReleaseRequiredA3Coordinate & { readonly passed: boolean })[];
  const bindingsByRequirement = new Map<string, Set<string>>();
  for (const row of expected) {
    const bindings = bindingsByRequirement.get(row.requirementId) ?? new Set<string>();
    bindings.add(`${row.bindingId}\u0000${String(row.bindingGeneration)}`);
    bindingsByRequirement.set(row.requirementId, bindings);
  }
  if ([...bindingsByRequirement.values()].some((bindings) => bindings.size !== 1)) {
    return { required: expected.length, confirmed: 0 };
  }

  const expectedByCoordinate = new Map<string, (typeof expected)[number]>();
  for (const row of expected) {
    const key = a3CoordinateKey(row);
    if (expectedByCoordinate.has(key)) return { required: expected.length, confirmed: 0 };
    expectedByCoordinate.set(key, row);
  }
  const matchingCounts = new Map<string, number>();
  for (const payload of eventPayloads) {
    const observed = parseObservedA3Effect(payload);
    if (observed === undefined || observed.deliveryRunId !== deliveryRunId || observed.occurrenceCount !== 1) continue;
    const key = a3CoordinateKey(observed);
    const expectedCoordinate = expectedByCoordinate.get(key);
    if (expectedCoordinate === undefined) continue;
    const expectedCorrelation = a3CorrelationId({
      deliveryRunId,
      behaviorRevisionId: expectedCoordinate.behaviorRevisionId,
      bindingId: expectedCoordinate.bindingId,
      bindingGeneration: expectedCoordinate.bindingGeneration,
      causeOrdinal: observed.causeOrdinal,
    });
    if (observed.correlationId !== expectedCorrelation) continue;
    matchingCounts.set(key, (matchingCounts.get(key) ?? 0) + 1);
  }
  const confirmed = expected.filter(
    (coordinate) => coordinate.passed && matchingCounts.get(a3CoordinateKey(coordinate)) === 1,
  ).length;
  return { required: expected.length, confirmed };
}

function parseRequiredA3Row(
  row: ReleaseRequiredA3Row,
): (ReleaseRequiredA3Coordinate & { readonly passed: boolean }) | undefined {
  if (
    typeof row.requirement_id !== "string" ||
    row.requirement_id === "" ||
    typeof row.behavior_revision_id !== "string" ||
    row.behavior_revision_id === "" ||
    typeof row.binding_id !== "string" ||
    row.binding_id === "" ||
    !Number.isSafeInteger(Number(row.binding_generation)) ||
    Number(row.binding_generation) < 1 ||
    typeof row.passed !== "boolean"
  ) {
    return undefined;
  }
  return {
    requirementId: row.requirement_id,
    behaviorRevisionId: row.behavior_revision_id,
    bindingId: row.binding_id,
    bindingGeneration: Number(row.binding_generation),
    passed: row.passed,
  };
}

function parseObservedA3Effect(payload: unknown): ObservedA3Effect | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const value = payload as Record<string, unknown>;
  const shard = typeof value["shardId"] === "string" ? parseA3Shard(value["shardId"]) : undefined;
  const causeOrdinal = value["causeOrdinal"];
  const occurrenceCount = value["occurrenceCount"];
  if (
    shard === undefined ||
    typeof value["behaviorRevisionId"] !== "string" ||
    typeof value["deliveryRunId"] !== "string" ||
    typeof value["correlationId"] !== "string" ||
    !DIGEST.test(value["correlationId"]) ||
    typeof causeOrdinal !== "number" ||
    !Number.isSafeInteger(causeOrdinal) ||
    causeOrdinal < 0 ||
    typeof occurrenceCount !== "number" ||
    !Number.isSafeInteger(occurrenceCount) ||
    occurrenceCount < 1
  ) {
    return undefined;
  }
  return {
    behaviorRevisionId: value["behaviorRevisionId"],
    bindingId: shard.bindingId,
    bindingGeneration: shard.bindingGeneration,
    deliveryRunId: value["deliveryRunId"],
    correlationId: value["correlationId"],
    causeOrdinal,
    occurrenceCount,
  };
}

function parseA3Shard(value: string): { bindingId: string; bindingGeneration: number } | undefined {
  const match = /^a3:([^:]+):(\d+)$/u.exec(value);
  if (match === null) return undefined;
  const [, bindingId, generation] = match;
  const bindingGeneration = Number(generation);
  return bindingId === undefined || !Number.isSafeInteger(bindingGeneration) || bindingGeneration < 1
    ? undefined
    : { bindingId, bindingGeneration };
}

function a3CoordinateKey(
  input: Pick<ObservedA3Effect, "behaviorRevisionId" | "bindingId" | "bindingGeneration">,
): string {
  return `${input.behaviorRevisionId}\u0000${input.bindingId}\u0000${String(input.bindingGeneration)}`;
}
