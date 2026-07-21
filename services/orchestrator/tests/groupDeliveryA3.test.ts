import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ReleaseInstanceRecord } from "../src/engine/contracts/deployAdapter.js";
import type { ProofBackedWebDemo } from "../src/engine/demo/proofBackedWebDemo.js";
import { ProductionGroupDeliveryDeployer } from "../src/engine/postMerge/landGroupDelivery/groupDeliveryDeployer.js";
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
