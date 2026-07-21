// Pre-canonical authority inputs for planner-loop tests. The run resolves to repo
// `cat-cave/tanren-fixture-medium`, PR head branch `tanren/run_1`; native-queue first
// passes retain these green signals while queuing, but cannot synthesize a host land.
// Split out of plannerRun.fixtures.ts to keep that file under the cap.

import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import type { MergeAuthorityBundle } from "../src/engine/workflow/reviewMerge/mergeDispatchTypes.js";
import { noRequiredReviewGate } from "../src/engine/governance/reviewRules.js";

export const PLANNER_AUTHORITY_REPO = { owner: "cat-cave", name: "tanren-fixture-medium" };
export const PLANNER_AUTHORITY_HEAD_SHA = "sha-head";

export function plannerAuthorityHost(): InMemoryCodeHost {
  const host = new InMemoryCodeHost();
  host.seed(PLANNER_AUTHORITY_REPO, "main", "sha-main");
  void host.pushRef({
    repo: PLANNER_AUTHORITY_REPO,
    localRef: "feat",
    remoteBranch: "tanren/run_1",
    sha: PLANNER_AUTHORITY_HEAD_SHA,
  });
  return host;
}

// Build the green preconditions the legacy planner input supplies. They are insufficient
// to land without a persisted queue node/proof; canonical coordinator tests own that CAS.
export function plannerAuthorityBundle(host: InMemoryCodeHost): MergeAuthorityBundle {
  return {
    codeHost: host,
    orgId: "org_fixture",
    landStoreFor: () => ({
      persistAuthorizedDecision: async () => ({ effectIntentId: "intent_1" }),
      recordLandReceipt: async () => ({ auditId: "audit_1" }),
    }),
    gateConfigHash: "gc",
    policyVersion: "pv",
    gateOutcome: { passed: true, results: [] },
    gatedHeadSha: PLANNER_AUTHORITY_HEAD_SHA,
    reviewedHeadSha: undefined,
    requiresExactReviewReceipt: false,
    reviewGate: noRequiredReviewGate(),
    findings: [],
    auditPosture: { blockReviewAt: "P1", p2p3Handling: "route-to-dag" },
    reviewVerdict: "approved",
    budget: { ceilingUsd: undefined, spentUsd: 0 },
    demo: "not_required",
    hitlSignoff: "not_required",
    behaviorGate: { kind: "not_applicable" },
    designRenderGate: { kind: "not_applicable" },
  };
}
