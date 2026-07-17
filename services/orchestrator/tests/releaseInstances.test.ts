import { describe, expect, it } from "vitest";
import { parseDigest } from "../src/engine/contracts/cas.js";
import type {
  ApplyPreviewInput,
  DeployRef,
  ReleaseInstanceRecord,
  RollbackInput,
} from "../src/engine/contracts/deployAdapter.js";
import type { BehaviorRevisionId } from "../src/engine/contracts/behaviorRevision.js";
import { DirectApiDeployAdapter } from "../src/engine/deploy/directApiDeployAdapter.js";
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
} from "../src/engine/repositories/releaseInstances.js";
import { testOrgGrant } from "./helpers/orgGrant.js";
import { scriptedDeployTransport } from "./conformance/fakes/scriptedDeployTransport.js";
import { instantVerifyPollPolicy, scriptedUrlProbe } from "./conformance/fakes/scriptedUrlProbe.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";

const ORG_ID = "org_release";
const PROJECT_ID = "project_release";
const REF: DeployRef = { provider: "deploy.vercel", appId: "vercel_app_1" };
const SOURCE = { repo: "acme/web", ref: "merge-sha" };
const ARTIFACT_DIGEST = parseDigest(`sha256:${"a".repeat(64)}`);
const BEHAVIOR_REVISION_ID = "behavior_revision_1" as BehaviorRevisionId;

class MemoryReleaseInstances implements ReleaseInstancesRepository {
  readonly rows = new Map<string, ReleaseInstanceRecord>();
  private clock = 0;

  async create(input: CreateReleaseInstanceInput): Promise<ReleaseInstanceRecord> {
    const id = input.releaseInstanceId ?? input.deploymentId;
    const existing = this.rows.get(id);
    if (existing !== undefined) return existing;
    const row: ReleaseInstanceRecord = {
      releaseInstanceId: id,
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
      behaviorRevisionIds: [...(input.behaviorRevisionIds ?? [])],
      url: input.url ?? "",
      region: input.region ?? null,
      previousReleaseInstanceId: input.previousReleaseInstanceId ?? null,
      state: input.state ?? "built",
      createdAt: new Date(++this.clock).toISOString(),
    };
    this.rows.set(id, row);
    return row;
  }

  async getById(_orgId: string, id: string): Promise<ReleaseInstanceRecord | undefined> {
    return this.rows.get(id);
  }

  async getByDeployment(input: GetReleaseInstanceByDeploymentInput): Promise<ReleaseInstanceRecord | undefined> {
    return [...this.rows.values()].find(
      (row) =>
        row.orgId === input.orgId &&
        row.provider === input.provider &&
        row.appId === input.appId &&
        row.deploymentId === input.deploymentId,
    );
  }

  async listForProject(orgId: string, projectId: string): Promise<ReleaseInstanceRecord[]> {
    return [...this.rows.values()].filter((row) => row.orgId === orgId && row.projectId === projectId);
  }

  async transition(input: TransitionReleaseInstanceInput): Promise<ReleaseInstanceRecord> {
    const row = this.rows.get(input.releaseInstanceId);
    if (row === undefined) throw new Error(`missing release ${input.releaseInstanceId}`);
    const updated = {
      ...row,
      state: input.state,
      ...(input.environment === undefined ? {} : { environment: input.environment }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.previousReleaseInstanceId === undefined
        ? {}
        : { previousReleaseInstanceId: input.previousReleaseInstanceId }),
      ...(input.deploymentId === undefined ? {} : { deploymentId: input.deploymentId }),
    } as ReleaseInstanceRecord;
    this.rows.set(row.releaseInstanceId, updated);
    return updated;
  }

  async supersedePriorLive(input: SupersedePriorLiveInput): Promise<ReleaseInstanceRecord | undefined> {
    const prior =
      input.releaseInstanceId === undefined || input.releaseInstanceId === null
        ? [...this.rows.values()].find(
            (row) =>
              row.orgId === input.orgId &&
              row.projectId === input.projectId &&
              row.provider === input.provider &&
              row.appId === input.appId &&
              row.state === "live" &&
              row.releaseInstanceId !== input.exceptReleaseInstanceId,
          )
        : this.rows.get(input.releaseInstanceId);
    return prior === undefined
      ? undefined
      : this.transition({ orgId: input.orgId, releaseInstanceId: prior.releaseInstanceId, state: "superseded" });
  }

  async applyPreview(input: CreateReleaseInstanceInput): Promise<ReleaseInstanceRecord> {
    const current = [...this.rows.values()].find(
      (row) =>
        row.orgId === input.orgId &&
        row.projectId === input.projectId &&
        row.provider === input.provider &&
        row.appId === input.appId &&
        row.artifactDigest === input.artifactDigest &&
        row.state === "built",
    );
    if (current === undefined) return this.create({ ...input, environment: "preview", state: "preview" });
    return this.transition({
      orgId: input.orgId,
      releaseInstanceId: current.releaseInstanceId,
      state: "preview",
      environment: "preview",
      deploymentId: input.deploymentId,
      url: input.url,
    }).then((row) => {
      const updated = { ...row, behaviorRevisionIds: [...(input.behaviorRevisionIds ?? [])] };
      this.rows.set(row.releaseInstanceId, updated);
      return updated;
    });
  }

