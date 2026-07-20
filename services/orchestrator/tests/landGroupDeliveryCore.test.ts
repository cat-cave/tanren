// mq-13 — the fail-closed group-delivery decision tree, unit-tested with fakes (NO database).
// Every trap class is an explicit branch: exactly-one-artifact, failed-preview → no-promote +
// teardown, production regression → REAL rollback to prior-good, no-prior-good → needs_attention
// (never a pretended rollback), rollback-throws → needs_attention, and single-member-attribution
// → repair route vs ambiguous → needs_attention (no fabricated repair target).

import { describe, expect, it } from "vitest";
import {
  LandGroupDeliveryClaimLostError,
  runGroupDelivery,
  type GroupArtifact,
  type GroupAttributionResult,
  type GroupDeliveryDeployer,
  type GroupDeliveryPlan,
  type GroupDemoOutcome,
  type GroupPreview,
  type GroupPreviewOutcome,
  type GroupProduction,
  type GroupPromoteOutcome,
  type GroupRegressionAttribution,
  type PriorGoodRelease,
  type ResolvedGroupDeployTarget,
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
  policyVersion: 3,
};

const ARTIFACT: GroupArtifact = { artifactDigest: `sha256:${"a".repeat(64)}`, deploymentId: "dep-build" };
const PREVIEW: GroupPreview = {
  release: { releaseInstanceId: "rel-preview", deploymentId: "dep-preview", artifactDigest: ARTIFACT.artifactDigest },
  previewDeploymentId: "dep-preview",
};
const PRODUCTION: GroupProduction = {
  release: { releaseInstanceId: "rel-prod", deploymentId: "dep-prod", artifactDigest: ARTIFACT.artifactDigest },
};
const PRIOR_GOOD: PriorGoodRelease = { releaseInstanceId: "rel-prior", artifactDigest: `sha256:${"b".repeat(64)}` };

interface FakeOptions {
  previewDemoOk?: boolean;
  productionDemoOk?: boolean;
  priorGood?: PriorGoodRelease | undefined;
  rollbackThrows?: boolean;
  buildThrows?: boolean;
  previewVerifyThrows?: boolean;
}

