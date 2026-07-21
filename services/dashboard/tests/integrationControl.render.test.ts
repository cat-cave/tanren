// in-21 — production dashboard mount + strict integration-read fact reads.
// Mock is the orchestrator HTTP boundary; createApp mounts the real screen
// registry. Covers the negative controls the audit will probe:
//   (a) cross-org caller → orchestrator returns 403 → UI renders the honest
//       unavailable panel, never a fabricated success/empty state.
//   (b) a project not visible in the operator's org → no in-20 read is fired
//       (the BFF's scope gate fails closed).
//   (c) a malformed response (wrong scope or wrong version) → the typed client
//       surfaces malformed → UI renders unavailable; the body is NOT promoted
//       to a typed value across the scope boundary.
//   (d) a legitimate-empty project (200 with `[]` rows + zero counts) is
//       honestly surfaced as an empty state, distinct from unavailable.
//   (e) the schema-catalog download serves the bundled JSON-Schema files and
//       honors the `?name=` filter, with a project-scope gate (404 on
//       non-visible project).

import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const ORG = {
  id: "org_acme",
  kind: "github_org",
  login: "cat-cave",
  displayName: "Cat Cave",
  role: "org:admin",
};
const PROJECT = {
  projectId: "project_easy",
  name: "tanren-fixture-easy",
  repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker",
};
const SHA = `sha256:${"a".repeat(64)}`;
const NOW = "2026-07-21T00:00:00.000Z";

interface ResponseScenario {
  /** Status for every in-20 endpoint; defaults to 200. */
  readonly status?: number;
  /** Override the body each endpoint returns. */
  readonly body?: unknown;
  /** Per-endpoint body override keyed by the in-20 suffix (takes precedence). */
  readonly perEndpoint?: Partial<Record<string, unknown>>;
}

let scenario: ResponseScenario;
let crossOrgCaller: boolean;
let recordedPaths: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function in20Path(projectId: string, suffix: string): string {
  return `/v1/orgs/${ORG.id}/projects/${encodeURIComponent(projectId)}/${suffix}`;
}

/**
 * The mock orchestrator: serves `/auth/me`, `/orgs`, `/orgs/:orgId/projects`,
 * and the in-20 read surface. When `crossOrgCaller` is true, every in-20 read
 * returns 403 (simulating the orchestrator's RLS guard denying a cross-org
 * request). The scope/body overrides in `scenario` let a test fake a
 * malformed response (wrong orgId or version) so the typed client's
 * scope-check is exercised.
 */
function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url).pathname;
    recordedPaths.push(path);
    if (path === "/auth/me") return json({ userId: "u1", csrfToken: "csrf-live", expiresAt: "2030-01-01" });
    if (path === "/orgs") return json({ orgs: [ORG] });
    if (path === `/orgs/${ORG.id}/projects`) return json({ projects: [PROJECT] });
    // in-20 surface endpoints — every one org+project-RLS-guarded on the
    // real orchestrator. We simulate the RLS guard by returning 403 when
    // the test sets `crossOrgCaller`.
    for (const suffix of [
      "integrations/lifecycle",
      "integration-requirements",
      "capability-nodes",
      "integration-bindings",
      "delivery",
    ]) {
      const prefix = `/v1/orgs/${ORG.id}/projects/${PROJECT.projectId}/${suffix}`;
      if (path === prefix) {
        if (crossOrgCaller) return json({ error: "org_access_denied" }, 403);
        const override = scenario.perEndpoint?.[suffix];
        const body = override ?? scenario.body ?? defaultBody(suffix);
        return json(body, scenario.status ?? 200);
      }
    }
    return new Response("not found", { status: 404 });
  });
}

