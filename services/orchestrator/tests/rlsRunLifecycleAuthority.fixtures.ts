// The authority-land bundle for the RLS run-lifecycle integration test. The CAS lands on
// an in-memory host (seeded with the run's repo + PR head at the gate's anchored head sha,
// so the §5 gate↔land commit-binding holds), but the durable half is the REAL writer-backed
// `buildLandFinalizer` over the enforced app pool — so `merge.completed` + the spec
// `merged` flip are written under enforced RLS, the lifecycle writes the test locks.
// Extracted to a sibling fixture so the test file stays under the max-dependencies cap.

import type { Pool } from "pg";
import { buildLandFinalizer } from "../src/engine/merge/mergeAuthorityLandFinalizer.js";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import type { MergeAuthorityBundle } from "../src/engine/workflow/reviewMerge/mergeDispatchTypes.js";

export function lifecycleAuthorityBundle(input: {
  pool: Pool;
  orgId: string;
  repo: { owner: string; name: string };
  headBranch: string;
  headSha: string;
}): MergeAuthorityBundle {
  const host = new InMemoryCodeHost();
  host.seed(input.repo, "main", "sha-main");
  void host.pushRef({ repo: input.repo, localRef: "feat", remoteBranch: input.headBranch, sha: input.headSha });
  return {
    codeHost: host,
    orgId: input.orgId,
    finalizerFor: (context) => buildLandFinalizer(input.pool, context),
    gateConfigHash: "gc",
    policyVersion: "pv",
    gateOutcome: { passed: true, results: [] },
    // The native gate anchored its verdict on the workspace HEAD (`headSha`); the land's
    // authorized commit is the same head, so the §5 commit-binding clears.
    gatedHeadSha: input.headSha,
    findings: [],
    auditPosture: { blockReviewAt: "P1", p2p3Handling: "route-to-dag" },
    reviewVerdict: "approved",
    budget: { ceilingUsd: undefined, spentUsd: 0 },
    demo: "not_required",
    hitlSignoff: "not_required",
  };
}
