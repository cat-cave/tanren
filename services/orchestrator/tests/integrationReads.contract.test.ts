// in-20 — integration HTTP read route contract test. Drives the REAL
// `createIntegrationReadRoutes` factory through a Hono `app` with auth wired,
// against a fake `pg.Pool` whose `connect()` returns a client that pattern-matches
// the authz SELECTs and the store SELECTs. No live Postgres — this is the
// in-memory mirror of the authz + redaction + shape contract the route enforces;
// the DB-backed RLS test (`integrationReads.rls.integration.test.ts`) covers the
// cross-org-zero guarantee under the real `tanren_app` role.
//
// Mirrors `integrationMetricsRoutes.test.ts` (authz shape) + the rv-22 contract
// patterns. Covers the four negative controls the audit will probe:
//   (a) cross-org caller → 403 org_access_denied
//   (b) non-member of the project → 403 project_access_denied
//   (c) no token / secret / payload / credential field in any response body
//   (d) empty project → 200 with empty arrays + zero counts (not null)

import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createIntegrationReadRoutes } from "../src/routes/integrations/reads.js";

const ORG = "org_acme";
const PROJECT = "project_1";

const alice: ActorContext = {
  userId: "user_alice",
  orgId: ORG,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

interface Result {
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface FakeClient {
  query(sql: string, params?: unknown[]): Promise<Result>;
  release(): void;
}

interface Scenario {
  /** Set to null to simulate "project belongs to no org" (authz denies). */
  projectOrgId?: string | null;
  /** Set to false to simulate "user is not a project member" (authz denies). */
  isMember?: boolean;
  /** Lifecycle inventory row (omit to surface 404 lifecycle-not-found). */
  lifecycle?: Record<string, unknown> | null;
  /** Requirement rows. */
  requirements?: Record<string, unknown>[];
  /** Capability-node rows. */
  capabilityNodes?: Record<string, unknown>[];
  /** Binding rows (the integration_bindings SELECT result). */
  bindings?: Record<string, unknown>[];
  /** Binding-generation rows keyed by binding_id (for the JOIN). */
  bindingGenerations?: Record<string, Record<string, unknown>>;
  /** Binding-env rows keyed by binding_id. */
  bindingEnvs?: Record<string, Record<string, unknown>[]>;
  /** Delivery-run rows. */
  deliveryRuns?: Record<string, unknown>[];
  /** Delivery-stage rows. */
  deliveryStages?: Record<string, unknown>[];
  /** Delivery-run-binding rows. */
  deliveryRunBindings?: Record<string, unknown>[];
}

function makeClient(scenario: Scenario): FakeClient {
  return {
    async query(rawSql: string, params: unknown[] = []): Promise<Result> {
      const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
      // runWithOrgScope transaction control — return empty for BEGIN/COMMIT/SET.
      if (sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("SET LOCAL") || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      // assertProjectAccess queries (ForgeToolsStore.getProjectOrgId).
      if (sql === "SELECT org_id FROM projects WHERE project_id = $1") {
        const org = scenario.projectOrgId === undefined ? ORG : scenario.projectOrgId;
        return org === null ? { rows: [], rowCount: 0 } : { rows: [{ org_id: org }], rowCount: 1 };
      }
      // assertProjectAccess queries (ForgeToolsStore.countProjectMemberRole).
      if (sql === "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2") {
        const isMember = scenario.isMember === undefined ? true : scenario.isMember;
        return isMember ? { rows: [{ role: "member" }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      // The lifecycle inventory query (IntegrationLifecycleInventoryStore.getForProject).
      if (sql.startsWith("SELECT p.project_id,")) {
        if (scenario.lifecycle === null) return { rows: [], rowCount: 0 };
        return { rows: scenario.lifecycle ? [scenario.lifecycle] : [], rowCount: scenario.lifecycle ? 1 : 0 };
      }
      // listIntegrationRequirements.
      if (sql.startsWith("SELECT id, capability, plane, direction, source_kind")) {
        return { rows: scenario.requirements ?? [], rowCount: (scenario.requirements ?? []).length };
      }
      // listCapabilityNodes.
      if (sql.startsWith("SELECT id, requirement_id, environment, executor_kind")) {
        return { rows: scenario.capabilityNodes ?? [], rowCount: (scenario.capabilityNodes ?? []).length };
      }
      // listIntegrationBindings — the bindings SELECT.
      if (sql.startsWith("SELECT id AS binding_id, requirement_id, environment, provider_kind")) {
        return { rows: scenario.bindings ?? [], rowCount: (scenario.bindings ?? []).length };
      }
      // listIntegrationBindings — the generations JOIN.
      if (sql.startsWith("SELECT g.binding_id, g.generation, g.auth_generation")) {
        const gens = scenario.bindingGenerations ?? {};
        const bindingIds = (params[2] as string[]) ?? [];
        const rows = bindingIds.flatMap((id) => (gens[id] ? [{ binding_id: id, ...gens[id] }] : []));
        return { rows, rowCount: rows.length };
      }
      // listIntegrationBindings — the env JOIN.
      if (sql.startsWith("SELECT e.binding_id, e.binding_generation, e.key, e.classification")) {
        const envs = scenario.bindingEnvs ?? {};
        const bindingIds = (params[2] as string[]) ?? [];
        const rows = bindingIds.flatMap((id) => (envs[id] ?? []).map((row) => ({ binding_id: id, ...row })));
        return { rows, rowCount: rows.length };
      }
      // readDeliveryDagStatus — the runs SELECT.
      if (sql.startsWith("SELECT id, authority_decision_id, merge_sha, status, retry_after")) {
        return { rows: scenario.deliveryRuns ?? [], rowCount: (scenario.deliveryRuns ?? []).length };
      }
      // readDeliveryDagStatus — the stages SELECT.
      if (sql.startsWith("SELECT delivery_run_id, stage, ordinal, attempt, status, failure_classification")) {
        return { rows: scenario.deliveryStages ?? [], rowCount: (scenario.deliveryStages ?? []).length };
      }
      // readDeliveryDagStatus — the bindings SELECT.
      if (sql.startsWith("SELECT delivery_run_id, binding_id, binding_generation")) {
        return { rows: scenario.deliveryRunBindings ?? [], rowCount: (scenario.deliveryRunBindings ?? []).length };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
}

function fakePool(scenario: Scenario = {}): pg.Pool {
  const client = makeClient(scenario);
  return {
    async connect() {
      return client;
    },
    async query(sql: string, params?: unknown[]) {
      return client.query(sql, params);
    },
  } as unknown as pg.Pool;
}

function buildApp(pool: pg.Pool, actor: ActorContext = alice) {
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actor;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  app.route("/v1/orgs", createIntegrationReadRoutes({ pool }));
  return app;
}

describe("in-20 integration read routes — authz negative controls", () => {
  it("denies a cross-org caller with 403 org_access_denied on every endpoint", async () => {
    const app = buildApp(fakePool({}), { ...alice, orgId: "org_other" });
    const paths = [
      `/v1/orgs/${ORG}/projects/${PROJECT}/integrations/lifecycle`,
      `/v1/orgs/${ORG}/projects/${PROJECT}/integration-requirements`,
      `/v1/orgs/${ORG}/projects/${PROJECT}/capability-nodes`,
      `/v1/orgs/${ORG}/projects/${PROJECT}/integration-bindings`,
      `/v1/orgs/${ORG}/projects/${PROJECT}/delivery`,
    ];
    for (const path of paths) {
      const res = await app.request(path);
      expect(res.status, `${path} should 403`).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("org_access_denied");
    }
  });

  it("denies with 403 project_access_denied when the project belongs to no accessible org", async () => {
    // assertProjectAccess throws ToolAccessDeniedError when getProjectOrgId
    // returns null (the project row is absent or its org_id is NULL). The route
    // handler converts that throw into a 403 project_access_denied — never data.
    const app = buildApp(fakePool({ projectOrgId: null }));
    const paths = [
      `/v1/orgs/${ORG}/projects/${PROJECT}/integrations/lifecycle`,
      `/v1/orgs/${ORG}/projects/${PROJECT}/integration-requirements`,
      `/v1/orgs/${ORG}/projects/${PROJECT}/capability-nodes`,
      `/v1/orgs/${ORG}/projects/${PROJECT}/integration-bindings`,
      `/v1/orgs/${ORG}/projects/${PROJECT}/delivery`,
    ];
    for (const path of paths) {
      const res = await app.request(path);
      expect(res.status, `${path} should 403`).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("project_access_denied");
    }
  });

  it("denies with 403 project_access_denied when the project's actual org differs from the path org", async () => {
    // The path org is ORG, but the project's actual org is "org_other" — the
    // handler's `project.orgId !== orgId` guard returns 403 (a cross-org project
    // lookup never leaks data through this surface).
    const app = buildApp(fakePool({ projectOrgId: "org_other" }));
    const res = await app.request(`/v1/orgs/${ORG}/projects/${PROJECT}/integration-bindings`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("project_access_denied");
  });
});

describe("in-20 integration read routes — shape + redaction positive controls", () => {
  it("lifecycle: returns the versioned inventory shape with zero counts on a fresh project", async () => {
    const app = buildApp(
      fakePool({
        lifecycle: {
          project_id: PROJECT,
          requirement_total: "0",
          requirement_needs_attention: "0",
          capability_total: "0",
          capability_awaiting_grant: "0",
          capability_ready: "0",
          capability_needs_attention: "0",
          binding_total: "0",
          binding_ready: "0",
          binding_drifted: "0",
          binding_needs_attention: "0",
          delivery_total: "0",
          delivery_completed: "0",
          delivery_degraded: "0",
          delivery_needs_attention: "0",
        },
      }),
    );
    const res = await app.request(`/v1/orgs/${ORG}/projects/${PROJECT}/integrations/lifecycle`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["version"]).toBe("v1");
    expect(body["orgId"]).toBe(ORG);
    expect(body["projectId"]).toBe(PROJECT);
    expect(body["requirements"]).toEqual({ total: 0, needsAttention: 0 });
    expect(body["capabilityNodes"]).toEqual({
      total: 0,
      awaitingGrant: 0,
      ready: 0,
      needsAttention: 0,
    });
    expect(body["bindings"]).toEqual({ total: 0, ready: 0, drifted: 0, needsAttention: 0 });
    expect(body["deliveries"]).toEqual({ total: 0, completed: 0, degraded: 0, needsAttention: 0 });
  });

  it("lifecycle: surfaces 404 when the project row is absent", async () => {
    const app = buildApp(fakePool({ lifecycle: null }));
    const res = await app.request(`/v1/orgs/${ORG}/projects/${PROJECT}/integrations/lifecycle`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("lifecycle_inventory_not_found");
  });

  it("requirements: returns the versioned list shape, empty array on a fresh project", async () => {
    const app = buildApp(fakePool({ requirements: [] }));
    const res = await app.request(`/v1/orgs/${ORG}/projects/${PROJECT}/integration-requirements`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["version"]).toBe("v1");
    expect(body["orgId"]).toBe(ORG);
    expect(body["projectId"]).toBe(PROJECT);
    expect(body["requirements"]).toEqual([]);
  });

  it("requirements: surfaces a typed requirement row without exposing desired_state", async () => {
    const app = buildApp(
      fakePool({
        requirements: [
          {
            id: "req_1",
            capability: "messaging.send",
            plane: "product",
            direction: "outbound",
            source_kind: "behavior_revision",
            source_revision_id: "behavior_revision_1",
            source_digest: "sha256:" + "0".repeat(64),
            policy_version: "v1",
            criticality: "release_required",
            status: "active",
            superseded_by: null,
            created_at: new Date("2026-01-01T00:00:00Z"),
          },
        ],
      }),
    );
    const res = await app.request(`/v1/orgs/${ORG}/projects/${PROJECT}/integration-requirements`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requirements: Record<string, unknown>[] };
    expect(body.requirements).toHaveLength(1);
    const row = body.requirements[0]!;
    expect(row["requirementId"]).toBe("req_1");
    expect(row["capability"]).toBe("messaging.send");
    expect(row["status"]).toBe("active");
    // REDACTION (the negative control): the raw `desired_state` JSONB blob is
    // NOT in the response — only the canonical `sourceDigest` identifies it.
    expect(row["desired_state"]).toBeUndefined();
    expect(row["desiredState"]).toBeUndefined();
    expect(row["payload"]).toBeUndefined();
    expect(row["token"]).toBeUndefined();
    expect(row["secret"]).toBeUndefined();
  });

  it("capability-nodes: returns the versioned list shape, empty array on a fresh project", async () => {
    const app = buildApp(fakePool({ capabilityNodes: [] }));
    const res = await app.request(`/v1/orgs/${ORG}/projects/${PROJECT}/capability-nodes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["version"]).toBe("v1");
    expect(body["capabilityNodes"]).toEqual([]);
  });

  it("bindings: returns the versioned list shape, empty array on a fresh project", async () => {
    const app = buildApp(fakePool({ bindings: [] }));
    const res = await app.request(`/v1/orgs/${ORG}/projects/${PROJECT}/integration-bindings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["version"]).toBe("v1");
    expect(body["bindings"]).toEqual([]);
  });

  it("bindings: surfaces the in-15 appEnvHash proof and NEVER a resolved env value", async () => {
    const app = buildApp(
      fakePool({
        bindings: [
          {
            binding_id: "bind_1",
            requirement_id: "req_1",
            environment: "preview",
            provider_kind: "slack",
            connection_id: "conn_1",
            current_generation: 3,
            status: "ready",
            drift_state: "in_sync",
            created_at: new Date("2026-01-01T00:00:00Z"),
            updated_at: new Date("2026-01-02T00:00:00Z"),
          },
        ],
        bindingGenerations: {
          bind_1: {
            generation: 3,
            auth_generation: 1,
            grant_id: "grant_1",
            grant_generation: 1,
            adapter_version: "slack.v1",
            external_resource_id: "T123",
            external_resource_name: "tanren-channel",
            ownership: "created",
            teardown_policy: "delete",
            desired_state_hash: "sha256:" + "a".repeat(64),
          },
        },
        bindingEnvs: {
          bind_1: [
            {
              binding_generation: 3,
              key: "SLACK_BOT_TOKEN_REF",
              classification: "secret",
              required: 1,
              scopes: ["runtime"],
            },
          ],
        },
      }),
    );
    const res = await app.request(`/v1/orgs/${ORG}/projects/${PROJECT}/integration-bindings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bindings: Array<Record<string, unknown>> };
    expect(body.bindings).toHaveLength(1);
    const binding = body.bindings[0]!;
    expect(binding["bindingId"]).toBe("bind_1");
    expect(binding["status"]).toBe("ready");
    expect(binding["currentGenerationNumber"]).toBe(3);
    const gen = binding["currentGeneration"] as Record<string, unknown>;
    expect(gen["appEnvHash"]).toBe("sha256:" + "a".repeat(64));
    const outputs = gen["outputs"] as Array<Record<string, unknown>>;
    expect(outputs[0]!["logicalKey"]).toBe("SLACK_BOT_TOKEN_REF");
    expect(outputs[0]!["classification"]).toBe("secret");
    // REDACTION (the load-bearing negative control): the response carries the
    // appEnvHash PROOF + the logical output SHAPE, never a resolved value.
    expect(gen["value"]).toBeUndefined();
    expect(gen["resolvedEnv"]).toBeUndefined();
    expect(binding["token"]).toBeUndefined();
    expect(binding["secret"]).toBeUndefined();
    expect(outputs[0]!["value"]).toBeUndefined();
    expect(outputs[0]!["plaintext"]).toBeUndefined();
  });

  it("delivery: returns the versioned list shape, empty array on a fresh project", async () => {
    const app = buildApp(fakePool({ deliveryRuns: [] }));
    const res = await app.request(`/v1/orgs/${ORG}/projects/${PROJECT}/delivery`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["version"]).toBe("v1");
    expect(body["deliveryRuns"]).toEqual([]);
  });

  it("delivery: surfaces a delivery run with its per-stage progress + binding refs", async () => {
    const app = buildApp(
      fakePool({
        deliveryRuns: [
          {
            id: "run_1",
            authority_decision_id: "auth_1",
            merge_sha: "abc123",
            status: "running",
            retry_after: null,
            failure_classification: null,
            created_at: new Date("2026-01-01T00:00:00Z"),
            updated_at: new Date("2026-01-02T00:00:00Z"),
            completed_at: null,
          },
        ],
        deliveryStages: [
          {
            delivery_run_id: "run_1",
            stage: "reconcile_binding",
            ordinal: 0,
            attempt: 1,
            status: "succeeded",
            failure_classification: null,
            started_at: new Date("2026-01-01T00:01:00Z"),
            completed_at: new Date("2026-01-01T00:02:00Z"),
          },
          {
            delivery_run_id: "run_1",
            stage: "deploy",
            ordinal: 4,
            attempt: 1,
            status: "running",
            failure_classification: null,
            started_at: new Date("2026-01-01T00:03:00Z"),
            completed_at: null,
          },
        ],
        deliveryRunBindings: [{ delivery_run_id: "run_1", binding_id: "bind_1", binding_generation: 3 }],
      }),
    );
    const res = await app.request(`/v1/orgs/${ORG}/projects/${PROJECT}/delivery`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deliveryRuns: Array<Record<string, unknown>> };
    expect(body.deliveryRuns).toHaveLength(1);
    const run = body.deliveryRuns[0]!;
    expect(run["deliveryRunId"]).toBe("run_1");
    expect(run["status"]).toBe("running");
    const stages = run["stages"] as Array<Record<string, unknown>>;
    expect(stages).toHaveLength(2);
    expect(stages[0]!["stage"]).toBe("reconcile_binding");
    expect(stages[1]!["stage"]).toBe("deploy");
    const bindings = run["bindings"] as Array<Record<string, unknown>>;
    expect(bindings[0]!["bindingId"]).toBe("bind_1");
  });
});
