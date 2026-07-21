// mq-13 deployer read/emit helpers — extracted from `groupDeliveryDeployer.ts` to keep that file
// under the line cap. Free functions over the pool + event store + probes (no `this`), so the
// deployer stays the thin orchestration + external-effect wiring.

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { BehaviorRevisionId } from "../../contracts/behaviorRevision.js";
import type { ReleaseInstanceRecord, UrlReachabilityProbe } from "../../contracts/deployAdapter.js";
import type { EventStore } from "../../eventStore.js";
import type { ReleaseInstancesRepository } from "../../repositories/releaseInstances.js";
import { ReleaseInstancesStore } from "../../repositories/releaseInstances.js";
import type { PgBehaviorRevisionResolver } from "../../repositories/behaviorRevisionResolver.js";
import { loadSpecBehaviors } from "../demoOnDeployReads.js";
import { deployAuditEnvelope } from "../deployOnMergeAuthority.js";
import { createLogger } from "../../observability/logger.js";
import type { GroupDeliveryPlan, PriorGoodRelease, ResolvedGroupDeployTarget } from "./groupDeliveryCore.js";

const log = createLogger("land-group-delivery-deployer");

const PROBEABLE_RELEASE_STATES = new Set(["built", "preview", "promoting", "live"]);

/**
 * The SINGLE deploy-health predicate shared by the happy-path verify (`verifyReadiness`) AND the
 * recovery / no-op `deploy.verified` emit (`ensureGroupDeployVerified`), so both AGREE on what
 * "live + reachable" means. Healthy = 2xx/3xx OR a 401/403 (a running deployment fronted by an
 * auth gate — Vercel/Fly deployment protection — is up + serving). ANY other status (5xx, etc.) is
 * UNHEALTHY: `deploy.verified` must NEVER be emitted for it (mq-15 would seal a broken product on
 * false evidence).
 */
export function isHealthySmokeStatus(smokeStatus: number): boolean {
  return (smokeStatus >= 200 && smokeStatus < 400) || smokeStatus === 401 || smokeStatus === 403;
}

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

/** The group `deploy.verified` idempotency key (the `(run_id, idempotency_key)` events unique index). */
const GROUP_DEPLOY_VERIFIED_KEY = "deploy.verified";

/**
 * Append the group's `deploy.verified` on the tail run — IDEMPOTENT AT THE WRITE (Finding C): via
 * `appendPriorIfAbsent` on the `(run_id, idempotency_key)` unique index, so two concurrent no-op
 * `ensure` calls cannot double-emit (not just check-then-act). Falls back to a read-then-append for
 * a test event store without `appendPriorIfAbsent`. Runs under an OPEN org scope (a pool-backed
 * PgEventStore routes the INSERT through the ambient org-scoped client so RLS admits it) + the
 * ambient job org (a plane-split runStateWriter routes to the control plane).
 */
export async function emitGroupDeployVerified(
  deps: { pool: pg.Pool; eventStore: EventStore },
  plan: GroupDeliveryPlan,
  target: ResolvedGroupDeployTarget,
  verified: { deploymentId: string; url: string; state: string; smokeStatus: number },
): Promise<void> {
  const payload = groupDeployVerifiedPayload(plan, target, verified);
  const appendPriorIfAbsent = deps.eventStore.appendPriorIfAbsent?.bind(deps.eventStore);
  await runWithJobOrgId(plan.orgId, () =>
    runWithOrgScope(deps.pool, plan.orgId, async () => {
      if (appendPriorIfAbsent !== undefined) {
        await appendPriorIfAbsent({
          runId: plan.tailRunId,
          specId: plan.tailSpecId,
          projectId: plan.projectId,
          orgId: plan.orgId,
          eventType: "deploy.verified",
          idempotencyKey: GROUP_DEPLOY_VERIFIED_KEY,
          payload,
        });
        return;
      }
      if (await deployVerifiedExists(deps.pool, plan)) return;
      await deps.eventStore.append({
        runId: plan.tailRunId,
        specId: plan.tailSpecId,
        projectId: plan.projectId,
        orgId: plan.orgId,
        eventType: "deploy.verified",
        payload,
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
  // HEALTH GATE (Finding A): emit `deploy.verified` ONLY when the smoke probe is genuinely HEALTHY
  // — the SAME predicate the happy-path `verifyReadiness` enforces. A DB-live-but-unhealthy
  // production (5xx/etc.) must NEVER be recorded as verified (mq-15 would seal a broken product on
  // false evidence). Leave it un-emitted; a later wake retries once the production recovers.
  if (!isHealthySmokeStatus(smokeStatus)) {
    log.warn("group live release is DB-live but unhealthy — NOT emitting deploy.verified (retry next wake)", {
      landGroupId: plan.landGroupId,
      deploymentId: release.deploymentId,
      smokeStatus,
    });
    return;
  }
  await emitGroupDeployVerified(deps, plan, target, {
    deploymentId: release.deploymentId,
    url: release.url,
    state: release.state,
    smokeStatus,
  });
}

/**
 * The group's committed LIVE PRODUCTION release (for recovery, Finding A) — a live production
 * release_instances row for the group's app bound to the landed commit (`source_ref = mainSha`).
 * Not scoped by artifact/integration-node so a stranded live group is always found by its commit.
 */
export async function findGroupLiveProductionRelease(
  pool: pg.Pool,
  plan: GroupDeliveryPlan,
  target: ResolvedGroupDeployTarget,
): Promise<ReleaseInstanceRecord | undefined> {
  return runWithOrgScope(pool, plan.orgId, async (client) => {
    const releases = await ReleaseInstancesStore.listForProject(client, plan.orgId, plan.projectId);
    return releases.find(
      (r) =>
        r.provider === target.provider &&
        r.appId === target.appId &&
        r.sourceRef === plan.mainSha &&
        r.environment === "production" &&
        r.state === "live",
    );
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

/** Read back a persisted release instance by its provider deployment handle (throws if absent). */
export async function readBackGroupRelease(
  releaseInstances: ReleaseInstancesRepository,
  plan: GroupDeliveryPlan,
  target: ResolvedGroupDeployTarget,
  deploymentId: string,
): Promise<ReleaseInstanceRecord> {
  const record = await releaseInstances.getByDeployment({
    orgId: plan.orgId,
    provider: target.provider,
    appId: target.appId,
    deploymentId,
  });
  if (record === undefined) {
    throw new Error(
      `land-group delivery: no persisted release instance for deployment '${deploymentId}' on '${target.provider}/${target.appId}'`,
    );
  }
  return record;
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
