import { describe, expect, it } from "vitest";
import type {
  GroupDeliveryOutcome,
  GroupDeliveryPlan,
} from "../src/engine/postMerge/landGroupDelivery/groupDeliveryCore.js";
import { LandGroupDeliveryLoop } from "../src/engine/postMerge/landGroupDelivery/landGroupDeliveryLoop.js";
import { LandGroupDeliveryRetryableAuthorityError } from "../src/engine/postMerge/landGroupDelivery/groupDeliveryRetryableAuthorityError.js";

const PLAN: GroupDeliveryPlan = {
  orgId: "org-retry",
  projectId: "project-retry",
  landGroupId: "group-retry",
  mainSha: "a".repeat(40),
  tailRunId: "run-retry",
  tailSpecId: "spec-retry",
  deliveryRunId: "delivery-retry",
  memberRunIds: ["run-retry"],
  memberSpecIds: ["spec-retry"],
};

const COMPLETED: GroupDeliveryOutcome = {
  state: "completed",
  disposition: "completed",
  artifactDigest: "sha256:artifact",
  previewReleaseInstanceId: "preview",
  productionReleaseInstanceId: "production",
  rollbackReleaseInstanceId: null,
  attributedRunId: null,
};

describe("LandGroupDeliveryLoop retryable pre-effect authority", () => {
  it("leaves expired fresh authority retryable, then effects exactly once after recovery", async () => {
    const finalized: GroupDeliveryOutcome[] = [];
    const claims = [
      { kind: "owned" as const, token: "fence-one" },
      { kind: "owned" as const, token: "fence-two" },
    ];
    let authorityCurrent = false;
    let providerEffects = 0;
    const loop = new LandGroupDeliveryLoop({
      pool: {} as never,
      store: {
        claim: async () => claims.shift() ?? { kind: "exists", state: "in_progress" },
        renewClaim: async () => true,
        finalize: async ({ outcome }: { outcome: GroupDeliveryOutcome }) => {
          finalized.push(outcome);
        },
      } as never,
      deployer: { recoverDeployVerified: async () => {} } as never,
      a3Gate: {} as never,
      attribution: {} as never,
      resolveCompletedGroup: async () => ({ plan: PLAN, repoSlug: "acme/retry", lineage: {} as never }),
      resolveGroupDeployTarget: async () => ({
        kind: "configured",
        target: { provider: "deploy.vercel", appId: "app-retry", policyVersion: 1 },
      }),
      drive: async () => {
        if (!authorityCurrent) {
          // The deployer proved the delayed intent's fresh grant expired before provider I/O.
          throw new LandGroupDeliveryRetryableAuthorityError("preview", new Error("grant expired"));
        }
        providerEffects += 1;
        return COMPLETED;
      },
    });

    await loop.check(PLAN.tailRunId);
    expect(providerEffects).toBe(0);
    expect(finalized).toEqual([]);

    authorityCurrent = true;
    await loop.check(PLAN.tailRunId);
    expect(providerEffects).toBe(1);
    expect(finalized).toEqual([COMPLETED]);
  });
});
