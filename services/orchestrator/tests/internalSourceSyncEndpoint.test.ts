import { describe, expect, it } from "vitest";
import { DenyAllPeerVerifier } from "../src/engine/contracts/mtlsChannel.js";
import { createInternalSourceSyncRoutes } from "../src/routes/internal/sourceSync.js";

// cspell:ignore ssync

describe("internal source-sync endpoint", () => {
  it("requires mTLS before claiming or retrying an outbox row", async () => {
    const app = createInternalSourceSyncRoutes({ pool: {} as never, verifier: new DenyAllPeerVerifier() });
    const claim = await app.request(
      "/internal/source-sync/claim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: "org_a", workerId: "worker_a" }),
      },
      { incoming: { socket: {} } },
    );
    expect(claim.status).toBe(401);
    await expect(claim.json()).resolves.toEqual({ error: "untrusted_peer" });
    const redrive = await app.request(
      "/internal/source-sync/ssync_a/redrive",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: "org_a" }),
      },
      { incoming: { socket: {} } },
    );
    expect(redrive.status).toBe(401);
    await expect(redrive.json()).resolves.toEqual({ error: "untrusted_peer" });
  });
});
