// mq-13 DB-FREE unit tests for the pure / injectable helpers of the land-group delivery
// subsystem — the health predicate, the `deploy.verified` payload shape, the injectable
// release read-back, and the fail-closed regression attribution seam. Every branch here is
// exercised with fakes (NO database), complementing the RLS integration tests that cover the
// DB-bound store/reads/deployer/loop paths.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  groupDeployVerifiedPayload,
  isHealthySmokeStatus,
  readBackGroupRelease,
} from "../src/engine/postMerge/landGroupDelivery/groupDeliveryDeployerHelpers.js";
import {
  ConservativeGroupCausalReplay,
  type GroupCausalReplay,
  type GroupCausalReplayResult,
  RepairRoutingGroupAttribution,
} from "../src/engine/postMerge/landGroupDelivery/groupRegressionAttribution.js";
import type {
  GroupDeliveryPlan,
  GroupProduction,
  PriorGoodRelease,
  ResolvedGroupDeployTarget,
} from "../src/engine/postMerge/landGroupDelivery/groupDeliveryCore.js";
import type { ReleaseInstanceRecord } from "../src/engine/contracts/deployAdapter.js";
import type { ReleaseInstancesRepository } from "../src/engine/repositories/releaseInstances.js";

const PLAN: GroupDeliveryPlan = {
  orgId: "org-1",
  projectId: "proj-1",
  landGroupId: "lg-1",
  mainSha: "sha-main",
  tailRunId: "run-tail",
  tailSpecId: "spec-tail",
  memberRunIds: ["run-a", "run-tail"],
  memberSpecIds: ["spec-a", "spec-tail"],
};

const TARGET: ResolvedGroupDeployTarget = {
  provider: "deploy.vercel",
  appId: "app-1",
  repoSlug: "acme/web",
  policyVersion: 3,
};

const PRODUCTION: GroupProduction = {
  release: { releaseInstanceId: "rel-prod", deploymentId: "dep-prod", artifactDigest: `sha256:${"a".repeat(64)}` },
};
const PRIOR_GOOD: PriorGoodRelease = { releaseInstanceId: "rel-prior", artifactDigest: `sha256:${"b".repeat(64)}` };

/** A release-instances repository whose `getByDeployment` returns a fixed record (or nothing). */
function repoReturning(record?: ReleaseInstanceRecord): ReleaseInstancesRepository {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async getByDeployment() {
      return record;
    },
  } as unknown as ReleaseInstancesRepository;
}

const RELEASE_RECORD: ReleaseInstanceRecord = {
  releaseInstanceId: "rel-1",
  orgId: "org-1",
  projectId: "proj-1",
  provider: "deploy.vercel",
  appId: "app-1",
  environment: "production",
  deploymentId: "dep-prod",
  sourceRef: "sha-main",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  url: "https://app.example.com",
  state: "live",
} as ReleaseInstanceRecord;

describe("isHealthySmokeStatus — the SINGLE deploy-health predicate (fail-closed)", () => {
  it("treats 2xx/3xx as healthy", () => {
    for (const status of [200, 204, 299, 301, 302, 399]) {
      expect(isHealthySmokeStatus(status)).toBe(true);
    }
  });

  it("treats a 401/403 auth-gated-but-running deployment as healthy", () => {
    expect(isHealthySmokeStatus(401)).toBe(true);
    expect(isHealthySmokeStatus(403)).toBe(true);
  });

  it("treats every other status (4xx non-auth, 5xx) as UNHEALTHY — never verifies a broken product", () => {
    for (const status of [400, 404, 429, 500, 502, 503]) {
      expect(isHealthySmokeStatus(status)).toBe(false);
    }
  });
});

describe("groupDeployVerifiedPayload — the LIVE-production deploy.verified shape", () => {
  it("binds provider/appId/deploymentId/url/state/smokeStatus + a non-secret audit envelope", () => {
    const payload = groupDeployVerifiedPayload(PLAN, TARGET, {
      deploymentId: "dep-prod",
      url: "https://app.example.com",
      state: "live",
      smokeStatus: 200,
    });
    expect(payload.provider).toBe("deploy.vercel");
    expect(payload.appId).toBe("app-1");
    expect(payload.deploymentId).toBe("dep-prod");
    expect(payload.url).toBe("https://app.example.com");
    expect(payload.state).toBe("live");
    expect(payload.smokeStatus).toBe(200);
    // The audit envelope is spread in and carries no raw secret.
    expect(JSON.stringify(payload)).not.toContain("password");
  });
});

describe("readBackGroupRelease — injectable release read-back", () => {
  it("returns the persisted record when present", async () => {
    const record = await readBackGroupRelease(repoReturning(RELEASE_RECORD), PLAN, TARGET, "dep-prod");
    expect(record.releaseInstanceId).toBe("rel-1");
  });

  it("THROWS (fail-loud) when no persisted release instance exists for the deployment", async () => {
    await expect(readBackGroupRelease(repoReturning(), PLAN, TARGET, "dep-missing")).rejects.toThrow(
      /no persisted release instance for deployment 'dep-missing'/u,
    );
  });
});

describe("regression attribution — fail-closed causal-replay seam", () => {
  const fakePool = {} as pg.Pool;

  it("the CONSERVATIVE default replay is always inconclusive (never fabricates a culprit)", async () => {
    const result = await new ConservativeGroupCausalReplay().localize();
    expect(result.kind).toBe("inconclusive");
  });

  it("attribute() maps an inconclusive replay to UNATTRIBUTED (no scapegoat)", async () => {
    const attribution = new RepairRoutingGroupAttribution(new ConservativeGroupCausalReplay(), { pool: fakePool });
    const result = await attribution.attribute({ plan: PLAN, production: PRODUCTION, priorGood: PRIOR_GOOD });
    expect(result).toMatchObject({
      kind: "unattributed",
      reason: expect.stringContaining("could not be causally bracketed") as unknown as string,
    });
  });

  it("attribute() maps a single-member localize to ATTRIBUTED with the culprit run + evidence", async () => {
    const localizedReplay: GroupCausalReplay = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async localize(): Promise<GroupCausalReplayResult> {
        return {
          kind: "localized",
          runId: "run-culprit",
          specId: "spec-culprit",
          findingIds: ["f-1"],
          reasonCodes: ["regressed_behavior"],
          evaluationId: "eval-1",
        };
      },
    };
    const attribution = new RepairRoutingGroupAttribution(localizedReplay, { pool: fakePool });
    const result = await attribution.attribute({ plan: PLAN, production: PRODUCTION, priorGood: PRIOR_GOOD });
    expect(result).toMatchObject({
      kind: "attributed",
      runId: "run-culprit",
      specId: "spec-culprit",
      evaluationId: "eval-1",
      findingIds: ["f-1"],
      reasonCodes: ["regressed_behavior"],
    });
  });
});
