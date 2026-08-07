// Release-instance persistence is separated from its state/input contract so the
// deployment lifecycle types remain usable without loading the SQL store.
import { parseBehaviorRevisionId } from "../contracts/behaviorRevision.js";
import { parseDigest, parseProviderChecksum } from "../contracts/cas.js";
import type { ReleaseInstanceRecord } from "../contracts/deployAdapter.js";
import { ensureReleaseArtifact } from "./releaseInstanceArtifacts.js";
import {
  ReleaseEnvironmentValue,
  ReleaseInstanceNotFoundError,
  ReleaseStateValue,
  RELEASE_COLUMNS,
  VALID_TRANSITIONS,
  InvalidReleaseStateTransitionError,
  type CreateReleaseInstanceInput,
  type GetReleaseInstanceByDeploymentInput,
  type MarkLiveReleaseInput,
  type PromoteReleaseInput,
  type QueryClient,
  type RawReleaseInstanceRow,
  type RollbackReleaseInput,
  type SupersedePriorLiveInput,
  type TeardownPreviewInput,
  type TransitionReleaseInstanceInput,
} from "./releaseInstanceContracts.js";
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`release_instances: invalid ${field}`);
  return value;
}
function isoDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("release_instances: invalid created_at");
  return date.toISOString();
}
function decodeReleaseInstance(row: RawReleaseInstanceRow): ReleaseInstanceRecord {
  const behaviorRevisionIds = row.behavior_revision_ids;
  if (!Array.isArray(behaviorRevisionIds)) throw new Error("release_instances: invalid behavior_revision_ids");
  const providerChecksum =
    row.provider_checksum === null ? null : parseProviderChecksum(text(row.provider_checksum, "provider_checksum"));
  return {
    releaseInstanceId: text(row.id, "id"),
    orgId: text(row.org_id, "org_id"),
    projectId: text(row.project_id, "project_id"),
    provider: text(row.provider, "provider"),
    appId: text(row.app_id, "app_id"),
    environment: ReleaseEnvironmentValue.parse(text(row.environment, "environment")),
    deploymentId: text(row.deployment_id, "deployment_id"),
    sourceRef: text(row.source_ref, "source_ref"),
    artifactDigest: parseDigest(text(row.artifact_digest, "artifact_digest")),
    providerChecksum,
    integrationNodeId: text(row.integration_node_id, "integration_node_id"),
    behaviorRevisionIds: behaviorRevisionIds.map((id) => parseBehaviorRevisionId(text(id, "behavior_revision_id"))),
    url: typeof row.url === "string" ? row.url : "",
    region: row.region === null ? null : text(row.region, "region"),
    previousReleaseInstanceId:
      row.previous_release_instance_id === null
        ? null
        : text(row.previous_release_instance_id, "previous_release_instance_id"),
    state: ReleaseStateValue.parse(text(row.state, "state")),
    createdAt: isoDate(row.created_at),
  };
}
async function getById(
  client: QueryClient,
  orgId: string,
  releaseInstanceId: string,
): Promise<ReleaseInstanceRecord | undefined> {
  const result = await client.query<RawReleaseInstanceRow>(
    `SELECT ${RELEASE_COLUMNS}
       FROM release_instances ri
       LEFT JOIN release_instance_behavior_revisions rbr
         ON rbr.org_id = ri.org_id AND rbr.release_instance_id = ri.id
      WHERE ri.org_id = $1 AND ri.id = $2
      GROUP BY ri.org_id, ri.id`,
    [orgId, releaseInstanceId],
  );
  return result.rows[0] === undefined ? undefined : decodeReleaseInstance(result.rows[0]);
}
async function findByDeployment(
  client: QueryClient,
  orgId: string,
  provider: string,
  appId: string,
  deploymentId: string,
): Promise<ReleaseInstanceRecord | undefined> {
  const result = await client.query<RawReleaseInstanceRow>(
    `SELECT ${RELEASE_COLUMNS}
       FROM release_instances ri
       LEFT JOIN release_instance_behavior_revisions rbr
         ON rbr.org_id = ri.org_id AND rbr.release_instance_id = ri.id
      WHERE ri.org_id = $1 AND ri.provider = $2 AND ri.app_id = $3 AND ri.deployment_id = $4
      GROUP BY ri.org_id, ri.id`,
    [orgId, provider, appId, deploymentId],
  );
  return result.rows[0] === undefined ? undefined : decodeReleaseInstance(result.rows[0]);
}
async function supersedeLockedLive(
  client: QueryClient,
  input: Pick<SupersedePriorLiveInput, "orgId" | "projectId" | "releaseInstanceId"> & {
    exceptReleaseInstanceId?: string;
  },
): Promise<ReleaseInstanceRecord | undefined> {
  // The advisory lock serializes an empty-live-set race; FOR UPDATE then locks every
  // current live row before it is superseded. Both operations run inside the caller's runWithOrgScope transaction.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${input.orgId}:${input.projectId}:production`,
  ]);
  const locked = await client.query<{ id: string }>(
    `SELECT id FROM release_instances
      WHERE org_id = $1 AND project_id = $2 AND environment = 'production' AND state = 'live'
        AND ($3::text IS NULL OR id <> $3)
      ORDER BY created_at DESC, id DESC
      FOR UPDATE`,
    [input.orgId, input.projectId, input.exceptReleaseInstanceId ?? null],
  );
  const ids = locked.rows.map((row) => row.id);
  if (ids.length === 0) return undefined;
  await client.query(
    `UPDATE release_instances SET state = 'superseded'
      WHERE org_id = $1 AND id = ANY($2::text[])`,
    [input.orgId, ids],
  );
  const requested = input.releaseInstanceId;
  const priorId = requested !== undefined && requested !== null && ids.includes(requested) ? requested : ids[0]!;
  return getById(client, input.orgId, priorId);
}
export const ReleaseInstancesStore = {
  async create(client: QueryClient, input: CreateReleaseInstanceInput): Promise<ReleaseInstanceRecord> {
    const releaseInstanceId = input.releaseInstanceId ?? input.deploymentId;
    await ensureReleaseArtifact(client, input);
    await client.query(
      `INSERT INTO release_instances
         (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref,
          artifact_digest, provider_checksum, integration_node_id, url, region,
          previous_release_instance_id, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (org_id, provider, app_id, deployment_id) DO NOTHING`,
      [
        input.orgId,
        releaseInstanceId,
        input.projectId,
        input.provider,
        input.appId,
        input.environment,
        input.deploymentId,
        input.sourceRef,
        input.artifactDigest,
        input.providerChecksum,
        input.integrationNodeId,
        input.url ?? "",
        input.region ?? null,
        input.previousReleaseInstanceId ?? null,
        input.state ?? "built",
      ],
    );
    for (const [ordinal, behaviorRevisionId] of (input.behaviorRevisionIds ?? []).entries()) {
      await client.query(
        `INSERT INTO release_instance_behavior_revisions
           (org_id, release_instance_id, behavior_revision_id, ordinal)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, release_instance_id, behavior_revision_id) DO NOTHING`,
        [input.orgId, releaseInstanceId, behaviorRevisionId, ordinal],
      );
    }
    const created = await getById(client, input.orgId, releaseInstanceId);
    if (created === undefined) throw new ReleaseInstanceNotFoundError(releaseInstanceId);
    return created;
  },
  async getById(
    client: QueryClient,
    orgId: string,
    releaseInstanceId: string,
  ): Promise<ReleaseInstanceRecord | undefined> {
    return getById(client, orgId, releaseInstanceId);
  },
  async getByDeployment(
    client: QueryClient,
    input: GetReleaseInstanceByDeploymentInput,
  ): Promise<ReleaseInstanceRecord | undefined> {
    return findByDeployment(client, input.orgId, input.provider, input.appId, input.deploymentId);
  },
  async listForProject(client: QueryClient, orgId: string, projectId: string): Promise<ReleaseInstanceRecord[]> {
    const result = await client.query<RawReleaseInstanceRow>(
      `SELECT ${RELEASE_COLUMNS}
         FROM release_instances ri
         LEFT JOIN release_instance_behavior_revisions rbr
           ON rbr.org_id = ri.org_id AND rbr.release_instance_id = ri.id
        WHERE ri.org_id = $1 AND ri.project_id = $2
        GROUP BY ri.org_id, ri.id
        ORDER BY ri.created_at ASC, ri.id ASC`,
      [orgId, projectId],
    );
    return result.rows.map(decodeReleaseInstance);
  },
  async latestLive(
    client: QueryClient,
    orgId: string,
    projectId: string,
    provider: string,
    appId: string,
    exceptReleaseInstanceId?: string,
  ): Promise<ReleaseInstanceRecord | undefined> {
    const params: unknown[] = [orgId, projectId, provider, appId];
    const except = exceptReleaseInstanceId === undefined ? "" : " AND ri.id <> $5";
    if (exceptReleaseInstanceId !== undefined) params.push(exceptReleaseInstanceId);
    const result = await client.query<RawReleaseInstanceRow>(
      `SELECT ${RELEASE_COLUMNS}
         FROM release_instances ri
         LEFT JOIN release_instance_behavior_revisions rbr
           ON rbr.org_id = ri.org_id AND rbr.release_instance_id = ri.id
        WHERE ri.org_id = $1 AND ri.project_id = $2 AND ri.provider = $3 AND ri.app_id = $4
          AND ri.environment = 'production' AND ri.state = 'live'${except}
        GROUP BY ri.org_id, ri.id
        ORDER BY ri.created_at DESC, ri.id DESC
        LIMIT 1`,
      params,
    );
    return result.rows[0] === undefined ? undefined : decodeReleaseInstance(result.rows[0]);
  },
  async transition(client: QueryClient, input: TransitionReleaseInstanceInput): Promise<ReleaseInstanceRecord> {
    const existing = await getById(client, input.orgId, input.releaseInstanceId);
    if (existing === undefined) throw new ReleaseInstanceNotFoundError(input.releaseInstanceId);
    if (!VALID_TRANSITIONS[existing.state].includes(input.state)) {
      throw new InvalidReleaseStateTransitionError(input.releaseInstanceId, existing.state, input.state);
    }
    const assignments = ["state = $3"];
    const params: unknown[] = [input.orgId, input.releaseInstanceId, input.state];
    if (input.environment !== undefined) {
      assignments.push(`environment = $${params.length + 1}`);
      params.push(input.environment);
    }
    if (input.url !== undefined) {
      assignments.push(`url = $${params.length + 1}`);
      params.push(input.url);
    }
    if (input.previousReleaseInstanceId !== undefined) {
      assignments.push(`previous_release_instance_id = $${params.length + 1}`);
      params.push(input.previousReleaseInstanceId);
    }
    if (input.deploymentId !== undefined) {
      assignments.push(`deployment_id = $${params.length + 1}`);
      params.push(input.deploymentId);
    }
    await client.query(
      `UPDATE release_instances SET ${assignments.join(", ")}
        WHERE org_id = $1 AND id = $2`,
      params,
    );
    const transitioned = await getById(client, input.orgId, input.releaseInstanceId);
    if (transitioned === undefined) throw new ReleaseInstanceNotFoundError(input.releaseInstanceId);
    return transitioned;
  },
  async supersedePriorLive(
    client: QueryClient,
    input: SupersedePriorLiveInput,
  ): Promise<ReleaseInstanceRecord | undefined> {
    return supersedeLockedLive(client, input);
  },
  async applyPreview(client: QueryClient, input: CreateReleaseInstanceInput): Promise<ReleaseInstanceRecord> {
    const current = (await ReleaseInstancesStore.listForProject(client, input.orgId, input.projectId)).find(
      (row) =>
        row.provider === input.provider &&
        row.appId === input.appId &&
        row.artifactDigest === input.artifactDigest &&
        row.state === "built",
    );
    if (current === undefined)
      return ReleaseInstancesStore.create(client, { ...input, environment: "preview", state: "preview" });
    await ReleaseInstancesStore.transition(client, {
      orgId: input.orgId,
      releaseInstanceId: current.releaseInstanceId,
      state: "preview",
      environment: "preview",
      deploymentId: input.deploymentId,
      url: input.url,
    });
    for (const [ordinal, behaviorRevisionId] of (input.behaviorRevisionIds ?? []).entries()) {
      await client.query(
        `INSERT INTO release_instance_behavior_revisions
           (org_id, release_instance_id, behavior_revision_id, ordinal)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, release_instance_id, behavior_revision_id) DO NOTHING`,
        [input.orgId, current.releaseInstanceId, behaviorRevisionId, ordinal],
      );
    }
    return (await getById(client, input.orgId, current.releaseInstanceId))!;
  },
  async promote(client: QueryClient, input: PromoteReleaseInput): Promise<ReleaseInstanceRecord> {
    const target = await findByDeployment(client, input.orgId, input.provider, input.appId, input.deploymentId);
    if (target === undefined) throw new ReleaseInstanceNotFoundError(input.deploymentId);
    if (target.artifactDigest !== input.artifactDigest)
      throw new Error("promote artifact digest does not match release instance");
    const prior = await ReleaseInstancesStore.supersedePriorLive(client, {
      orgId: input.orgId,
      projectId: input.projectId,
      provider: input.provider,
      appId: input.appId,
      exceptReleaseInstanceId: target.releaseInstanceId,
      ...(input.previousReleaseInstanceId === null ? {} : { releaseInstanceId: input.previousReleaseInstanceId }),
    });
    await ReleaseInstancesStore.transition(client, {
      orgId: input.orgId,
      releaseInstanceId: target.releaseInstanceId,
      state: "promoting",
      environment: "production",
      url: input.url,
      previousReleaseInstanceId: prior?.releaseInstanceId ?? null,
    });
    return ReleaseInstancesStore.transition(client, {
      orgId: input.orgId,
      releaseInstanceId: target.releaseInstanceId,
      state: "live",
      environment: "production",
      deploymentId: input.promotedDeploymentId,
      url: input.url,
      previousReleaseInstanceId: prior?.releaseInstanceId ?? null,
    });
  },
  async rollback(client: QueryClient, input: RollbackReleaseInput): Promise<ReleaseInstanceRecord> {
    const target = await getById(client, input.orgId, input.releaseInstanceId);
    if (target === undefined) throw new ReleaseInstanceNotFoundError(input.releaseInstanceId);
    if (target.artifactDigest !== input.targetArtifactDigest)
      throw new Error("rollback artifact digest does not match release instance");
    await supersedeLockedLive(client, { ...input, exceptReleaseInstanceId: target.releaseInstanceId });
    return ReleaseInstancesStore.transition(client, {
      orgId: input.orgId,
      releaseInstanceId: input.releaseInstanceId,
      state: "rolled_back",
      environment: "production",
      deploymentId: input.deploymentId,
      url: input.url,
    });
  },
  async teardownPreview(client: QueryClient, input: TeardownPreviewInput): Promise<ReleaseInstanceRecord | undefined> {
    const existing = await findByDeployment(client, input.orgId, input.provider, input.appId, input.deploymentId);
    if (existing === undefined || existing.state === "torn_down") return existing;
    return ReleaseInstancesStore.transition(client, {
      orgId: input.orgId,
      releaseInstanceId: existing.releaseInstanceId,
      state: "torn_down",
    });
  },
  async markLive(client: QueryClient, input: MarkLiveReleaseInput): Promise<ReleaseInstanceRecord> {
    const target = await findByDeployment(client, input.orgId, input.provider, input.appId, input.deploymentId);
    if (target === undefined) throw new ReleaseInstanceNotFoundError(input.deploymentId);
    const prior = await ReleaseInstancesStore.supersedePriorLive(client, {
      orgId: input.orgId,
      projectId: input.projectId,
      provider: input.provider,
      appId: input.appId,
      exceptReleaseInstanceId: target.releaseInstanceId,
    });
    return ReleaseInstancesStore.transition(client, {
      orgId: input.orgId,
      releaseInstanceId: target.releaseInstanceId,
      state: target.state === "live" ? "live" : "live",
      environment: "production",
      url: input.url,
      previousReleaseInstanceId: prior?.releaseInstanceId ?? null,
    });
  },
} as const;
