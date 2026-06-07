// Drives the MergeAuthority conformance suite (the FAIL-CLOSED TRUTH TABLE,
// tanren-owns-the-engine.md §0/§5) against the in-memory reference fake, which
// composes the REAL `decideFromFindings` policy + the in-memory CodeHost for the
// land/reconcile path. Wave 1 adds a sibling driver pointing the SAME suite at the
// real MergeAuthority impl extracted from the scattered gate/governance/review.

import { InMemoryCodeHost } from "./fakes/inMemoryCodeHost.js";
import { InMemoryMergeAuthority } from "./fakes/inMemoryMergeAuthority.js";
import { CONF_NODE, describeMergeAuthorityConformance } from "./mergeAuthorityConformance.js";

const REPO = { owner: "owner", name: "repo" };

function buildAuthority(failFinalize: boolean): InMemoryMergeAuthority {
  const host = new InMemoryCodeHost();
  host.seed(REPO, CONF_NODE.baseBranch, CONF_NODE.baseSha);
  const finalize = {
    finalize: async (_input: { mainSha: string }) => {
      if (failFinalize) throw new Error("durable finalize failed");
      return { auditId: "audit_1" };
    },
  };
  return new InMemoryMergeAuthority(host, finalize, {
    repo: REPO,
    intoMain: CONF_NODE.baseBranch,
    expectedMainSha: CONF_NODE.baseSha,
  });
}

describeMergeAuthorityConformance("InMemoryMergeAuthority (reference fake + real policy)", {
  make: () => buildAuthority(false),
  makeWithFailingFinalize: () => buildAuthority(true),
});
