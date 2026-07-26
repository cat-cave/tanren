import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { DeployAdapter } from "../src/engine/contracts/deployAdapter.js";
import type { OrgGrant } from "../src/engine/contracts/integrationProvisioner.js";
import type { GroupDeliveryAuthority } from "../src/engine/postMerge/landGroupDelivery/groupDeliveryAuthority.js";
import type { ReleaseInstanceRecord } from "../src/engine/contracts/deployAdapter.js";
import type { ProofBackedWebDemo } from "../src/engine/demo/proofBackedWebDemo.js";
import {
  ProductionGroupDeliveryDeployer,
  type GroupIntentStore,
} from "../src/engine/postMerge/landGroupDelivery/groupDeliveryDeployer.js";
import { LandGroupDeliveryRetryableAuthorityError } from "../src/engine/postMerge/landGroupDelivery/groupDeliveryRetryableAuthorityError.js";
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
    intentStore: {
      writeIntent: async () => true,
      readIntent: async () => false,
      clearPreEffectAuthorityFailure: async () => true,
    },
  });
}

const EMPTY_POOL = {
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
} as unknown as pg.Pool;

const clearIntent: GroupIntentStore["clearPreEffectAuthorityFailure"] = async () => true;

function grant(grantId: string): OrgGrant {
  return {
    orgId: PLAN.orgId,
    projectId: PLAN.projectId,
    connectionId: "connection-a3",
    grantId,
    providerKind: TARGET.provider,
    providerPrincipalId: "principal-a3",
    authGeneration: 1,
    grantGeneration: 1,
    metadata: {},
    eligibleOperation: {} as OrgGrant["eligibleOperation"],
  };
}

