// mq-13 deployer read/emit helpers — extracted from `groupDeliveryDeployer.ts` to keep that file
// under the line cap. Free functions over the pool + event store + probes (no `this`), so the
// deployer stays the thin orchestration + external-effect wiring.

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { BehaviorRevisionId } from "../../contracts/behaviorRevision.js";
import type { ReleaseInstanceRecord, UrlReachabilityProbe } from "../../contracts/deployAdapter.js";
import type { EventStore } from "../../eventStore.js";
import { ReleaseInstancesStore } from "../../repositories/releaseInstances.js";
import type { PgBehaviorRevisionResolver } from "../../repositories/behaviorRevisionResolver.js";
import { loadSpecBehaviors } from "../demoOnDeployReads.js";
import { deployAuditEnvelope } from "../deployOnMergeAuthority.js";
import type { GroupDeliveryPlan, PriorGoodRelease, ResolvedGroupDeployTarget } from "./groupDeliveryCore.js";

const PROBEABLE_RELEASE_STATES = new Set(["built", "preview", "promoting", "live"]);

/**
 * Build the GROUP's `deploy.verified` payload — the shape mq-15's `gatherEvidenceFromClient` and
 * ds-6's `designDeliveryProofReads` read (provider / appId / deploymentId / url / state +
 * smokeStatus + the audit envelope, bound to the LIVE production deployment). Pure so the shape is
 * unit-testable against BOTH the strict registered `DeployVerifiedPayload` and the consumers'
 * projections (Finding 2). NON-SECRET — refs + a URL + a state + a status code.
 */
export function groupDeployVerifiedPayload(
  plan: GroupDeliveryPlan,
  target: ResolvedGroupDeployTarget,
  verified: { deploymentId: string; url: string; state: string; smokeStatus: number },
) {
  return {
    provider: target.provider,
    appId: target.appId,
    deploymentId: verified.deploymentId,
    url: verified.url,
    state: verified.state,
    smokeStatus: verified.smokeStatus,
    ...deployAuditEnvelope({
      provider: target.provider,
      appId: target.appId,
      orgId: plan.orgId,
      policyVersion: target.policyVersion,
    }),
  };
}

/** Whether a `deploy.verified` already exists on the tail run (the idempotent-emit guard). */
export async function deployVerifiedExists(pool: pg.Pool, plan: GroupDeliveryPlan): Promise<boolean> {
  return runWithSystemScope(pool, async (client) => {
    const row = await client.query<{ one: number }>(
      "SELECT 1 AS one FROM events WHERE run_id = $1 AND org_id = $2 AND event_type = 'deploy.verified' LIMIT 1",
      [plan.tailRunId, plan.orgId],
    );
    return row.rows[0] !== undefined;
  });
}

/** Append the group's `deploy.verified` on the tail run (idempotent — the shape mq-15 / ds-6 read). */
export async function emitGroupDeployVerified(
  deps: { pool: pg.Pool; eventStore: EventStore },
  plan: GroupDeliveryPlan,
  target: ResolvedGroupDeployTarget,
  verified: { deploymentId: string; url: string; state: string; smokeStatus: number },
): Promise<void> {
  if (await deployVerifiedExists(deps.pool, plan)) return;
  // Under an OPEN org scope (so a pool-backed PgEventStore routes the INSERT through the ambient
  // org-scoped client and RLS admits it) + the ambient job org (so a plane-split runStateWriter
  // routes to the control plane).
  await runWithJobOrgId(plan.orgId, () =>
    runWithOrgScope(deps.pool, plan.orgId, async () => {
      await deps.eventStore.append({
        runId: plan.tailRunId,
        specId: plan.tailSpecId,
        projectId: plan.projectId,
        orgId: plan.orgId,
        eventType: "deploy.verified",
        payload: groupDeployVerifiedPayload(plan, target, verified),
      });
    }),
  );
}

/**
 * Ensure the group's `deploy.verified` is present for a committed live release (Finding B). If it is
 * missing (a prior owner committed the release then died before emitting), SMOKE-PROBE the
 * already-live URL (an honest reachability check — no markLive, no re-promote) and emit
 * `deploy.verified`, so a live group ALWAYS has its evidence regardless of which owner committed.
 */
