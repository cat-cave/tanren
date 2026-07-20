// Fake-client unit proofs (no DB) for the capability_prepare decision core + the
// materialize/evaluate passes — exercised in the fast-check coverage run (the
// real-Postgres RLS proof lives in capabilityPrepare.rls.integration.test.ts).

import { describe, expect, it } from "vitest";
import {
  evaluateAndApply,
  evaluateGrant,
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

function coveringGrantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider_kind: "slack",
    connection_id: "conn_1",
    grant_id: "grant_1",
    capabilities: ["messaging.send"],
    operations: ["chat.postMessage"],
    provider_scopes: ["chat:write"],
    grant_gen_status: "active",
    auth_gen_status: "active",
    grant_expired: false,
    auth_expired: false,
    ...overrides,
  };
}

describe("resolveDependencies", () => {
  it("is satisfied with no edges", async () => {
    const c = new FakeClient([{ match: "capability_node_dependencies", rows: [] }]);
    expect(await resolveDependencies(c.as(), "o", "p", "n")).toEqual({ resolution: "satisfied", edgeCount: 0 });
  });
  it("is satisfied when every parent is ready", async () => {
    const c = new FakeClient([{ match: "capability_node_dependencies", rows: [{ parent_status: "ready" }] }]);
    expect(await resolveDependencies(c.as(), "o", "p", "n")).toEqual({ resolution: "satisfied", edgeCount: 1 });
  });
  it("is blocked when a parent is not ready", async () => {
    const c = new FakeClient([
      { match: "capability_node_dependencies", rows: [{ parent_status: "ready" }, { parent_status: "enqueued" }] },
    ]);
    expect(await resolveDependencies(c.as(), "o", "p", "n")).toEqual({ resolution: "blocked", edgeCount: 2 });
  });
  it("fails when a parent needs attention", async () => {
    const c = new FakeClient([{ match: "capability_node_dependencies", rows: [{ parent_status: "needs_attention" }] }]);
    expect(await resolveDependencies(c.as(), "o", "p", "n")).toEqual({ resolution: "failed", edgeCount: 1 });
  });
});

