// bh-15 — the locked behavior-context loader. Before ANY resolution stage
// (baseline, production, counterfactual, soak) probes, previews, replays, or
// soaks, this resolver pins the EXACT behavior/persona revision set bound to the
// release under verification and loads each revision WHOLE — its immutable
// Given/When/Then body (via `PgBehaviorRevisionStore`) and its executable
// acceptance plan (via `PgAcceptancePlanLoader`). The result is one immutable
// `RuntimeBehaviorContext` whose canonical `contextDigest` is stored beside every
// stage in the verification-run facts.
//
// It is deliberately fail-CLOSED: it binds the revision id that the release
// froze — NEVER the latest lineage head — and if the bound set is empty, a bound
// revision no longer resolves, or its acceptance no longer compiles, it raises a
// typed `LockedBehaviorContextError`. The walker then settles the job
// inconclusive/stale_contract WITHOUT running the probe, the ResolutionAuthority,
// or the source-close outbox — no stage ever runs with an empty, latest, or
// substituted behavior.

import { runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import type pg from "pg";
import { canonicalJson, type CanonicalBody } from "../../contracts/cas.js";
import { parseBehaviorRevisionId, type BehaviorRevisionId } from "../../contracts/behaviorRevision.js";
import type {
  LockedBehaviorRevision,
  ResolutionJob,
  ResolutionStageResult,
  RuntimeBehaviorContext,
} from "../../contracts/resolutionStage.js";
import { PgBehaviorRevisionStore } from "../../repositories/behaviorRevisionStore.js";
import { PgAcceptancePlanLoader, type AcceptancePlanLoader } from "../acceptance/pgAcceptancePlanLoader.js";

export type LockedBehaviorContextReason =
  | "missing_release"
  | "empty_binding"
  | "unresolved_revision"
  | "acceptance_unresolved";

/**
 * The bound behavior context could not be locked. Every reason is fail-closed;
 * `classification` distinguishes a transient gap (`inconclusive`, retryable —
 * no live release yet) from a durable contract/deployment drift (`stale_contract`,
 * terminal — a bound behavior is gone, substituted, or no longer executable).
 */
export class LockedBehaviorContextError extends Error {
  public override readonly name = "LockedBehaviorContextError";

  public readonly reason: LockedBehaviorContextReason;
  public readonly classification: "inconclusive" | "stale_contract";

  public constructor(reason: LockedBehaviorContextReason, detail: string) {
    super(`locked behavior context unavailable (${reason}): ${detail}`);
    this.reason = reason;
    this.classification = reason === "missing_release" ? "inconclusive" : "stale_contract";
  }
}

export interface RuntimeBehaviorContextLoader {
  load(job: ResolutionJob): Promise<RuntimeBehaviorContext>;
}

export interface PgRuntimeBehaviorContextLoaderDeps {
  readonly pool: pg.Pool;
  /** The real acceptance-plan loader by default; injected only for isolated unit cover. */
  readonly planLoader?: AcceptancePlanLoader;
}

/**
 * Produce a fail-closed `ResolutionStageResult` for a locked-context failure so a
 * caller settles the job terminally (or retryably) WITHOUT invoking the stage.
 */
export function lockedBehaviorContextFailureResult(error: LockedBehaviorContextError): ResolutionStageResult {
  const shared = {
    proofGrade: "attested" as const,
    verificationRunId: `locked_context_${error.reason}`,
    assertionIds: [] as string[],
    evidenceRefs: [] as string[],
  };
  if (error.classification === "stale_contract") {
    return { ...shared, outcome: "failed", classification: "stale_contract" };
  }
  return { ...shared, outcome: "inconclusive", classification: "inconclusive" };
}

/** Read a locked behavior context off a stage `ctx`, or `undefined` when none is present. */
export function readRuntimeBehaviorContext(ctx: unknown): RuntimeBehaviorContext | undefined {
  if (ctx === null || typeof ctx !== "object") return undefined;
  const candidate = (ctx as { readonly behaviorContext?: unknown }).behaviorContext;
  if (candidate === null || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  if (typeof record["contextDigest"] !== "string" || !Array.isArray(record["behaviors"])) return undefined;
  return candidate as RuntimeBehaviorContext;
}

export class PgRuntimeBehaviorContextLoader implements RuntimeBehaviorContextLoader {
  private readonly pool: pg.Pool;
  private readonly planLoader: AcceptancePlanLoader;

  public constructor(deps: PgRuntimeBehaviorContextLoaderDeps) {
    this.pool = deps.pool;
    this.planLoader = deps.planLoader ?? new PgAcceptancePlanLoader(deps.pool);
  }

  public async load(job: ResolutionJob): Promise<RuntimeBehaviorContext> {
    const { releaseInstanceId, artifactDigest, behaviors } = await runWithOrgScope(
      this.pool,
      job.orgId,
      async (client) => {
        const resolvedReleaseId = await this.resolveReleaseInstanceId(client, job);
        const artifact = await this.readReleaseArtifact(client, job.orgId, resolvedReleaseId);
        const bound = await readBoundRevisions(client, job.orgId, resolvedReleaseId);
        return { releaseInstanceId: resolvedReleaseId, artifactDigest: artifact, behaviors: bound };
      },
    );

    // Load each bound revision's executable acceptance plan on the plan loader's
    // own org-scoped transactions (outside the read above). A revision whose
    // acceptance no longer compiles fails the whole lock — never a partial plan set.
    const behaviorRevisionIds = behaviors.map((behavior) => behavior.behaviorRevisionId);
    const planByRevision = await this.loadAcceptancePlans(job.orgId, behaviorRevisionIds);

    const locked: LockedBehaviorRevision[] = behaviors.map((behavior) => {
      const acceptancePlanId = planByRevision.get(behavior.behaviorRevisionId);
      if (acceptancePlanId === undefined) {
        throw new LockedBehaviorContextError(
          "acceptance_unresolved",
          `bound behavior ${behavior.behaviorRevisionId} produced no acceptance plan`,
        );
      }
      return { ...behavior, acceptancePlanId };
    });

    const personaRevisionIds = [...new Set(locked.map((behavior) => behavior.personaRevisionId))].sort();
    return {
      contractId: job.contractId,
      issueLoopId: job.issueLoopId,
      releaseInstanceId,
      artifactDigest,
      behaviors: locked,
      personaRevisionIds,
      contextDigest: contextDigest(releaseInstanceId, artifactDigest, locked),
    };
  }

  private async resolveReleaseInstanceId(client: pg.PoolClient, job: ResolutionJob): Promise<string> {
    if (job.releaseInstanceId !== undefined) return job.releaseInstanceId;
    const result = await client.query<{ id: unknown }>(
      `SELECT id
         FROM release_instances
        WHERE org_id = $1 AND project_id = $2 AND environment = 'production' AND state = 'live'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [job.orgId, job.projectId],
    );
    const id = result.rows[0]?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new LockedBehaviorContextError("missing_release", `no live production release for job ${job.id}`);
    }
    return id;
  }

  private async readReleaseArtifact(client: pg.PoolClient, orgId: string, releaseInstanceId: string): Promise<string> {
    const result = await client.query<{ artifact_digest: unknown }>(
      `SELECT artifact_digest FROM release_instances WHERE org_id = $1 AND id = $2`,
      [orgId, releaseInstanceId],
    );
    const digest = result.rows[0]?.artifact_digest;
    if (typeof digest !== "string" || digest.length === 0) {
      throw new LockedBehaviorContextError("missing_release", `release ${releaseInstanceId} is not resolvable`);
    }
    return digest;
  }

  private async loadAcceptancePlans(
    orgId: string,
    behaviorRevisionIds: readonly string[],
  ): Promise<Map<string, string>> {
    let plans;
    try {
      plans = await this.planLoader.loadPlans({ orgId, behaviorRevisionIds });
    } catch (error) {
      throw new LockedBehaviorContextError("acceptance_unresolved", asMessage(error));
    }
    const byRevision = new Map<string, string>();
    for (const plan of plans) byRevision.set(plan.behaviorRevisionId, plan.planId);
    return byRevision;
  }
}

/**
 * Read the ORDERED behavior revisions the release froze, each loaded WHOLE via
 * `PgBehaviorRevisionStore` — the immutable bound revision, never the lineage
 * head. An empty binding, or a bound id that no longer resolves, fails closed
 * rather than substituting a smaller/wrong behavior set (a vacuous-truth
 * fail-open).
 */
async function readBoundRevisions(
  client: pg.PoolClient,
  orgId: string,
  releaseInstanceId: string,
): Promise<Omit<LockedBehaviorRevision, "acceptancePlanId">[]> {
  const bindings = await client.query<{ behavior_revision_id: unknown; ordinal: unknown }>(
    `SELECT behavior_revision_id, ordinal
       FROM release_instance_behavior_revisions
      WHERE org_id = $1 AND release_instance_id = $2
      ORDER BY ordinal ASC`,
    [orgId, releaseInstanceId],
  );
  if (bindings.rows.length === 0) {
    throw new LockedBehaviorContextError("empty_binding", `release ${releaseInstanceId} binds no behavior revisions`);
  }
  const store = new PgBehaviorRevisionStore(client);
  const bound: Omit<LockedBehaviorRevision, "acceptancePlanId">[] = [];
  for (const row of bindings.rows) {
    const boundId = requireText(row.behavior_revision_id, "behavior_revision_id");
    const ordinal = requireInt(row.ordinal, "ordinal");
    const behaviorRevisionId: BehaviorRevisionId = parseBehaviorRevisionId(boundId);
    const revision = await store.getById(orgId, behaviorRevisionId);
    if (revision === undefined) {
      throw new LockedBehaviorContextError(
        "unresolved_revision",
        `bound behavior revision ${boundId} on release ${releaseInstanceId} does not resolve`,
      );
    }
    /* eslint-disable unicorn/no-thenable */
    // `then` is the immutable BDD Given/When/Then field, not a thenable.
    bound.push({
      behaviorRevisionId: revision.id,
      behaviorId: revision.behaviorId,
      personaRevisionId: revision.personaRevisionId,
      ordinal,
      title: revision.title,
      given: revision.given,
      when: revision.when,
      then: revision.then,
      contentDigest: revision.contentDigest,
    });
    /* eslint-enable unicorn/no-thenable */
  }
  return bound;
}

/**
 * Canonical identity of the locked context: the ORDERED bound revisions by their
 * IMMUTABLE content digests (which already fold Given/When/Then + acceptance),
 * persona binding, ordinal, and acceptance plan id, plus the release artifact.
 * Deliberately independent of the mutable lineage head, so a later revision to a
 * behavior never shifts a frozen resolution's digest.
 */
function contextDigest(
  releaseInstanceId: string,
  artifactDigest: string,
  behaviors: readonly LockedBehaviorRevision[],
): string {
  const body: CanonicalBody = {
    v: "runtime_behavior_context.v1",
    releaseInstanceId,
    artifactDigest,
    behaviors: behaviors.map((behavior) => ({
      behaviorRevisionId: behavior.behaviorRevisionId,
      behaviorId: behavior.behaviorId,
      personaRevisionId: behavior.personaRevisionId,
      ordinal: behavior.ordinal,
      contentDigest: behavior.contentDigest,
      acceptancePlanId: behavior.acceptancePlanId,
    })),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LockedBehaviorContextError("unresolved_revision", `bound revision ${field} is not a non-empty string`);
  }
  return value;
}

function requireInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new LockedBehaviorContextError("unresolved_revision", `bound revision ${field} is not an integer`);
  }
  return value;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