function defaultBody(suffix: string): unknown {
  switch (suffix) {
    case "integrations/lifecycle":
      return {
        version: "v1",
        orgId: ORG.id,
        projectId: PROJECT.projectId,
        requirements: { total: 1, needsAttention: 0 },
        capabilityNodes: { total: 1, awaitingGrant: 0, ready: 1, needsAttention: 0 },
        bindings: { total: 1, ready: 1, drifted: 0, needsAttention: 0 },
        deliveries: { total: 1, completed: 1, degraded: 0, needsAttention: 0 },
      };
    case "integration-requirements":
      return {
        version: "v1",
        orgId: ORG.id,
        projectId: PROJECT.projectId,
        requirements: [
          {
            requirementId: "req_1",
            capability: "messaging.send",
            plane: "product",
            direction: "outbound",
            sourceKind: "behavior_revision",
            sourceRevisionId: "br_1",
            sourceDigest: SHA,
            policyVersion: "v1",
            criticality: "release_required",
            status: "active",
            supersededBy: null,
            createdAt: NOW,
          },
        ],
      };
    case "capability-nodes":
      return {
        version: "v1",
        orgId: ORG.id,
        projectId: PROJECT.projectId,
        capabilityNodes: [
          {
            nodeId: "capnode_1",
            requirementId: "req_1",
            environment: "preview",
            executorKind: "provider_operation",
            desiredStateHash: SHA,
            status: "ready",
            waitReason: null,
            priority: 5,
            generation: 1,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      };
    case "integration-bindings":
      return {
        version: "v1",
        orgId: ORG.id,
        projectId: PROJECT.projectId,
        bindings: [
          {
            bindingId: "bind_1",
            requirementId: "req_1",
            environment: "preview",
            providerKind: "slack",
            connectionId: "conn_1",
            currentGenerationNumber: 3,
            status: "ready",
            driftState: "in_sync",
            createdAt: NOW,
            updatedAt: NOW,
            currentGeneration: {
              generation: 3,
              authGeneration: 1,
              grantId: "grant_1",
              grantGeneration: 1,
              adapterVersion: "slack.v1",
              resource: { externalResourceId: "T123", externalResourceName: "tanren-channel" },
              ownership: "created",
              teardownPolicy: "delete",
              appEnvHash: SHA,
              outputs: [
                { logicalKey: "SLACK_BOT_TOKEN_REF", classification: "secret", required: true, scopes: ["runtime"] },
              ],
            },
          },
        ],
      };
    case "delivery":
      return {
        version: "v1",
        orgId: ORG.id,
        projectId: PROJECT.projectId,
        deliveryRuns: [
          {
            deliveryRunId: "delivery_1",
            authorityDecisionId: "auth_1",
            mergeSha: "abc123",
            status: "completed",
            retryAfter: null,
            failureClassification: null,
            stages: [
              {
                stage: "reconcile_binding",
                ordinal: 0,
                latestAttempt: 1,
                latestStatus: "succeeded",
                failureClassification: null,
                startedAt: NOW,
                completedAt: NOW,
              },
            ],
            bindings: [{ bindingId: "bind_1", bindingGeneration: 3 }],
            createdAt: NOW,
            updatedAt: NOW,
            completedAt: NOW,
          },
        ],
      };
    default:
      return {};
  }
}

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  scenario = {};
  crossOrgCaller = false;
  recordedPaths = [];
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("in-21 Integration Control Center", () => {
  it("mounts through the real screen registry and renders every in-20 panel with the live lifecycle rows", async () => {
    const app = await build();
    const html = await (await app.request(`/projects/${PROJECT.projectId}/integration-control`)).text();
    // The screen registered a real GET handler (no placeholder took its place).
    expect(
      app.routes.filter((route) => route.method === "GET" && route.path === "/projects/:projectId/integration-control"),
    ).toHaveLength(1);
    // The BFF fired every in-20 endpoint (proves no panel is faked — each
    // shows real data from a real read).
    for (const suffix of [
      "integrations/lifecycle",
      "integration-requirements",
      "capability-nodes",
      "integration-bindings",
      "delivery",
    ]) {
      expect(recordedPaths).toContain(in20Path(PROJECT.projectId, suffix));
    }
    // Each panel's data attribute resolves to the in-20 body.
    expect(html).toContain('data-integration-control-requirement="req_1"');
    expect(html).toContain('data-integration-control-capability-node="capnode_1"');
    expect(html).toContain('data-integration-control-binding="bind_1"');
    expect(html).toContain("data-integration-control-app-env-hash=");
    expect(html).toContain(SHA);
    expect(html).toContain('data-integration-control-delivery-run="delivery_1"');
    expect(html).toContain("Integration Control Center");
    expect(html).toContain('data-nav-id="integrations"');
  });

  it("NEGATIVE CONTROL: a cross-org caller renders every panel as unavailable, with ZERO rows fabricated", async () => {
    // The orchestrator's RLS guard denies a cross-org caller with 403. The
    // typed client surfaces `{ ok: false, failure: "unavailable" }` → every
    // panel renders the honest unavailable state. No row data is rendered.
    crossOrgCaller = true;
    const app = await build();
    const html = await (await app.request(`/projects/${PROJECT.projectId}/integration-control`)).text();
    expect(recordedPaths).toContain(in20Path(PROJECT.projectId, "integration-bindings"));
    // Every panel signals unavailable.
    expect(html).toContain('data-integration-control-unavailable="lifecycle"');
    expect(html).toContain('data-integration-control-unavailable="requirements"');
    expect(html).toContain('data-integration-control-unavailable="capabilityNodes"');
    expect(html).toContain('data-integration-control-unavailable="bindings"');
    expect(html).toContain('data-integration-control-unavailable="delivery"');
    // ZERO row data leaked to the DOM.
    expect(html).not.toContain('data-integration-control-requirement="');
    expect(html).not.toContain('data-integration-control-binding="');
    expect(html).not.toContain("data-integration-control-app-env-hash=");
    expect(html).not.toContain('data-integration-control-delivery-run="');
    // Honest copy: not a fabricated success.
    expect(html).toContain("No counts are fabricated.");
    expect(html).toContain("No binding list is fabricated.");
  });

  it("NEGATIVE CONTROL: a project not visible in the operator's org fires ZERO in-20 reads", async () => {
    // The BFF only fires in-20 reads when the path project is visible in the
    // operator's org — a non-visible project (no project row in `/orgs/:id/
    // projects`) yields the scope-blocked state and NO endpoint is hit.
    const app = await build();
    const html = await (await app.request(`/projects/project_other/integration-control`)).text();
    for (const suffix of ["integrations/lifecycle", "integration-bindings", "delivery"]) {
      expect(recordedPaths).not.toContain(in20Path("project_other", suffix));
    }
    expect(html).toContain("data-integration-control-no-project");
    expect(html).toContain("not visible in this organization");
  });

  it("NEGATIVE CONTROL: a malformed scope on the bindings body is rejected as unavailable (no leak across the scope boundary)", async () => {
    // The orchestrator returns a 200 with a body carrying the WRONG org id
    // (simulating a leaky orchestrator). The typed client's scope check
    // rejects this as malformed → the UI renders the unavailable state. The
    // row data does NOT leak to the DOM.
    scenario = {
      perEndpoint: {
        "integration-bindings": {
          version: "v1",
          orgId: "org_other",
          projectId: PROJECT.projectId,
          bindings: [
            {
              bindingId: "bind_leaked",
              requirementId: "req_1",
              environment: "preview",
              providerKind: "slack",
              connectionId: "conn_1",
              currentGenerationNumber: 1,
              status: "ready",
              driftState: "in_sync",
              createdAt: NOW,
              updatedAt: NOW,
              currentGeneration: null,
            },
          ],
        },
      },
    };
    const app = await build();
    const html = await (await app.request(`/projects/${PROJECT.projectId}/integration-control`)).text();
    // The bindings endpoint was hit but the body was rejected → unavailable.
    expect(recordedPaths).toContain(in20Path(PROJECT.projectId, "integration-bindings"));
    expect(html).toContain('data-integration-control-unavailable="bindings"');
    // The leaked binding id does NOT render anywhere in the DOM.
    expect(html).not.toContain("bind_leaked");
  });

  it("NEGATIVE CONTROL: a wrong version tag on the lifecycle body is rejected (no surface-version downgrade)", async () => {
    // A response carrying `version: "v2"` (a future-version the dashboard
    // does not yet understand) must NOT be silently rendered as if it were
    // v1 — the typed client rejects it as malformed.
    scenario = {
      perEndpoint: {
        "integrations/lifecycle": {
          version: "v2",
          orgId: ORG.id,
          projectId: PROJECT.projectId,
          requirements: { total: 9, needsAttention: 0 },
          capabilityNodes: { total: 0, awaitingGrant: 0, ready: 0, needsAttention: 0 },
          bindings: { total: 0, ready: 0, drifted: 0, needsAttention: 0 },
          deliveries: { total: 0, completed: 0, degraded: 0, needsAttention: 0 },
        },
      },
    };
    const app = await build();
    const html = await (await app.request(`/projects/${PROJECT.projectId}/integration-control`)).text();
    expect(html).toContain('data-integration-control-unavailable="lifecycle"');
    expect(html).not.toContain(">9<");
  });

  it("renders a legitimate-empty project honestly: empty (NOT unavailable), with no fabricated rows", async () => {
    // Every endpoint returns 200 with `[]` rows and zero counts. The UI
    // surfaces the empty state (distinct from unavailable) — an honest
    // "nothing here yet" instead of a failure.
    scenario = {
      perEndpoint: {
        "integrations/lifecycle": {
          version: "v1",
          orgId: ORG.id,
          projectId: PROJECT.projectId,
          requirements: { total: 0, needsAttention: 0 },
          capabilityNodes: { total: 0, awaitingGrant: 0, ready: 0, needsAttention: 0 },
          bindings: { total: 0, ready: 0, drifted: 0, needsAttention: 0 },
          deliveries: { total: 0, completed: 0, degraded: 0, needsAttention: 0 },
        },
        "integration-requirements": {
          version: "v1",
          orgId: ORG.id,
          projectId: PROJECT.projectId,
          requirements: [],
        },
        "capability-nodes": {
          version: "v1",
          orgId: ORG.id,
          projectId: PROJECT.projectId,
          capabilityNodes: [],
        },
        "integration-bindings": {
          version: "v1",
          orgId: ORG.id,
          projectId: PROJECT.projectId,
          bindings: [],
        },
        delivery: {
          version: "v1",
          orgId: ORG.id,
          projectId: PROJECT.projectId,
          deliveryRuns: [],
        },
      },
    };
    const app = await build();
    const html = await (await app.request(`/projects/${PROJECT.projectId}/integration-control`)).text();
    // Every panel signals honest-empty (not unavailable).
    expect(html).toContain('data-integration-control-empty="lifecycle"');
    expect(html).toContain('data-integration-control-empty="requirements"');
    expect(html).toContain('data-integration-control-empty="capabilityNodes"');
    expect(html).toContain('data-integration-control-empty="bindings"');
    expect(html).toContain('data-integration-control-empty="delivery"');
    expect(html).not.toContain('data-integration-control-unavailable="lifecycle"');
    expect(html).not.toContain('data-integration-control-unavailable="bindings"');
    expect(html).not.toContain('data-integration-control-unavailable="delivery"');
  });

  it("renders the appEnvHash PROOF and never a resolved env value or token", async () => {
    // The bindings panel shows the in-15 appEnvHash content digest; it NEVER
    // shows a resolved env value, a token, or a principal secret.
    const app = await build();
    const html = await (await app.request(`/projects/${PROJECT.projectId}/integration-control`)).text();
    expect(html).toContain(SHA);
    expect(html).toContain("appEnvHash PROOF");
    expect(html).toContain("SLACK_BOT_TOKEN_REF");
    expect(html).not.toContain("xoxb-");
    expect(html).not.toContain('"token"');
    expect(html).not.toContain('"secret"');
    expect(html).not.toContain("resolvedEnv");
    expect(html).not.toContain('"value"');
  });

  it("exposes the schema-catalog download endpoint on a visible project and serves the bundled JSON-Schema files", async () => {
    const app = await build();
    const res = await app.request(`/projects/${PROJECT.projectId}/integration-control/schemas.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const body = (await res.json()) as { version: string; schemas: { name: string; schemaId: string }[] };
    expect(body.version).toBe("v1");
    expect(body.schemas).toHaveLength(5);
    expect(body.schemas.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        "CapabilityNodesResponse",
        "IntegrationBindingsResponse",
        "IntegrationLifecycleInventoryResponse",
        "IntegrationRequirementsResponse",
        "DeliveryDagStatusResponse",
      ]),
    );
  });

  it("serves a single schema entry via ?name= with the schema+json content type", async () => {
    const app = await build();
    const res = await app.request(
      `/projects/${PROJECT.projectId}/integration-control/schemas.json?name=IntegrationBindingsResponse`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/schema+json");
    expect(res.headers.get("content-disposition")).toContain("IntegrationBindingsResponse.json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["x-tanren-schema-id"]).toBe("tanren.integrations.read.v1.IntegrationBindingsResponse");
  });

  it("NEGATIVE CONTROL: schema download on a non-visible project returns 404; unknown name returns 404 (no fallback)", async () => {
    const app = await build();
    const scopeRes = await app.request(`/projects/project_other/integration-control/schemas.json`);
    expect(scopeRes.status).toBe(404);
    expect(((await scopeRes.json()) as { error: string }).error).toBe("project_scope_required");
    const unknownRes = await app.request(
      `/projects/${PROJECT.projectId}/integration-control/schemas.json?name=DefinitelyNotARealSchema`,
    );
    expect(unknownRes.status).toBe(404);
    const unknown = (await unknownRes.json()) as { error: string; name: string };
    expect(unknown.error).toBe("schema_not_found");
    expect(unknown.name).toBe("DefinitelyNotARealSchema");
  });

  it("renders the schema-catalog panel with a download link per schema and a bundled-download button", async () => {
    const app = await build();
    const html = await (await app.request(`/projects/${PROJECT.projectId}/integration-control`)).text();
    expect(html).toContain("data-integration-control-schemas");
    expect(html).toContain('data-integration-control-schema-download="CapabilityNodesResponse"');
    expect(html).toContain('data-integration-control-schema-download="IntegrationBindingsResponse"');
    expect(html).toContain('data-integration-control-schema-download="bundle"');
    expect(html).toContain("/integration-control/schemas.json");
  });
});
