// cspell:ignore rdec
import { describe, expect, it } from "vitest";
import { AllowAllPeerVerifier, DenyAllPeerVerifier } from "../src/engine/contracts/mtlsChannel.js";
import { createInternalResolutionAuthorityRoutes } from "../src/routes/internal/resolutionAuthority.js";

function request(app: ReturnType<typeof createInternalResolutionAuthorityRoutes>, body: unknown) {
  return app.request(
    "/internal/resolution-authority/rjob_1/authorize",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { incoming: { socket: {} } },
  );
}

describe("internal ResolutionAuthority endpoint", () => {
  it("requires mTLS before it can invoke the authority", async () => {
    const app = createInternalResolutionAuthorityRoutes({
      pool: {} as never,
      verifier: new DenyAllPeerVerifier(),
      authority: {
        async authorize() {
          throw new Error("untrusted peer must not invoke authority");
        },
        async waive() {
          throw new Error("not reachable here");
        },
      },
    });
    const response = await request(app, { orgId: "org_a" });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "untrusted_peer" });
  });

  it("accepts no caller-supplied verdict and delegates only the durable job identity", async () => {
    const calls: unknown[] = [];
    const app = createInternalResolutionAuthorityRoutes({
      pool: {} as never,
      verifier: new AllowAllPeerVerifier(),
      authority: {
        async authorize(input) {
          calls.push(input);
          return {
            id: "rdec_authorized",
            decision: "authorized",
            inputSnapshotHash: "sha256:" + "a".repeat(64),
            reasons: [],
            created: true,
          };
        },
        async waive() {
          throw new Error("not reachable here");
        },
      },
    });
    const rejectedVerdict = await request(app, { orgId: "org_a", decision: "authorized", productionPassed: true });
    expect(rejectedVerdict.status).toBe(400);
    const response = await request(app, { orgId: "org_a" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ decision: "authorized" });
    expect(calls).toEqual([{ orgId: "org_a", resolutionJobId: "rjob_1" }]);
  });
});
