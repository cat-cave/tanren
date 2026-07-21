// gv-12 — the real `authorizeAndLand` entry point consumes immutable review
// rules. A bare review.approved event, missing evidence, wrong actor, or stale
// receipt cannot advance main.

import { describe, expect, it } from "vitest";
import { compilePolicy } from "../src/engine/governance/policyCompiler.js";
import {
  DEDICATED_REVIEWER_PRINCIPAL,
  reviewRulesFromCompiledPolicy,
  type GovernanceReviewGate,
} from "../src/engine/governance/reviewRules.js";
import { authorizeAndLand } from "../src/engine/merge/mergeAuthorityGate.js";
import type { AuthorityLandStore } from "../src/engine/merge/mergeAuthorityV2Impl.js";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";

const REPO = { owner: "org", name: "repo" };
const HEAD = "a".repeat(40);
const STORE: AuthorityLandStore = {
  persistAuthorizedDecision: async () => ({ effectIntentId: "intent" }),
  recordLandReceipt: async () => ({ auditId: "audit" }),
};

function simulatedReviewGate(approvals: GovernanceReviewGate["evidence"]): GovernanceReviewGate {
  const compiled = compilePolicy({
    apiVersion: "tanren.dev/governance/v2",
    schemaVersion: 1,
    core: { rules: [] },
    org: { rules: [] },
    tier: {
      rules: [
        { key: "review.mode", value: "simulated" },
        { key: "review.minimum_approvals", value: 1 },
        { key: "review.freshness", value: "exact_head_sha" },
        { key: "review.require_forge_publication", value: true },
        { key: "review.dismiss_on_base_shift", value: true },
      ],
    },
    binding: { rules: [] },
  });
  if (compiled.status !== "compiled") throw new Error("test policy must compile");
  return { rules: reviewRulesFromCompiledPolicy(compiled.ast), evidence: approvals };
}

async function land(gate: GovernanceReviewGate) {
  const host = new InMemoryCodeHost();
  host.seed(REPO, "main", "main-sha");
  await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: HEAD });
  const disposition = await authorizeAndLand({
    codeHost: host,
    repo: REPO,
    intoMain: "main",
    headBranch: "feat",
    runId: "run",
    specId: "spec",
    gateConfigHash: "gate",
    policyVersion: "policy",
    gatedHeadSha: HEAD,
    reviewedHeadSha: HEAD,
    requiresExactReviewReceipt: true,
    reviewGate: gate,
    behaviorGate: { kind: "not_applicable" },
    designRenderGate: { kind: "not_applicable" },
    store: STORE,
    signals: {
      gateOutcome: { passed: true, results: [] },
      findings: [],
      auditPosture: { blockReviewAt: "P1", p2p3Handling: "route-to-dag" },
      reviewVerdict: "approved",
      mergeability: { state: "clean", behind: false, baseBranch: "main", headBranch: "feat" },
      budget: { ceilingUsd: undefined, spentUsd: 0 },
      demo: "not_required",
      hitlSignoff: "not_required",
      conflictsResolved: true,
    },
  });
  return { host, disposition };
}

describe("gv-12 core review rules → live MergeAuthority", () => {
  it("a required review with absent evidence blocks at authorizeAndLand", async () => {
    const { host, disposition } = await land(simulatedReviewGate({ kind: "observed", approvals: [] }));
    expect(disposition).toMatchObject({ kind: "blocked", reasons: [expect.stringContaining("0/1")] });
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("main-sha");
  });

  it("a wrong reviewer actor or an unresolved evidence read cannot satisfy the policy", async () => {
    const wrongActor = await land(
      simulatedReviewGate({
        kind: "observed",
        approvals: [
          {
            reviewer: "writer-bot",
            principal: { kind: "agent_profile", name: "writer" },
            forgeReviewHeadSha: HEAD,
          },
        ],
      }),
    );
    expect(wrongActor.disposition).toMatchObject({
      kind: "blocked",
      reasons: [expect.stringContaining("tanren-reviewer")],
    });
    expect(await wrongActor.host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("main-sha");

    const unreadable = await land(
      simulatedReviewGate({ kind: "unresolved", reason: "review event payload could not be observed" }),
    );
    expect(unreadable.disposition).toMatchObject({
      kind: "blocked",
      reasons: [expect.stringContaining("could not be observed")],
    });
  });

  it("the dedicated reviewer actor with an exact forge receipt clears review rules but cannot bypass queue proof", async () => {
    const { host, disposition } = await land(
      simulatedReviewGate({
        kind: "observed",
        approvals: [{ reviewer: "reviewer-bot", principal: DEDICATED_REVIEWER_PRINCIPAL, forgeReviewHeadSha: HEAD }],
      }),
    );
    expect(disposition).toMatchObject({
      kind: "blocked",
      reasons: [expect.stringContaining("canonical queue authority is required")],
    });
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("main-sha");
  });
});
