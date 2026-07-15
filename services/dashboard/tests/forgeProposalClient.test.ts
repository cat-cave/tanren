// (write-action approval): the dashboard's proposal-decision client.
//
// `decideForgeProposal` POSTs to the orchestrator's approve/reject route and
// maps the HTTP status to a typed outcome the palette island renders. The
// safety-relevant cases: a 409 surfaces `already_decided` (idempotent — the
// island never re-applies) and a 403 surfaces `denied`. Driven through an
// injected fetch so the assertions are on the real returned outcome + the
// request the client issued, not on a mock-call count.

import { describe, expect, it } from "vitest";
import { OrchestratorClient } from "../src/api/orchestrator.js";

interface Captured {
  url: string;
  method: string;
}

function clientReturning(status: number, body: unknown, captured: Captured[]): OrchestratorClient {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return new OrchestratorClient({ orchestratorUrl: "http://orch", fetchImpl });
}

describe("decideForgeProposal (dashboard proposal client)", () => {
  it("approve → decided, hitting the orchestrator approve route", async () => {
    const captured: Captured[] = [];
    const client = clientReturning(200, { proposal: { id: "p1", status: "executed" } }, captured);

    const result = await client.decideForgeProposal("org_a", "p1", "approve");

    expect(result.outcome).toBe("decided");
    expect(result.proposal?.status).toBe("executed");
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.url).toBe("http://orch/orgs/org_a/forge/proposals/p1/approve");
  });

  it("reject → decided, hitting the reject route", async () => {
    const captured: Captured[] = [];
    const client = clientReturning(200, { proposal: { id: "p1", status: "rejected" } }, captured);

    const result = await client.decideForgeProposal("org_a", "p1", "reject");

    expect(result.outcome).toBe("decided");
    expect(captured[0]?.url).toBe("http://orch/orgs/org_a/forge/proposals/p1/reject");
  });

  it("409 → already_decided with the current status (idempotent, never re-applies)", async () => {
    const client = clientReturning(409, { error: "forge_proposal_already_decided", status: "executed" }, []);

    const result = await client.decideForgeProposal("org_a", "p1", "approve");

    expect(result.outcome).toBe("already_decided");
    expect(result.currentStatus).toBe("executed");
  });

  it("403 → denied (authz refusal)", async () => {
    const client = clientReturning(403, { error: "tool_access_denied" }, []);

    const result = await client.decideForgeProposal("org_a", "p1", "approve");

    expect(result.outcome).toBe("denied");
  });

  it("404 → not_found", async () => {
    const client = clientReturning(404, { error: "forge_proposal_not_found" }, []);

    const result = await client.decideForgeProposal("org_a", "p1", "reject");

    expect(result.outcome).toBe("not_found");
  });

  it("200 {} → failed (incomplete body is not decided)", async () => {
    const client = clientReturning(200, {}, []);

    const result = await client.decideForgeProposal("org_a", "p1", "approve");

    expect(result.outcome).toBe("failed");
    expect(result.proposal).toBeUndefined();
  });
});

describe("askForge (server client structured failure)", () => {
  it("returns structured error on incomplete 200 body (never undefined success)", async () => {
    const client = clientReturning(200, {}, []);
    // ensureThread needs a thread id first.
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/forge/threads") && (init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ id: "th_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const orch = new OrchestratorClient({ orchestratorUrl: "http://orch", fetchImpl });
    const result = await orch.askForge("org_a", "hello");
    expect(result).toEqual({ error: "forge_ask_failed" });
    expect("threadId" in result).toBe(false);
  });

  it("returns structured error when thread create fails", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "down" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const orch = new OrchestratorClient({ orchestratorUrl: "http://orch", fetchImpl });
    const result = await orch.askForge("org_a", "hello");
    expect(result).toEqual({ error: "forge_thread_unavailable" });
  });
});
