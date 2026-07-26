import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { DeployAdapter } from "../src/engine/contracts/deployAdapter.js";
import type { GroupDeliveryAuthority } from "../src/engine/postMerge/landGroupDelivery/groupDeliveryAuthority.js";
import type { ReleaseInstanceRecord } from "../src/engine/contracts/deployAdapter.js";
import type { ProofBackedWebDemo } from "../src/engine/demo/proofBackedWebDemo.js";
import {
  ProductionGroupDeliveryDeployer,
  type GroupIntentStore,
} from "../src/engine/postMerge/landGroupDelivery/groupDeliveryDeployer.js";
import type {
  GroupDeliveryPlan,
  ResolvedGroupDeployTarget,
} from "../src/engine/postMerge/landGroupDelivery/groupDeliveryCore.js";

const PLAN: GroupDeliveryPlan = {
  orgId: "org-a3",
  projectId: "project-a3",
  landGroupId: "group-a3",
  mainSha: "a".repeat(40),
  tailRunId: "run-tail",
  tailSpecId: "spec-tail",
  deliveryRunId: "delivery-decision-a3",
  memberRunIds: ["run-a", "run-tail"],
  memberSpecIds: ["spec-a", "spec-tail"],
};
const TARGET: ResolvedGroupDeployTarget = {
  provider: "deploy.vercel",
  appId: "app-a3",
  repoSlug: "acme/product",
  policyVersion: 1,
};
const RELEASE: ReleaseInstanceRecord = {
  releaseInstanceId: "release-a3",
  orgId: PLAN.orgId,
  projectId: PLAN.projectId,
  provider: TARGET.provider,
  appId: TARGET.appId,
  environment: "production",
  deploymentId: "deployment-a3",
  sourceRef: PLAN.mainSha,
  artifactDigest: `sha256:${"a".repeat(64)}`,
  providerChecksum: null,
  integrationNodeId: PLAN.tailRunId,
  behaviorRevisionIds: [],
  url: "https://a3.example.test",
  region: null,
  previousReleaseInstanceId: null,
  state: "live",
  createdAt: "2026-07-21T00:00:00.000Z",
};

function deployer(proofBackedWebDemo: ProofBackedWebDemo): ProductionGroupDeliveryDeployer {
  return new ProductionGroupDeliveryDeployer({
    pool: {} as pg.Pool,
    secrets: {} as never,
    transport: {} as never,
    eventStore: {} as never,
    proofBackedWebDemo,
    releaseInstances: { getByDeployment: async () => RELEASE } as never,
    intentStore: { writeIntent: async () => true, readIntent: async () => false },
  });
}

describe("ProductionGroupDeliveryDeployer — A3 delivery binding", () => {
  it("negative control: missing deploy authority rejects before preview persistence or provider effect", async () => {
    const connect = vi.fn<() => Promise<never>>();
    const applyPreview = vi.fn<DeployAdapter["applyPreview"]>();
    const authority: GroupDeliveryAuthority = {
      require: async () => {
        throw new Error("missing exact deploy authority");
      },
    };
    const groupDeployer = new ProductionGroupDeliveryDeployer({
      pool: { connect } as unknown as pg.Pool,
      secrets: {} as never,
      transport: {} as never,
      eventStore: {} as never,
      deployAdapter: { applyPreview } as unknown as DeployAdapter,
      authority,
      intentStore: { writeIntent: async () => true, readIntent: async () => false },
    });

    await expect(
      groupDeployer.applyPreview({
        plan: PLAN,
        target: TARGET,
        artifact: { artifactDigest: `sha256:${"a".repeat(64)}`, deploymentId: "build-a3" },
        token: "fence-a3",
      }),
    ).rejects.toThrow("missing exact deploy authority");

    expect(connect).not.toHaveBeenCalled();
    expect(applyPreview).not.toHaveBeenCalled();
  });

  it("negative control: missing promote authority rejects before persistence, intent, or provider effect", async () => {
    const connect = vi.fn<() => Promise<never>>();
    const readIntent = vi.fn<GroupIntentStore["readIntent"]>();
    const writeIntent = vi.fn<GroupIntentStore["writeIntent"]>();
    const promote = vi.fn<DeployAdapter["promote"]>();
    const operations: string[] = [];
    const authority: GroupDeliveryAuthority = {
      require: async (_plan, _target, operation) => {
        operations.push(operation);
        throw new Error("missing exact promote authority");
      },
    };
    const groupDeployer = new ProductionGroupDeliveryDeployer({
      pool: { connect } as unknown as pg.Pool,
      secrets: {} as never,
      transport: {} as never,
      eventStore: {} as never,
      deployAdapter: { promote } as unknown as DeployAdapter,
      authority,
      intentStore: { writeIntent, readIntent },
    });

    await expect(
      groupDeployer.promote({
        plan: PLAN,
        target: TARGET,
        artifact: { artifactDigest: `sha256:${"a".repeat(64)}`, deploymentId: "build-a3" },
        preview: {
          release: {
            releaseInstanceId: "preview-a3",
            deploymentId: "preview-a3",
            artifactDigest: `sha256:${"a".repeat(64)}`,
          },
          previewDeploymentId: "preview-a3",
        },
        token: "fence-a3",
      }),
    ).rejects.toThrow("missing exact promote authority");

    expect(operations).toEqual(["promote"]);
    expect(connect).not.toHaveBeenCalled();
    expect(readIntent).not.toHaveBeenCalled();
    expect(writeIntent).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
  });

  it("reserves A3 for the sealed production demo, never the preview proof", async () => {
    const targets: unknown[] = [];
    const proofBackedWebDemo = {
      demo: async (target: unknown) => {
        targets.push(target);
        return { evidence: [], passed: 0, failed: 1 };
      },
    } as ProofBackedWebDemo;

    const groupDeployer = deployer(proofBackedWebDemo);
    await groupDeployer.demo({
      plan: PLAN,
      target: TARGET,
      release: {
        releaseInstanceId: RELEASE.releaseInstanceId,
        deploymentId: RELEASE.deploymentId,
        artifactDigest: RELEASE.artifactDigest,
      },
      environment: "preview",
    });
    const outcome = await groupDeployer.demo({
      plan: PLAN,
      target: TARGET,
      release: {
        releaseInstanceId: RELEASE.releaseInstanceId,
        deploymentId: RELEASE.deploymentId,
        artifactDigest: RELEASE.artifactDigest,
      },
      environment: "production",
    });

    expect(targets[0]).toMatchObject({ skipLiveEffectAssertions: true, runId: PLAN.tailRunId });
    expect(targets[0]).not.toHaveProperty("deliveryRunId");
    expect(targets[1]).toMatchObject({ deliveryRunId: PLAN.deliveryRunId, runId: PLAN.tailRunId });
    expect(outcome).toMatchObject({ ok: false });
  });
});
