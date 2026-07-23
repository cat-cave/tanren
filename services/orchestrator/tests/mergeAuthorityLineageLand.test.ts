// gv-17 CRA P0: production land path must not CAS when member lineage revalidation fails.

import { describe, expect, it } from "vitest";
import type { LandAuthorization, LandBindingEnvelope } from "../src/engine/contracts/mergeAuthority.js";
import { MergeAuthorityV2Impl } from "../src/engine/merge/mergeAuthorityV2Impl.js";

describe("gv-17 MergeAuthority land fail-closed on lineage revalidation", () => {
  it("does not call CodeHost.landAuthorizedIntegration when revalidation fails (negative control)", async () => {
    const landCalls: string[] = [];
    const host = {
      landAuthorizedIntegration: async () => {
        landCalls.push("land");
        return { kind: "landed", mainSha: "m".repeat(40) };
      },
    };
    const landStore = {
      persistAuthorizedDecision: async () => ({ effectIntentId: "intent_1" }),
      recordLandReceipt: async () => ({ auditId: "audit_1" }),
    };
    const authority = new MergeAuthorityV2Impl(
      host as never,
      {
        revalidate: async () => ({
          valid: false,
          reason: "member lineage invalid: normalized rows and members jsonb diverged",
        }),
      },
      landStore as never,
    );
    const envelope = {
      subject: { id: "inode_1", kind: "integration_node" },
      headSha: "h".repeat(40),
      expectedMainSha: "b".repeat(40),
      memberSetHash: "k".repeat(64),
      policyVersion: "p1",
      members: [],
      target: { repo: { owner: "o", name: "r" }, intoMain: "main" },
    } as unknown as LandBindingEnvelope;
    const auth = {
      subject: { id: "inode_1", kind: "integration_node" },
      envelope,
      decision: "authorized",
    } as unknown as LandAuthorization;

    const outcome = await authority.land(auth);
    expect(outcome).toMatchObject({ kind: "revalidation_failed" });
    expect(landCalls).toEqual([]);
  });
});
