// The authority-land oracle for the planner-loop integration tests (replacing the
// deleted host-merge `probe.merge()`). The planner tests' run resolves to repo
// `cat-cave/tanren-fixture-medium`, PR head branch `tanren/run_1`. A `direct_merge` land
// test seeds this host + passes the matching `plannerAuthorityBundle` as `mergeAuthority`,
// then asserts the land via the advanced ref (`result.merge?.outcome === "merged"` + the
// spec `merged`). Split out of plannerRun.fixtures.ts to keep that file under the cap.

import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import type { MergeAuthorityBundle } from "../src/engine/workflow/reviewMerge/mergeDispatchTypes.js";

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

// Build the bundle the planner-loop land authorizes against. Every fail-closed input
// clears (approved review, passing gate bound to the landed head, no findings, no budget
// ceiling, demo + HITL not required) so a clean tree lands; the durable `merge.completed`
// is the LandFinalizer's job (no DB here), so the land oracle is the advanced ref.
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
