import type { ReleaseInstanceRecord } from "../../src/engine/contracts/deployAdapter.js";
import type {
  CreateReleaseInstanceInput,
  GetReleaseInstanceByDeploymentInput,
  MarkLiveReleaseInput,
  PromoteReleaseInput,
  ReleaseInstancesRepository,
  RollbackReleaseInput,
  SupersedePriorLiveInput,
  TeardownPreviewInput,
  TransitionReleaseInstanceInput,
} from "../../src/engine/repositories/releaseInstances.js";
import { ReleaseInstanceNotFoundError } from "../../src/engine/repositories/releaseInstances.js";

/**
 * Stateful release fixture for deploy-on-merge tests. It keeps build → verify → live
 * explicit, so a resume test must seed the release created by the original build.
 */
export class DeployOnMergeReleaseInstances implements ReleaseInstancesRepository {
  private readonly rows = new Map<string, ReleaseInstanceRecord>();
  private clock = 0;

  async create(input: CreateReleaseInstanceInput): Promise<ReleaseInstanceRecord> {
    const releaseInstanceId = input.releaseInstanceId ?? input.deploymentId;
    const existing = await this.getByDeployment(input);
    if (existing !== undefined) return existing;
    const release: ReleaseInstanceRecord = {
      releaseInstanceId,
      orgId: input.orgId,
      projectId: input.projectId,
      provider: input.provider,
      appId: input.appId,
      environment: input.environment,
      deploymentId: input.deploymentId,
      sourceRef: input.sourceRef,
      artifactDigest: input.artifactDigest,
      providerChecksum: input.providerChecksum,
      integrationNodeId: input.integrationNodeId,
      behaviorRevisionIds: input.behaviorRevisionIds ?? [],
      url: input.url ?? "",
      region: input.region ?? null,
      previousReleaseInstanceId: input.previousReleaseInstanceId ?? null,
      state: input.state ?? "built",
      createdAt: new Date(++this.clock).toISOString(),
    };
    this.rows.set(releaseInstanceId, release);
    return release;
  }

  async getById(orgId: string, releaseInstanceId: string): Promise<ReleaseInstanceRecord | undefined> {
    const release = this.rows.get(releaseInstanceId);
    return release?.orgId === orgId ? release : undefined;
  }

  async getByDeployment(input: GetReleaseInstanceByDeploymentInput): Promise<ReleaseInstanceRecord | undefined> {
    return [...this.rows.values()].find(
      (release) =>
        release.orgId === input.orgId &&
        release.provider === input.provider &&
        release.appId === input.appId &&
        release.deploymentId === input.deploymentId,
    );
  }

  async listForProject(orgId: string, projectId: string): Promise<ReleaseInstanceRecord[]> {
    return [...this.rows.values()].filter((release) => release.orgId === orgId && release.projectId === projectId);
  }

  async transition(input: TransitionReleaseInstanceInput): Promise<ReleaseInstanceRecord> {
    const release = await this.getById(input.orgId, input.releaseInstanceId);
    if (release === undefined) throw new ReleaseInstanceNotFoundError(input.releaseInstanceId);
    const transitioned: ReleaseInstanceRecord = {
      ...release,
      state: input.state,
      environment: input.environment ?? release.environment,
      url: input.url ?? release.url,
      deploymentId: input.deploymentId ?? release.deploymentId,
      previousReleaseInstanceId:
        input.previousReleaseInstanceId === undefined
          ? release.previousReleaseInstanceId
          : input.previousReleaseInstanceId,
    };
    this.rows.set(release.releaseInstanceId, transitioned);
    return transitioned;
  }

  async supersedePriorLive(input: SupersedePriorLiveInput): Promise<ReleaseInstanceRecord | undefined> {
    const prior = [...this.rows.values()].filter(
      (release) =>
        release.orgId === input.orgId &&
        release.projectId === input.projectId &&
        release.environment === "production" &&
        release.state === "live" &&
        release.releaseInstanceId !== input.exceptReleaseInstanceId,
    );
    for (const release of prior) {
      await this.transition({ orgId: input.orgId, releaseInstanceId: release.releaseInstanceId, state: "superseded" });
    }
    const priorId = input.releaseInstanceId ?? prior[0]?.releaseInstanceId;
    return priorId === undefined ? undefined : this.getById(input.orgId, priorId);
  }

  async applyPreview(input: CreateReleaseInstanceInput): Promise<ReleaseInstanceRecord> {
    return this.create({ ...input, environment: "preview", state: "preview" });
  }

  async promote(input: PromoteReleaseInput): Promise<ReleaseInstanceRecord> {
    const release = await this.getByDeployment(input);
    if (release === undefined) throw new ReleaseInstanceNotFoundError(input.deploymentId);
    const prior = await this.supersedePriorLive({
      orgId: input.orgId,
      projectId: input.projectId,
      provider: input.provider,
      appId: input.appId,
      exceptReleaseInstanceId: release.releaseInstanceId,
      releaseInstanceId: input.previousReleaseInstanceId,
    });
    return this.transition({
      orgId: input.orgId,
      releaseInstanceId: release.releaseInstanceId,
      state: "live",
      environment: "production",
      deploymentId: input.promotedDeploymentId,
      url: input.url,
      previousReleaseInstanceId: prior?.releaseInstanceId ?? null,
    });
  }

  async rollback(input: RollbackReleaseInput): Promise<ReleaseInstanceRecord> {
    const release = await this.getById(input.orgId, input.releaseInstanceId);
    if (release === undefined) throw new ReleaseInstanceNotFoundError(input.releaseInstanceId);
    await this.supersedePriorLive({
      orgId: input.orgId,
      projectId: input.projectId,
      provider: release.provider,
      appId: release.appId,
      exceptReleaseInstanceId: release.releaseInstanceId,
    });
    return this.transition({
      orgId: input.orgId,
      releaseInstanceId: release.releaseInstanceId,
      state: "rolled_back",
      environment: "production",
      deploymentId: input.deploymentId,
      url: input.url,
    });
  }

  async teardownPreview(input: TeardownPreviewInput): Promise<ReleaseInstanceRecord | undefined> {
    const release = await this.getByDeployment(input);
    return release === undefined
      ? undefined
      : this.transition({ orgId: input.orgId, releaseInstanceId: release.releaseInstanceId, state: "torn_down" });
  }

  async markLive(input: MarkLiveReleaseInput): Promise<ReleaseInstanceRecord> {
    const release = await this.getByDeployment(input);
    if (release === undefined) throw new ReleaseInstanceNotFoundError(input.deploymentId);
    const prior = await this.supersedePriorLive({
      orgId: input.orgId,
      projectId: input.projectId,
      provider: input.provider,
      appId: input.appId,
      exceptReleaseInstanceId: release.releaseInstanceId,
    });
    return this.transition({
      orgId: input.orgId,
      releaseInstanceId: release.releaseInstanceId,
      state: "live",
      environment: "production",
      url: input.url,
      previousReleaseInstanceId: prior?.releaseInstanceId ?? null,
    });
  }
}
