// Fake-client unit proofs (no DB) for the capability_prepare decision core + the
// materialize/evaluate passes — exercised in the fast-check coverage run (the
// real-Postgres RLS proof lives in capabilityPrepare.rls.integration.test.ts).

import { describe, expect, it } from "vitest";
import {
  evaluateAndApply,
  grantSatisfied,
  resolveDependencies,
  type CapabilityNodeForEval,
  type QueryRunner,
} from "../src/engine/integrations/capabilityNodeCore.js";
import { evaluateNodes, materializeCapabilityNodes } from "../src/engine/integrations/capabilityPrepare.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

interface Script {
  readonly match: string;
  readonly rows?: unknown[];
  readonly rowCount?: number;
}

/** A scripted `query` runner: first substring match wins; writes/NOTIFY default OK. */
class FakeClient {
  readonly issued: string[] = [];
  constructor(private readonly scripts: Script[]) {}

  async query(sql: string, _params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const norm = sql.replaceAll(/\s+/gu, " ").trim();
    this.issued.push(norm);
    for (const s of this.scripts) {
      if (norm.includes(s.match)) {
        return { rows: s.rows ?? [], rowCount: s.rowCount ?? s.rows?.length ?? 0 };
      }
    }
    if (norm.includes("org_id, event_type, payload")) return { rows: [{ id: "1" }], rowCount: 1 };
    if (norm.startsWith("NOTIFY")) return { rows: [], rowCount: 0 };
    if (norm.startsWith("UPDATE") || norm.startsWith("INSERT")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }

  as(): QueryRunner {
    return this as unknown as QueryRunner;
  }

  did(match: string): boolean {
    return this.issued.some((s) => s.includes(match));
  }
}

function node(overrides: Partial<CapabilityNodeForEval> = {}): CapabilityNodeForEval {
  return {
    id: "capnode_1",
    projectId: "proj_1",
    requirementId: "req_1",
    environment: "test",
    status: "pending",
    generation: 1,
    desiredStateHash: DIGEST,
    plane: "product",
    capability: "messaging.send",
    desiredState: {
      providerPolicy: { allowed: ["slack"] },
      requiredOperations: ["chat.postMessage"],
      requiredScopes: ["chat:write"],
    },
    ...overrides,
  };
}

describe("resolveDependencies", () => {
  it("is satisfied with no edges", async () => {
    const c = new FakeClient([{ match: "capability_node_dependencies", rows: [] }]);
    expect(await resolveDependencies(c.as(), "o", "p", "n")).toBe("satisfied");
  });
  it("is satisfied when every parent is ready", async () => {
    const c = new FakeClient([{ match: "capability_node_dependencies", rows: [{ parent_status: "ready" }] }]);
    expect(await resolveDependencies(c.as(), "o", "p", "n")).toBe("satisfied");
  });
  it("is blocked when a parent is not ready", async () => {
    const c = new FakeClient([
      { match: "capability_node_dependencies", rows: [{ parent_status: "ready" }, { parent_status: "enqueued" }] },
    ]);
    expect(await resolveDependencies(c.as(), "o", "p", "n")).toBe("blocked");
  });
  it("fails when a parent needs attention", async () => {
    const c = new FakeClient([{ match: "capability_node_dependencies", rows: [{ parent_status: "needs_attention" }] }]);
    expect(await resolveDependencies(c.as(), "o", "p", "n")).toBe("failed");
  });
});

describe("grantSatisfied", () => {
  it("is false with no providers (fail-closed)", async () => {
    const c = new FakeClient([]);
    expect(await grantSatisfied(c.as(), "o", "p", [], "product", "test")).toBe(false);
    expect(c.issued).toHaveLength(0);
  });
  it("is true when the join returns a row", async () => {
    const c = new FakeClient([{ match: "project_integration_grant_selections", rows: [{ ok: 1 }] }]);
    expect(await grantSatisfied(c.as(), "o", "p", ["slack"], "product", "test")).toBe(true);
  });
  it("is false when the join is empty", async () => {
    const c = new FakeClient([{ match: "project_integration_grant_selections", rows: [] }]);
    expect(await grantSatisfied(c.as(), "o", "p", ["slack"], "product", "test")).toBe(false);
  });
});

describe("evaluateAndApply", () => {
  it("fails closed on an unresolved dependency", async () => {
    const c = new FakeClient([{ match: "capability_node_dependencies", rows: [{ parent_status: "needs_attention" }] }]);
    expect(await evaluateAndApply(c.as(), "o", node())).toBe("needs_attention");
  });

  it("blocks on a not-ready dependency", async () => {
    const c = new FakeClient([{ match: "capability_node_dependencies", rows: [{ parent_status: "pending" }] }]);
    expect(await evaluateAndApply(c.as(), "o", node())).toBe("blocked");
  });

  it("fails closed when the requirement resolves no provider", async () => {
    const c = new FakeClient([{ match: "capability_node_dependencies", rows: [] }]);
    expect(await evaluateAndApply(c.as(), "o", node({ desiredState: {} }))).toBe("needs_attention");
  });

  it("parks awaiting_grant and emits the request when the grant is absent", async () => {
    const c = new FakeClient([
      { match: "capability_node_dependencies", rows: [] },
      { match: "project_integration_grant_selections", rows: [] },
    ]);
    expect(await evaluateAndApply(c.as(), "o", node())).toBe("awaiting_grant");
    expect(c.did("org_id, event_type, payload")).toBe(true);
    expect(c.did("INSERT INTO integration_reconciliations")).toBe(false);
  });

  it("enqueues provider work when deps + grant are satisfied", async () => {
    const c = new FakeClient([
      { match: "capability_node_dependencies", rows: [] },
      { match: "project_integration_grant_selections", rows: [{ ok: 1 }] },
    ]);
    expect(await evaluateAndApply(c.as(), "o", node())).toBe("enqueued");
    expect(c.did("INSERT INTO integration_reconciliations")).toBe(true);
  });

  it("is a no-op when the status is unchanged (idempotent)", async () => {
    const c = new FakeClient([
      { match: "capability_node_dependencies", rows: [] },
      { match: "project_integration_grant_selections", rows: [] },
      { match: "UPDATE capability_nodes", rowCount: 0 },
    ]);
    // Grant absent but the UPDATE reports no change → already parked → no re-emit.
    expect(await evaluateAndApply(c.as(), "o", node())).toBe("unchanged");
    expect(c.did("org_id, event_type, payload")).toBe(false);
  });
});

describe("materializeCapabilityNodes", () => {
  it("inserts one node per prepare-environment (test/preview only)", async () => {
    const c = new FakeClient([
      {
        match: "FROM integration_requirements",
        rows: [{ id: "req_1", desired_state: { environments: ["test", "production"] }, source_digest: DIGEST }],
      },
      { match: "INSERT INTO capability_nodes", rowCount: 1 },
    ]);
    const inserted = await materializeCapabilityNodes(c.as(), "o", "proj_1");
    expect(inserted).toBe(1);
    // The production environment is NOT materialized here.
    const inserts = c.issued.filter((s) => s.includes("INSERT INTO capability_nodes"));
    expect(inserts).toHaveLength(1);
  });

  it("materializes nothing when no prepare-environment is declared", async () => {
    const c = new FakeClient([
      {
        match: "FROM integration_requirements",
        rows: [{ id: "req_1", desired_state: { environments: ["production"] }, source_digest: DIGEST }],
      },
    ]);
    expect(await materializeCapabilityNodes(c.as(), "o", "proj_1")).toBe(0);
  });
});

describe("evaluateNodes", () => {
  it("tallies the applied outcome across loaded nodes", async () => {
    const c = new FakeClient([
      {
        match: "FROM capability_nodes n",
        rows: [
          {
            id: "capnode_1",
            project_id: "proj_1",
            requirement_id: "req_1",
            environment: "test",
            status: "pending",
            generation: 1,
            desired_state_hash: DIGEST,
            plane: "product",
            capability: "messaging.send",
            desired_state: { providerPolicy: { allowed: ["slack"] }, requiredOperations: ["x"], requiredScopes: ["y"] },
          },
        ],
      },
      { match: "capability_node_dependencies", rows: [] },
      { match: "project_integration_grant_selections", rows: [{ ok: 1 }] },
    ]);
    const tally = await evaluateNodes(c.as(), "o", "proj_1", ["pending"]);
    expect(tally.enqueued).toBe(1);
  });

  it("skips a parked node whose requirement cannot use the arrived provider", async () => {
    const c = new FakeClient([
      {
        match: "FROM capability_nodes n",
        rows: [
          {
            id: "capnode_1",
            project_id: "proj_1",
            requirement_id: "req_1",
            environment: "test",
            status: "awaiting_grant",
            generation: 1,
            desired_state_hash: DIGEST,
            plane: "product",
            capability: "messaging.send",
            desired_state: { providerPolicy: { allowed: ["slack"] } },
          },
        ],
      },
    ]);
    // Provider filter "sentry" excludes the slack-only requirement — no dep/grant query runs.
    const tally = await evaluateNodes(c.as(), "o", "proj_1", ["awaiting_grant"], "sentry");
    expect(tally).toEqual({ enqueued: 0, awaitingGrant: 0, needsAttention: 0, blocked: 0 });
    expect(c.did("capability_node_dependencies")).toBe(false);
  });
});
