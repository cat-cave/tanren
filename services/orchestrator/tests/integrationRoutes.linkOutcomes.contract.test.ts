import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { IntegrationQueryClient, IntegrationQueryResult } from "../src/engine/repositories/integrationQuery.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import {
  mountIntegrationAuthorityWrites,
  type IntegrationAuthorityRouteDatabase,
} from "../src/routes/integrations/authorityWrites.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

const admin: ActorContext = {
  userId: "user_admin",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};

type OperationRow = Record<string, unknown>;

function operationRow(input: {
  status: string;
  stage: string;
  failureClassification?: string;
  retryAfter?: string;
}): OperationRow {
  return {
    id: "op_public",
    provider_kind: "sentry",
    connection_id: null,
    operation_kind: "link",
    stage: input.stage,
    status: input.status,
    staged_secret_handle: "secret://org/org_acme/staged/top-secret",
    candidate_principals: [],
    actor_id: "user_admin",
    verified_auth_kind: null,
    verified_scopes: [],
    verified_expires_at: null,
    failure_classification: input.failureClassification ?? null,
    compensation_state: input.retryAfter === undefined ? {} : { retryAfter: input.retryAfter },
    selected_principal_id: null,
  };
}

function harness(actor: ActorContext, row?: OperationRow) {
  const client: IntegrationQueryClient = {
    async query(): Promise<IntegrationQueryResult> {
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    },
  };
  const database: IntegrationAuthorityRouteDatabase = {
    events: new FakeEventStore(),
    async withOrgScope<T>(_orgId: string, work: (scoped: IntegrationQueryClient) => Promise<T>): Promise<T> {
      return work(client);
    },
  };
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    return next();
  });
  mountIntegrationAuthorityWrites(app, database, {}, {} as never, {} as never, fetch);
  return app;
}

const durableCases = [
  { status: "completed", stage: "completed", expected: "completed", expectedDetails: {} },
  {
    status: "failed",
    stage: "failed",
    failureClassification: "invalid_auth",
    expected: "failed",
    expectedDetails: { failureClassification: "invalid_auth" },
  },
  { status: "compensated", stage: "failed", expected: "failed", expectedDetails: {} },
  {
    status: "awaiting_principal_selection",
    stage: "awaiting_principal_selection",
    expected: "awaiting_principal_selection",
    expectedDetails: {},
  },
  { status: "pending", stage: "created", expected: "verification_in_progress", expectedDetails: {} },
  {
    status: "in_progress",
    stage: "credential_staged",
    expected: "verification_in_progress",
    expectedDetails: {},
  },
  { status: "in_progress", stage: "finalizing", expected: "finalize_pending", expectedDetails: {} },
  { status: "in_progress", stage: "activate_pending", expected: "activate_pending", expectedDetails: {} },
  {
    status: "in_progress",
    stage: "verifying",
    failureClassification: "sentry_scope_http_503",
    retryAfter: "2030-01-02T03:04:05Z",
    expected: "provider_unavailable",
    expectedDetails: {
      failureClassification: "sentry_scope_http_503",
      retryAfter: "2030-01-02T03:04:05.000Z",
    },
  },
  { status: "pending", stage: "completed", expected: "unknown", expectedDetails: {} },
] as const;

describe("integration operation public-status HTTP contract", () => {
  it.each(durableCases)("projects $status/$stage as $expected without secret coordinates", async (testCase) => {
    const response = await harness(admin, operationRow(testCase)).request(
      "/org_acme/integrations/operations/op_public",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      operationId: "op_public",
      publicStatus: testCase.expected,
      ...testCase.expectedDetails,
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("staged_secret_handle");
    expect(encoded).not.toContain("top-secret");
    expect(encoded).not.toContain("compensation_state");
  });

  it("fails hostile durable diagnostics closed instead of echoing them", async () => {
    const row = operationRow({
      status: "in_progress",
      stage: "verifying",
      failureClassification: "<script>provider body</script>",
      retryAfter: "javascript:alert(1)",
    });
    const body = await (await harness(admin, row).request("/org_acme/integrations/operations/op_public")).json();
    expect(body).toMatchObject({ publicStatus: "unknown" });
    expect(JSON.stringify(body)).not.toContain("script");
    expect(JSON.stringify(body)).not.toContain("javascript");
  });

  it("retains missing and cross-org HTTP negatives", async () => {
    expect((await harness(admin).request("/org_acme/integrations/operations/missing")).status).toBe(404);
    const outsider = { ...admin, orgId: "org_other", scopes: ["org:member"] } satisfies ActorContext;
    expect(
      (
        await harness(outsider, operationRow({ status: "completed", stage: "completed" })).request(
          "/org_acme/integrations/operations/op_public",
        )
      ).status,
    ).toBe(403);
  });
});