describe("evaluateGrant (genuine coverage)", () => {
  it("fails closed with no providers", async () => {
    const c = new FakeClient([]);
    expect(await evaluateGrant(c.as(), "o", node(), [])).toEqual({ ok: false, reason: "no_provider_policy" });
    expect(c.issued).toHaveLength(0);
  });
  it("is absent when no candidate grant exists", async () => {
    const c = new FakeClient([{ match: "project_integration_grant_selections", rows: [] }]);
    expect(await evaluateGrant(c.as(), "o", node(), ["slack"])).toEqual({ ok: false, reason: "grant_absent" });
  });
  it("is ok (with the covering grant identity) when the grant genuinely covers the node", async () => {
    const c = new FakeClient([{ match: "project_integration_grant_selections", rows: [coveringGrantRow()] }]);
    expect(await evaluateGrant(c.as(), "o", node(), ["slack"])).toEqual({
      ok: true,
      providerKind: "slack",
      connectionId: "conn_1",
      grantId: "grant_1",
    });
  });
  it("fails closed on a missing required scope", async () => {
    const c = new FakeClient([
      { match: "project_integration_grant_selections", rows: [coveringGrantRow({ provider_scopes: [] })] },
    ]);
    expect(await evaluateGrant(c.as(), "o", node(), ["slack"])).toEqual({ ok: false, reason: "insufficient_scopes" });
  });
  it("fails closed on a missing required operation", async () => {
    const c = new FakeClient([
      { match: "project_integration_grant_selections", rows: [coveringGrantRow({ operations: [] })] },
    ]);
    expect(await evaluateGrant(c.as(), "o", node(), ["slack"])).toEqual({
      ok: false,
      reason: "insufficient_operations",
    });
  });
  it("fails closed when the capability is not covered", async () => {
    const c = new FakeClient([
      { match: "project_integration_grant_selections", rows: [coveringGrantRow({ capabilities: ["errors.capture"] })] },
    ]);
    expect(await evaluateGrant(c.as(), "o", node(), ["slack"])).toEqual({
      ok: false,
      reason: "capability_not_covered",
    });
  });
  it("fails closed on an expired grant generation", async () => {
    const c = new FakeClient([
      { match: "project_integration_grant_selections", rows: [coveringGrantRow({ grant_expired: true })] },
    ]);
    expect(await evaluateGrant(c.as(), "o", node(), ["slack"])).toEqual({ ok: false, reason: "grant_expired" });
  });
  it("fails closed on an expired auth generation", async () => {
    const c = new FakeClient([
      { match: "project_integration_grant_selections", rows: [coveringGrantRow({ auth_expired: true })] },
    ]);
    expect(await evaluateGrant(c.as(), "o", node(), ["slack"])).toEqual({ ok: false, reason: "grant_expired" });
  });
  it("fails closed on an inactive grant generation", async () => {
    const c = new FakeClient([
      { match: "project_integration_grant_selections", rows: [coveringGrantRow({ grant_gen_status: "revoked" })] },
    ]);
    expect(await evaluateGrant(c.as(), "o", node(), ["slack"])).toEqual({ ok: false, reason: "grant_inactive" });
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

  it("enqueues provider work when deps + a genuinely-covering grant are present", async () => {
    const c = new FakeClient([
      { match: "capability_node_dependencies", rows: [] },
      { match: "project_integration_grant_selections", rows: [coveringGrantRow()] },
    ]);
    expect(await evaluateAndApply(c.as(), "o", node())).toBe("enqueued");
    expect(c.did("INSERT INTO integration_reconciliations")).toBe(true);
  });

  it("parks (never enqueues) when the grant is present but missing a required scope", async () => {
    const c = new FakeClient([
      { match: "capability_node_dependencies", rows: [] },
      { match: "project_integration_grant_selections", rows: [coveringGrantRow({ provider_scopes: [] })] },
    ]);
    expect(await evaluateAndApply(c.as(), "o", node())).toBe("awaiting_grant");
    expect(c.did("INSERT INTO integration_reconciliations")).toBe(false);
  });

  it("parks (never enqueues) when the grant is expired", async () => {
    const c = new FakeClient([
      { match: "capability_node_dependencies", rows: [] },
      { match: "project_integration_grant_selections", rows: [coveringGrantRow({ grant_expired: true })] },
    ]);
    expect(await evaluateAndApply(c.as(), "o", node())).toBe("awaiting_grant");
    expect(c.did("INSERT INTO integration_reconciliations")).toBe(false);
  });

  it("re-evaluates a DEP-caused needs_attention when the parent recovers", async () => {
    // needs_attention node WITH a (now-ready) dependency edge → recovers to enqueued.
    const c = new FakeClient([
      { match: "capability_node_dependencies", rows: [{ parent_status: "ready" }] },
      { match: "project_integration_grant_selections", rows: [coveringGrantRow()] },
    ]);
    expect(await evaluateAndApply(c.as(), "o", node({ status: "needs_attention" }))).toBe("enqueued");
  });

  it("does NOT recover a genuine needs_attention with no dependency edges", async () => {
    const c = new FakeClient([{ match: "capability_node_dependencies", rows: [] }]);
    expect(await evaluateAndApply(c.as(), "o", node({ status: "needs_attention" }))).toBe("unchanged");
    expect(c.did("project_integration_grant_selections")).toBe(false);
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
            desired_state: {
              providerPolicy: { allowed: ["slack"] },
              requiredOperations: ["chat.postMessage"],
              requiredScopes: ["chat:write"],
            },
          },
        ],
      },
      { match: "capability_node_dependencies", rows: [] },
      { match: "project_integration_grant_selections", rows: [coveringGrantRow()] },
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
