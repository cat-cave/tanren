// Negative controls: every Maybe-returning orchestrator list maps JSON null to
// unavailable without throwing (never masquerades as empty success).

import { describe, expect, it } from "vitest";
import { OrchestratorClient } from "../src/api/orchestrator.js";

function clientWithBodies(bodies: unknown[]): OrchestratorClient {
  let i = 0;
  const fetchImpl = (async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return new OrchestratorClient({ orchestratorUrl: "http://orch", fetchImpl });
}

describe("Maybe APIs: JSON null → unavailable (no throw)", () => {
  it("listProjectsMaybe", async () => {
    await expect(clientWithBodies([null]).listProjectsMaybe("o1")).resolves.toBeUndefined();
  });

  it("listRunsMaybe", async () => {
    await expect(clientWithBodies([null]).listRunsMaybe("o1", "p1")).resolves.toBeUndefined();
  });

  it("listFeedMaybe", async () => {
    await expect(clientWithBodies([null]).listFeedMaybe("o1", "p1")).resolves.toBeUndefined();
  });

  it("listInsightsMaybe", async () => {
    await expect(clientWithBodies([null]).listInsightsMaybe("o1", "p1")).resolves.toBeUndefined();
  });

  it("listMilestonesMaybe", async () => {
    await expect(clientWithBodies([null]).listMilestonesMaybe("o1", "p1")).resolves.toBeUndefined();
  });

  it("listSpecsMaybe", async () => {
    await expect(clientWithBodies([null]).listSpecsMaybe("o1", "p1")).resolves.toBeUndefined();
  });

  it("listPersonasMaybe", async () => {
    await expect(clientWithBodies([null]).listPersonasMaybe("o1", "p1")).resolves.toBeUndefined();
  });

  it("listBehaviorsMaybe", async () => {
    await expect(clientWithBodies([null]).listBehaviorsMaybe("o1", "p1", "per1")).resolves.toBeUndefined();
  });

  it("listAllBehaviorsMaybe when personas body is null", async () => {
    await expect(clientWithBodies([null]).listAllBehaviorsMaybe("o1", "p1")).resolves.toBeUndefined();
  });

  it("listAllBehaviorsMaybe when a behaviors page is null", async () => {
    const client = clientWithBodies([{ personas: [{ id: "per1", name: "p", description: "" }] }, null]);
    await expect(client.listAllBehaviorsMaybe("o1", "p1")).resolves.toBeUndefined();
  });

  it("empty array success is distinct from null unavailable", async () => {
    await expect(clientWithBodies([{ projects: [] }]).listProjectsMaybe("o1")).resolves.toEqual([]);
    await expect(clientWithBodies([{ items: [] }]).listRunsMaybe("o1", "p1")).resolves.toEqual([]);
    await expect(clientWithBodies([{ specs: [] }]).listSpecsMaybe("o1", "p1")).resolves.toEqual([]);
  });
});