function statefulIntentStore(afterWrite?: () => Promise<void>): {
  readonly store: GroupIntentStore;
  readonly hasIntent: (step: "preview" | "promote") => boolean;
} {
  const intents = new Set<"preview" | "promote">();
  return {
    store: {
      writeIntent: async (_orgId, _landGroupId, _token, step) => {
        await afterWrite?.();
        intents.add(step);
        return true;
      },
      readIntent: async (_orgId, _landGroupId, step) => intents.has(step),
      clearPreEffectAuthorityFailure: async (_orgId, _landGroupId, _token, step) => intents.delete(step),
    },
    hasIntent: (step) => intents.has(step),
  };
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
      intentStore: {
        writeIntent: async () => true,
        readIntent: async () => false,
        clearPreEffectAuthorityFailure: clearIntent,
      },
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
      intentStore: { writeIntent, readIntent, clearPreEffectAuthorityFailure: clearIntent },
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

  it("refreshes deploy authority after preview intent at the provider boundary", async () => {
    const stale = grant("stale-deploy");
    const refreshed = grant("refreshed-deploy");
    const require = vi
      .fn<GroupDeliveryAuthority["require"]>()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(refreshed);
    const writeIntent = vi.fn<GroupIntentStore["writeIntent"]>().mockResolvedValue(true);
    const applyPreview = vi.fn<DeployAdapter["applyPreview"]>(async (received) => {
      if (received === stale) throw new Error("stale deploy grant reached provider");
      expect(received).toBe(refreshed);
      return { deploymentId: "preview-refreshed" };
    });
    const groupDeployer = new ProductionGroupDeliveryDeployer({
      pool: EMPTY_POOL,
      secrets: {} as never,
      transport: {} as never,
      eventStore: {} as never,
      deployAdapter: { applyPreview } as unknown as DeployAdapter,
      authority: { require },
      intentStore: { writeIntent, readIntent: async () => false, clearPreEffectAuthorityFailure: clearIntent },
      releaseInstances: {
        getByDeployment: async () => ({ ...RELEASE, deploymentId: "preview-refreshed" }),
      } as never,
    });

    await expect(
      groupDeployer.applyPreview({
        plan: PLAN,
        target: TARGET,
        artifact: { artifactDigest: `sha256:${"a".repeat(64)}`, deploymentId: "build-a3" },
        token: "fence-a3",
      }),
    ).resolves.toMatchObject({ kind: "applied" });

    expect(require).toHaveBeenCalledTimes(2);
    expect(require.mock.calls[0]).toEqual(require.mock.calls[1]);
    expect(writeIntent).toHaveBeenCalledTimes(1);
    expect(writeIntent.mock.invocationCallOrder[0]).toBeLessThan(require.mock.invocationCallOrder[1]);
    expect(applyPreview).toHaveBeenCalledTimes(1);
    expect(applyPreview).toHaveBeenCalledWith(refreshed, expect.anything(), expect.anything());
  });

  it("refreshes promote authority after promote intent at the provider boundary", async () => {
    const stale = grant("stale-promote");
    const refreshed = grant("refreshed-promote");
    const require = vi
      .fn<GroupDeliveryAuthority["require"]>()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(refreshed);
    const writeIntent = vi.fn<GroupIntentStore["writeIntent"]>().mockResolvedValue(true);
    const promote = vi.fn<DeployAdapter["promote"]>(async (received) => {
      if (received === stale) throw new Error("stale promote grant reached provider");
      expect(received).toBe(refreshed);
      throw new Error("stop after refreshed promote");
    });
    const groupDeployer = new ProductionGroupDeliveryDeployer({
      pool: EMPTY_POOL,
      secrets: {} as never,
      transport: {} as never,
      eventStore: {} as never,
      deployAdapter: { promote } as unknown as DeployAdapter,
      authority: { require },
      intentStore: { writeIntent, readIntent: async () => false, clearPreEffectAuthorityFailure: clearIntent },
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
    ).rejects.toThrow("stop after refreshed promote");

    expect(require).toHaveBeenCalledTimes(2);
    expect(require.mock.calls[0]).toEqual(require.mock.calls[1]);
    expect(writeIntent).toHaveBeenCalledTimes(1);
    expect(writeIntent.mock.invocationCallOrder[0]).toBeLessThan(require.mock.invocationCallOrder[1]);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(promote).toHaveBeenCalledWith(refreshed, expect.anything(), expect.anything());
  });

  it("negative control: delayed preview intent then expired boundary grant clears only the owned pre-effect marker", async () => {
    const stale = grant("stale-preview");
    const refreshed = grant("refreshed-preview");
    const require = vi
      .fn<GroupDeliveryAuthority["require"]>()
      .mockResolvedValueOnce(stale)
      .mockRejectedValueOnce(new Error("preview grant expired"))
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(refreshed);
    let intentWriteCompleted = false;
    const intents = statefulIntentStore(async () => {
      // Simulate the durable intent write consuming the prior grant's validity.
      await Promise.resolve();
      intentWriteCompleted = true;
    });
    const applyPreview = vi.fn<DeployAdapter["applyPreview"]>(async () => ({ deploymentId: "preview-retry" }));
    const groupDeployer = new ProductionGroupDeliveryDeployer({
      pool: EMPTY_POOL,
      secrets: {} as never,
      transport: {} as never,
      eventStore: {} as never,
      deployAdapter: { applyPreview } as unknown as DeployAdapter,
      authority: { require },
      intentStore: intents.store,
      releaseInstances: { getByDeployment: async () => ({ ...RELEASE, deploymentId: "preview-retry" }) } as never,
    });
    const input = {
      plan: PLAN,
      target: TARGET,
      artifact: { artifactDigest: `sha256:${"a".repeat(64)}`, deploymentId: "build-a3" },
      token: "fence-a3",
    };

    await expect(groupDeployer.applyPreview(input)).rejects.toBeInstanceOf(LandGroupDeliveryRetryableAuthorityError);
    expect(intentWriteCompleted).toBe(true);
    expect(intents.hasIntent("preview")).toBe(false);
    expect(applyPreview).not.toHaveBeenCalled();

    await expect(groupDeployer.applyPreview(input)).resolves.toMatchObject({ kind: "applied" });
    expect(intents.hasIntent("preview")).toBe(true);
    expect(applyPreview).toHaveBeenCalledTimes(1);
    expect(applyPreview).toHaveBeenCalledWith(refreshed, expect.anything(), expect.anything());
  });

  it("negative control: delayed promote intent then expired boundary grant clears only the owned pre-effect marker", async () => {
    const stale = grant("stale-promote");
    const refreshed = grant("refreshed-promote");
    const require = vi
      .fn<GroupDeliveryAuthority["require"]>()
      .mockResolvedValueOnce(stale)
      .mockRejectedValueOnce(new Error("promote grant expired"))
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(refreshed);
    let intentWriteCompleted = false;
    const intents = statefulIntentStore(async () => {
      // The post-intent authority read observes expiration, before provider I/O.
      await Promise.resolve();
      intentWriteCompleted = true;
    });
    const promote = vi.fn<DeployAdapter["promote"]>(async () => {
      throw new Error("provider reached after safe retry");
    });
    const groupDeployer = new ProductionGroupDeliveryDeployer({
      pool: EMPTY_POOL,
      secrets: {} as never,
      transport: {} as never,
      eventStore: {} as never,
      deployAdapter: { promote } as unknown as DeployAdapter,
      authority: { require },
      intentStore: intents.store,
    });
    const input = {
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
    };

    await expect(groupDeployer.promote(input)).rejects.toBeInstanceOf(LandGroupDeliveryRetryableAuthorityError);
    expect(intentWriteCompleted).toBe(true);
    expect(intents.hasIntent("promote")).toBe(false);
    expect(promote).not.toHaveBeenCalled();

    await expect(groupDeployer.promote(input)).rejects.toThrow("provider reached after safe retry");
    expect(intents.hasIntent("promote")).toBe(true);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(promote).toHaveBeenCalledWith(refreshed, expect.anything(), expect.anything());
  });

  it("never clears or re-fires when fenced pre-effect recovery lost ownership", async () => {
    let intentPresent = false;
    const require = vi
      .fn<GroupDeliveryAuthority["require"]>()
      .mockResolvedValueOnce(grant("early"))
      .mockRejectedValueOnce(new Error("boundary grant expired"));
    const applyPreview = vi.fn<DeployAdapter["applyPreview"]>();
    const groupDeployer = new ProductionGroupDeliveryDeployer({
      pool: EMPTY_POOL,
      secrets: {} as never,
      transport: {} as never,
      eventStore: {} as never,
      deployAdapter: { applyPreview } as unknown as DeployAdapter,
      authority: { require },
      intentStore: {
        writeIntent: async () => {
          intentPresent = true;
          return true;
        },
        readIntent: async () => intentPresent,
        // A successor owns the fence: this owner cannot prove a safe retraction.
        clearPreEffectAuthorityFailure: async () => false,
      },
    });
    const input = {
      plan: PLAN,
      target: TARGET,
      artifact: { artifactDigest: `sha256:${"a".repeat(64)}`, deploymentId: "build-a3" },
      token: "fence-a3",
    };

    await expect(groupDeployer.applyPreview(input)).rejects.toThrow(/taken over/iu);
    expect(applyPreview).not.toHaveBeenCalled();
    await expect(groupDeployer.applyPreview(input)).resolves.toEqual({ kind: "ambiguous" });
    expect(applyPreview).not.toHaveBeenCalled();
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
