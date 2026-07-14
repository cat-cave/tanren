// Drives the FROZEN MergeAuthorityV2 conformance suite (the FAIL-CLOSED TRUTH TABLE,
// SP-4) against the REAL `MergeAuthorityV2Impl`. Proving the real impl satisfies the
// durable asset: authorized ONLY on the all-clear; each uncertainty blocks; a raced
// binding blocks; land refuses a non-authorized authorization; land reconciles to
// merge_state_unknown when the durable receipt fails AFTER the external land fired.
//
// Wiring: the in-memory `CodeHost` fake (the GitHubCodeHost drives the SAME CodeHost
// suite; here we depend on the CONTRACT via the fake), main seeded at the envelope's
// `expectedMainSha` CAS base, the default `SubjectEqualityRevalidator`, and a fake
// `AuthorityLandStore` whose `failReceipt` toggle THROWS after the external land — the
// real impl must still have executed the host land first (persist → land → receipt).

import { InMemoryCodeHost } from "./fakes/inMemoryCodeHost.js";
import { CONF_ENVELOPE, describeMergeAuthorityConformance } from "./mergeAuthorityConformance.js";
import {
  MergeAuthorityV2Impl,
  SubjectEqualityRevalidator,
  type AuthorityLandStore,
} from "../../src/engine/merge/mergeAuthorityV2Impl.js";

const REPO = { owner: "owner", name: "repo" };

/** A test `AuthorityLandStore` whose durable receipt optionally fails (reconcile path). */
function fakeStore(failReceipt: boolean): AuthorityLandStore {
  return {
    async persistAuthorizedDecision(): Promise<{ effectIntentId: string }> {
      return { effectIntentId: "intent_1" };
    },
    async recordLandReceipt(): Promise<{ auditId: string }> {
      if (failReceipt) throw new Error("durable receipt failed");
      return { auditId: "audit_1" };
    },
  };
}

function buildAuthority(failReceipt: boolean): MergeAuthorityV2Impl {
  const host = new InMemoryCodeHost();
  // Seed main at the envelope's CAS base so the land's compare-and-swap matches (the
  // CAS target rides on the envelope). The envelope head is the commit the land pushes.
  host.seed(REPO, CONF_ENVELOPE.target.intoMain, CONF_ENVELOPE.expectedMainSha);
  return new MergeAuthorityV2Impl(host, new SubjectEqualityRevalidator(), fakeStore(failReceipt));
}

describeMergeAuthorityConformance("MergeAuthorityV2Impl (real impl + real policy)", {
  make: () => buildAuthority(false),
  makeWithFailingFinalize: () => buildAuthority(true),
});
