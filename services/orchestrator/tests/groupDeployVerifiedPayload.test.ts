// mq-13 Finding 2 — the GROUP's `deploy.verified` payload must be EXACTLY the shape the event
// registry accepts (so EventStore.append does not reject it) AND the shape mq-15 /
// ds-6 read (so a land group's delivery evidence is no longer starved). This asserts the pure
// payload builder parses the strict registered `DeployVerifiedPayload` and carries the fields the
// merge-train seal + design-delivery join bind (provider / appId / deploymentId / url / state).

import { describe, expect, it } from "vitest";
import { groupDeployVerifiedPayload } from "../src/engine/postMerge/landGroupDelivery/groupDeliveryDeployerHelpers.js";
import { DeployVerifiedPayload } from "../src/engine/events/schemas/deploy.js";
import type {
  GroupDeliveryPlan,
  ResolvedGroupDeployTarget,
} from "../src/engine/postMerge/landGroupDelivery/groupDeliveryCore.js";

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
  policyVersion: 7,
};

describe("groupDeployVerifiedPayload — the group's deploy.verified shape (Finding 2)", () => {
  const payload = groupDeployVerifiedPayload(PLAN, TARGET, {
    deploymentId: "dep-prod",
    url: "https://app-1.example.com",
    state: "READY",
    smokeStatus: 200,
  });

  it("parses the STRICT registered DeployVerifiedPayload (EventStore.append accepts it)", () => {
    const parsed = DeployVerifiedPayload.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("carries the exact fields the mq-15 seal + ds-6 join bind (bound to the LIVE prod deployment)", () => {
    expect(payload.provider).toBe("deploy.vercel");
    expect(payload.appId).toBe("app-1");
    // the promoted (live) deployment mq-15 binds release_instances on
    expect(payload.deploymentId).toBe("dep-prod");
    expect(payload.url).toBe("https://app-1.example.com");
    expect(payload.state).toBe("READY");
    expect(payload.smokeStatus).toBe(200);
    // The audit envelope stamps the group's governance policy version.
    expect(payload.policyVersion).toBe(7);
  });
});