class FakeDeployer implements GroupDeliveryDeployer {
  readonly calls: string[] = [];
  buildCount = 0;
  teardownCount = 0;
  readonly rollbackTargets: PriorGoodRelease[] = [];
  constructor(private readonly opts: FakeOptions = {}) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async buildArtifact(): Promise<GroupArtifact> {
    this.calls.push("build");
    this.buildCount += 1;
    if (this.opts.buildThrows === true) throw new Error("build failed");
    return ARTIFACT;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async applyPreview(): Promise<GroupPreviewOutcome> {
    this.calls.push("applyPreview");
    return { kind: "applied", preview: PREVIEW };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async verifyPreview(): Promise<void> {
    this.calls.push("verifyPreview");
    if (this.opts.previewVerifyThrows === true) throw new Error("preview never became reachable");
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async demo(input: { environment: "preview" | "production" }): Promise<GroupDemoOutcome> {
    this.calls.push(`demo:${input.environment}`);
    const ok =
      input.environment === "preview" ? this.opts.previewDemoOk !== false : this.opts.productionDemoOk !== false;
    return ok ? { ok: true, reason: "" } : { ok: false, reason: "behavior failed" };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async teardownPreview(): Promise<void> {
    this.calls.push("teardown");
    this.teardownCount += 1;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async promote(): Promise<GroupPromoteOutcome> {
    this.calls.push("promote");
    return { kind: "promoted", production: PRODUCTION };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async currentPriorGood(): Promise<PriorGoodRelease | undefined> {
    this.calls.push("currentPriorGood");
    return this.opts.priorGood;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async rollback(input: { priorGood: PriorGoodRelease }): Promise<void> {
    this.calls.push("rollback");
    this.rollbackTargets.push(input.priorGood);
    if (this.opts.rollbackThrows === true) throw new Error("provider rollback failed");
  }
}

class FakeAttribution implements GroupRegressionAttribution {
  routeCount = 0;
  readonly routed: string[] = [];
  constructor(private readonly result: GroupAttributionResult) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async attribute(): Promise<GroupAttributionResult> {
    return this.result;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async route(input: { attributed: Extract<GroupAttributionResult, { kind: "attributed" }> }): Promise<void> {
    this.routeCount += 1;
    this.routed.push(input.attributed.runId);
  }
}

const UNATTRIBUTED = new FakeAttribution({ kind: "unattributed", reason: "inconclusive" });

function drive(deployer: FakeDeployer, attribution: GroupRegressionAttribution) {
  return runGroupDelivery({ deployer, attribution, plan: PLAN, target: TARGET });
}

describe("runGroupDelivery — fail-closed group delivery", () => {
  it("happy path: build ONE artifact → preview → demo → promote → production demo → completed", async () => {
    const deployer = new FakeDeployer();
    const outcome = await drive(deployer, UNATTRIBUTED);
    // exactly ONE artifact per completed group
    expect(deployer.buildCount).toBe(1);
    expect(deployer.calls).toEqual([
      "build",
      "applyPreview",
      "verifyPreview",
      "demo:preview",
      "promote",
      "demo:production",
    ]);
    expect(outcome.state).toBe("completed");
    expect(outcome.disposition).toBe("none");
    expect(outcome.productionReleaseInstanceId).toBe("rel-prod");
    expect(outcome.artifactDigest).toBe(ARTIFACT.artifactDigest);
  });

  it("failed preview demo → NO promote + preview teardown (gravest fail-open blocked)", async () => {
    const deployer = new FakeDeployer({ previewDemoOk: false });
    const outcome = await drive(deployer, UNATTRIBUTED);
    expect(deployer.calls).toEqual(["build", "applyPreview", "verifyPreview", "demo:preview", "teardown"]);
    // never promotes a failed preview
    expect(deployer.calls).not.toContain("promote");
    expect(deployer.teardownCount).toBe(1);
    expect(outcome.state).toBe("preview_failed");
    expect(outcome.productionReleaseInstanceId).toBeNull();
  });

  it("preview VERIFY failure → teardown + preview_failed, never needs_attention or a leaked preview (Finding 4)", async () => {
    const deployer = new FakeDeployer({ previewVerifyThrows: true });
    const outcome = await drive(deployer, UNATTRIBUTED);
    expect(deployer.calls).toEqual(["build", "applyPreview", "verifyPreview", "teardown"]);
    // a failed preview VERIFY tears down the preview and never promotes or demos it
    expect(deployer.calls).not.toContain("promote");
    expect(deployer.calls).not.toContain("demo:preview");
    expect(deployer.teardownCount).toBe(1);
    expect(outcome.state).toBe("preview_failed");
    expect(outcome.previewReleaseInstanceId).toBe("rel-preview");
  });

  it("production regression with prior-good → REAL rollback to prior-good lineage + repair route", async () => {
    const deployer = new FakeDeployer({ productionDemoOk: false, priorGood: PRIOR_GOOD });
    const attribution = new FakeAttribution({
      kind: "attributed",
      runId: "run-a",
      specId: "spec-a",
      findingIds: ["f1"],
      reasonCodes: ["r1"],
      evaluationId: "eval-1",
    });
    const outcome = await drive(deployer, attribution);
    expect(deployer.calls).toContain("rollback");
    // rolled back to the persisted prior-good
    expect(deployer.rollbackTargets).toEqual([PRIOR_GOOD]);
    expect(attribution.routeCount).toBe(1);
    expect(attribution.routed).toEqual(["run-a"]);
    expect(outcome.state).toBe("rolled_back");
    expect(outcome.disposition).toBe("repair_routed");
    expect(outcome.attributedRunId).toBe("run-a");
    expect(outcome.rollbackReleaseInstanceId).toBe("rel-prior");
  });

  it("production regression, rollback succeeds, AMBIGUOUS attribution → needs_attention, NO fabricated repair target", async () => {
    const deployer = new FakeDeployer({ productionDemoOk: false, priorGood: PRIOR_GOOD });
    const outcome = await drive(deployer, UNATTRIBUTED);
    expect(deployer.calls).toContain("rollback");
    expect(outcome.state).toBe("rolled_back");
    // no single-member attribution
    expect(outcome.disposition).toBe("needs_attention");
    // NO fabricated repair target
    expect(outcome.attributedRunId).toBeNull();
  });

  it("production regression with NO prior-good → needs_attention, NEVER a pretended rollback", async () => {
    const deployer = new FakeDeployer({ productionDemoOk: false, priorGood: undefined });
    const outcome = await drive(deployer, UNATTRIBUTED);
    expect(deployer.calls).toContain("currentPriorGood");
    // never pretends a rollback with no prior-good
    expect(deployer.calls).not.toContain("rollback");
    expect(outcome.state).toBe("needs_attention");
    expect(outcome.rollbackReleaseInstanceId).toBeNull();
  });

  it("production regression, rollback FAILS (throws) → needs_attention, NEVER claims rolled_back", async () => {
    const deployer = new FakeDeployer({ productionDemoOk: false, priorGood: PRIOR_GOOD, rollbackThrows: true });
    const outcome = await drive(deployer, UNATTRIBUTED);
    expect(deployer.calls).toContain("rollback");
    // a rollback that did not succeed is NOT rolled_back
    expect(outcome.state).toBe("needs_attention");
    expect(outcome.disposition).toBe("needs_attention");
    expect(outcome.rollbackReleaseInstanceId).toBeNull();
  });

  it("an unexpected stage throw propagates (the loop shell records needs_attention)", async () => {
    const deployer = new FakeDeployer({ buildThrows: true });
    await expect(drive(deployer, UNATTRIBUTED)).rejects.toThrow("build failed");
  });

  it("claim LOST after applyPreview → the preview is torn down before aborting, no leak (Finding B)", async () => {
    const deployer = new FakeDeployer();
    // A heartbeat that throws a claim-loss on the FIRST beat AFTER the preview was applied (the
    // pre-verify fence-recheck) — the owner was taken over mid-drive.
    const heartbeat = async (): Promise<void> => {
      if (deployer.calls.includes("applyPreview")) throw new LandGroupDeliveryClaimLostError("lg-1");
    };
    await expect(
      runGroupDelivery({ deployer, attribution: UNATTRIBUTED, plan: PLAN, target: TARGET, heartbeat }),
    ).rejects.toThrow(LandGroupDeliveryClaimLostError);
    expect(deployer.calls).toContain("applyPreview");
    // never promoted after the claim was lost; the applied preview was torn down (no leak)
    expect(deployer.calls).not.toContain("promote");
    expect(deployer.teardownCount).toBe(1);
  });
});