export async function ensureGroupDeployVerified(
  deps: { pool: pg.Pool; eventStore: EventStore; urlProbe: UrlReachabilityProbe },
  plan: GroupDeliveryPlan,
  target: ResolvedGroupDeployTarget,
  release: ReleaseInstanceRecord,
): Promise<void> {
  if (await deployVerifiedExists(deps.pool, plan)) return;
  const smokeStatus = await deps.urlProbe.probe(release.url);
  await emitGroupDeployVerified(deps, plan, target, {
    deploymentId: release.deploymentId,
    url: release.url,
    state: release.state,
    smokeStatus,
  });
}

/** Find a persisted probeable release for this group's artifact + landed commit (preview OR live). */
export async function findGroupRelease(
  pool: pg.Pool,
  plan: GroupDeliveryPlan,
  target: ResolvedGroupDeployTarget,
  artifactDigest: string,
): Promise<ReleaseInstanceRecord | undefined> {
  return runWithOrgScope(pool, plan.orgId, async (client) => {
    const releases = await ReleaseInstancesStore.listForProject(client, plan.orgId, plan.projectId);
    return releases.find(
      (r) =>
        r.provider === target.provider &&
        r.appId === target.appId &&
        r.artifactDigest === artifactDigest &&
        r.sourceRef === plan.mainSha &&
        r.integrationNodeId === plan.tailRunId &&
        PROBEABLE_RELEASE_STATES.has(r.state),
    );
  });
}

/** The current LIVE production release for the group's app (prior-good candidate), excluding one. */
export async function currentLiveGroupRelease(
  pool: pg.Pool,
  plan: GroupDeliveryPlan,
  target: ResolvedGroupDeployTarget,
  exceptReleaseInstanceId?: string,
): Promise<ReleaseInstanceRecord | undefined> {
  return runWithOrgScope(pool, plan.orgId, (client) =>
    ReleaseInstancesStore.latestLive(
      client,
      plan.orgId,
      plan.projectId,
      target.provider,
      target.appId,
      exceptReleaseInstanceId,
    ),
  );
}

/**
 * Resolve the prior-good release from the DURABLE promote lineage (Finding 1): the just-promoted
 * production release records the release it SUPERSEDED as `previousReleaseInstanceId` (now state
 * `superseded` — a `latestLive` lookup would miss it). A null predecessor is a genuine no-prior-good.
 */
export async function currentPriorGoodRelease(
  pool: pg.Pool,
  plan: GroupDeliveryPlan,
  productionReleaseInstanceId: string,
): Promise<PriorGoodRelease | undefined> {
  return runWithOrgScope(pool, plan.orgId, async (client): Promise<PriorGoodRelease | undefined> => {
    const production = await ReleaseInstancesStore.getById(client, plan.orgId, productionReleaseInstanceId);
    const priorId = production?.previousReleaseInstanceId ?? null;
    if (priorId === null) return undefined;
    const prior = await ReleaseInstancesStore.getById(client, plan.orgId, priorId);
    if (prior === undefined) return undefined;
    return { releaseInstanceId: prior.releaseInstanceId, artifactDigest: prior.artifactDigest };
  });
}

/** Resolve the group's active behavior REVISION ids — the union of the member specs' behaviors. */
export async function resolveGroupBehaviorRevisionIds(
  pool: pg.Pool,
  behaviorRevisions: PgBehaviorRevisionResolver,
  plan: GroupDeliveryPlan,
): Promise<BehaviorRevisionId[]> {
  const behaviorIds = new Set<string>();
  await runWithSystemScope(pool, async (client) => {
    for (const specId of plan.memberSpecIds) {
      const behaviors = await loadSpecBehaviors(client, specId, plan.orgId, plan.projectId);
      for (const behavior of behaviors) behaviorIds.add(behavior.behaviorId);
    }
  });
  if (behaviorIds.size === 0) return [];
  const resolved = await behaviorRevisions.resolveActive({
    orgId: plan.orgId,
    projectId: plan.projectId,
    behaviorIds: [...behaviorIds],
  });
  return resolved.map((entry) => entry.revisionId);
}
