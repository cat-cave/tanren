// Drives the FROZEN MergeAuthority conformance suite (the FAIL-CLOSED TRUTH TABLE,
// tanren-owns-the-engine.md §0/§5) against the REAL `MergeAuthorityImpl` (Wave 1) —
// the sibling to the Wave-0 reference-fake driver. Proving the real impl satisfies
// the SAME durable asset: authorized ONLY on the all-clear; each uncertainty blocks;
// land refuses a non-authorized authorization; land reconciles to merge_state_unknown
// when the durable finalize fails AFTER the external land fired.
//
// Wiring mirrors the fake driver: the in-memory `CodeHost` fake (the parallel
// subagent's GitHubCodeHost drives the SAME CodeHost suite; here we depend on the
// CONTRACT via the fake), main seeded at the CAS base prepare carries forward, and a
// `LandFinalizer` whose `failFinalize` toggle THROWS after the external land — the
// real impl must still have executed the host land first (authorize → execute →
// reconcile).

import { InMemoryCodeHost } from "./fakes/inMemoryCodeHost.js";
import { CONF_NODE, describeMergeAuthorityConformance } from "./mergeAuthorityConformance.js";
import { type LandFinalizer, MergeAuthorityImpl } from "../../src/engine/merge/mergeAuthorityImpl.js";

const REPO = { owner: "owner", name: "repo" };

/** A test `LandFinalizer` whose durable record optionally fails (reconcile path). */
class TestLandFinalizer implements LandFinalizer {
  constructor(private readonly failFinalize: boolean) {}

  async finalizeLanded(_input: { authorization: unknown; mainSha: string }): Promise<{ auditId: string }> {
    if (this.failFinalize) throw new Error("durable finalize failed");
    return { auditId: "audit_1" };
  }
}

function buildAuthority(failFinalize: boolean): MergeAuthorityImpl {
  const host = new InMemoryCodeHost();
  // Seed main at the CAS base prepareIntegration carries forward, so the land's
  // compare-and-swap matches (the CAS target is on the authorization, not here). The
  // node's built head is the materialized commit the land pushes onto main.
  host.seed(REPO, CONF_NODE.baseBranch, CONF_NODE.baseSha);
  return new MergeAuthorityImpl(host, new TestLandFinalizer(failFinalize));
}

describeMergeAuthorityConformance("MergeAuthorityImpl (real Wave-1 impl + real policy)", {
  make: () => buildAuthority(false),
  makeWithFailingFinalize: () => buildAuthority(true),
});
