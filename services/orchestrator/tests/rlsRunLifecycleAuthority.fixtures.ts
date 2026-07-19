// The authority-land bundle for the RLS run-lifecycle integration test. The CAS lands on
// an in-memory host (seeded with the run's repo + PR head at the gate's anchored head sha,
// so the §5 gate↔land commit-binding holds), but the durable half is the REAL writer-backed
// `buildLandFinalizer` over the enforced app pool — so `merge.completed` + the spec
// `merged` flip are written under enforced RLS, the lifecycle writes the test locks.
// Extracted to a sibling fixture so the test file stays under the max-dependencies cap.

import type { Pool } from "pg";
import { buildAuthorityLandStore } from "../src/engine/merge/mergeAuthorityLandFinalizer.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import type { MergeAuthorityBundle } from "../src/engine/workflow/reviewMerge/mergeDispatchTypes.js";
import { noRequiredReviewGate } from "../src/engine/governance/reviewRules.js";

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
  // Audit D-R3.2: buildLandFinalizer now requires the writer (the in-process pool fallback
  // was unreachable in production after PR #714). Use the Direct writer over the same pool —
  // its `finalizeLand` runs the byte-identical `applyFinalizeLand` org-scoped transaction.
  const writer = new DirectRunStateWriter(input.pool);
  return {
    codeHost: host,
    orgId: input.orgId,
    landStoreFor: (context) => buildAuthorityLandStore(input.pool, context, writer),
    gateConfigHash: "gc",
    policyVersion: "pv",
    gateOutcome: { passed: true, results: [] },
    // The native gate anchored its verdict on the workspace HEAD (`headSha`); the land's
    // authorized commit is the same head, so the §5 commit-binding clears.
    gatedHeadSha: input.headSha,
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