  async promote(input: PromoteReleaseInput): Promise<ReleaseInstanceRecord> {
    const target = await this.getByDeployment(input);
    if (target === undefined) throw new Error("missing preview");
    const prior = await this.supersedePriorLive({
      orgId: input.orgId,
      projectId: input.projectId,
      provider: input.provider,
      appId: input.appId,
      exceptReleaseInstanceId: target.releaseInstanceId,
      ...(input.previousReleaseInstanceId === null ? {} : { releaseInstanceId: input.previousReleaseInstanceId }),
    });
    await this.transition({
      orgId: input.orgId,
      releaseInstanceId: target.releaseInstanceId,
      state: "promoting",
      environment: "production",
      url: input.url,
      previousReleaseInstanceId: prior?.releaseInstanceId ?? null,
    });
    return this.transition({
      orgId: input.orgId,
      releaseInstanceId: target.releaseInstanceId,
      state: "live",
      environment: "production",
      url: input.url,
      previousReleaseInstanceId: prior?.releaseInstanceId ?? null,
    });
  }

  async rollback(input: RollbackReleaseInput): Promise<ReleaseInstanceRecord> {
    return this.transition({
      orgId: input.orgId,
      releaseInstanceId: input.releaseInstanceId,
      state: "rolled_back",
      environment: "production",
      url: input.url,
    });
  }

  async teardownPreview(input: TeardownPreviewInput): Promise<ReleaseInstanceRecord | undefined> {
    const row = await this.getByDeployment(input);
    return row === undefined
      ? undefined
      : this.transition({ orgId: input.orgId, releaseInstanceId: row.releaseInstanceId, state: "torn_down" });
  }

  async markLive(input: MarkLiveReleaseInput): Promise<ReleaseInstanceRecord> {
    const row = await this.getByDeployment(input);
    if (row === undefined) throw new Error("missing release");
    return this.transition({ orgId: input.orgId, releaseInstanceId: row.releaseInstanceId, state: "live", url: input.url });
  }
}

async function grant(operation: "deploy" | "resolve_artifact_identity" | "promote" | "rollback", deploymentId?: string) {
  return testOrgGrant({
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    providerKind: REF.provider,
    metadata: { teamId: "team_1", integrationNodeId: "node_release" },
    credentialRef: "secret://org/deploy-token/g/1",
    capability: "deploy",
    operation,
    target:
      operation === "deploy"
        ? { resourceId: REF.appId, sourceRepo: SOURCE.repo, sourceRef: SOURCE.ref }
        : { resourceId: REF.appId, deploymentId: deploymentId ?? "deployment_1" },
  });
}

describe("DirectApiDeployAdapter release-instance persistence", () => {
  it("persists build and preview, promotes with supersession, and rolls back", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "secret://org/deploy-token/g/1", value: "token" });
    const releases = new MemoryReleaseInstances();
    const adapter = new DirectApiDeployAdapter({
      provisioner: { transport: scriptedDeployTransport("vercel", ["acme-web"]), secrets },
      urlProbe: scriptedUrlProbe(),
      poll: instantVerifyPollPolicy(),
      releaseInstances: releases,
    });

    const buildGrant = await grant("deploy");
    const built = await adapter.buildArtifact(
      {
        deploy: buildGrant,
        resolveArtifactIdentity: (deploymentId) => grant("resolve_artifact_identity", deploymentId),
      },
      REF,
      SOURCE,
    );
    expect((await releases.getById(ORG_ID, built.deploymentId))?.state).toBe("built");

    const prior = await releases.create({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      provider: REF.provider,
      appId: REF.appId,
      environment: "production",
      deploymentId: "prior_live",
      sourceRef: "old-sha",
      artifactDigest: ARTIFACT_DIGEST,
      providerChecksum: null,
      integrationNodeId: "node_release",
      url: "https://old.example.test",
      state: "live",
    });

    const previewInput: ApplyPreviewInput = {
      source: SOURCE,
      artifactDigest: built.artifactDigest,
      integrationNodeId: "node_release",
      behaviorRevisionIds: [BEHAVIOR_REVISION_ID],
    };
    const preview = await adapter.applyPreview(await grant("deploy"), REF, previewInput);
    expect((await releases.getById(ORG_ID, built.deploymentId))?.state).toBe("preview");
    expect((await releases.getById(ORG_ID, built.deploymentId))?.behaviorRevisionIds).toEqual([
      BEHAVIOR_REVISION_ID,
    ]);

    const promoted = await adapter.promote(await grant("promote", preview.deploymentId), REF, {
      deploymentId: preview.deploymentId,
      artifactDigest: built.artifactDigest,
      previousReleaseInstanceId: prior.releaseInstanceId,
    });
    expect(promoted.state).toBe("live");
    expect((await releases.getById(ORG_ID, prior.releaseInstanceId))?.state).toBe("superseded");
    expect((await releases.getById(ORG_ID, built.deploymentId))?.state).toBe("live");

    const rolledBack = await adapter.rollback(await grant("rollback", built.deploymentId), REF, {
      targetArtifactDigest: built.artifactDigest,
      targetReleaseInstanceId: built.deploymentId,
    } satisfies RollbackInput);
    expect(rolledBack.state).toBe("rolled_back");
    expect((await releases.getById(ORG_ID, built.deploymentId))?.state).toBe("rolled_back");
    expect((await releases.listForProject(ORG_ID, PROJECT_ID)).map((row) => row.state)).toEqual([
      "rolled_back",
      "superseded",
    ]);
  });
});
