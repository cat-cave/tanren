// Vertical contract: a provisioner artifact is canonicalized by the sole inbox
// persistence seam and the exact persisted row is immediately consumable by the
// production Sentry connector. This catches producer/consumer schema drift.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { ProvisionedArtifact } from "../src/engine/contracts/integrationProvisioner.js";
import { createSentryConnector, InboxSource } from "../src/engine/forge/inbox/index.js";
import { persistProvisionedArtifact } from "../src/engine/integrations/provisioningPersistence.js";
import type { IntegrationQueryClient } from "../src/engine/repositories/integrationQuery.js";
import { InboxSourceProjectScopeError } from "../src/engine/repositories/inbox.js";
import { testSentryIntakeAuthority } from "./helpers/sentryIntakeAuthority.js";

describe("managed inbox source producer → persistence → connector", () => {
  it("persists one canonical authority-free Sentry config that the connector consumes", async () => {
    let persistedRow: Record<string, unknown> | undefined;
    const client: IntegrationQueryClient = {
      async query(sql, params = []) {
        if (!sql.includes("INSERT INTO inbox_sources")) throw new Error(`unexpected SQL: ${sql}`);
        persistedRow = {
          id: String(params[0]),
          org_id: String(params[1]),
          project_id: String(params[2]),
          kind: String(params[3]),
          name: String(params[4]),
          detail: String(params[5]),
          config: JSON.parse(String(params[6])) as unknown,
          enabled: String(params[7]),
          auto_route: String(params[8]),
          state: "active",
          attention_code: null,
          attention_message: null,
          attention_observed_at: null,
          webhook_configured: false,
          retry_not_before: null,
        };
        return { rows: [persistedRow], rowCount: 1 };
      },
    };
    const artifact: ProvisionedArtifact = {
      inboxSource: {
        kind: "errors",
        config: { org: "acme", project: "web", baseUrl: "https://sentry.example" },
      },
    };

    const surfaces = await persistProvisionedArtifact(
      client,
      { orgId: "org_a", projectId: "project_a", name: "web" },
      artifact,
      { kind: "operator", id: "user_a" },
    );
    expect(surfaces.inboxSourceId).toBe(persistedRow?.["id"]);
    expect(persistedRow?.["config"]).toEqual({
      org: "acme",
      project: "web",
      baseUrl: "https://sentry.example",
      managedBy: "integration-provisioner",
    });
    expect(JSON.stringify(persistedRow)).not.toMatch(/tokenRef|credentialRef/u);

    const source = InboxSource.parse({
      id: persistedRow?.["id"],
      orgId: persistedRow?.["org_id"],
      projectId: persistedRow?.["project_id"],
      kind: persistedRow?.["kind"],
      name: persistedRow?.["name"],
      detail: persistedRow?.["detail"],
      config: persistedRow?.["config"],
      enabled: persistedRow?.["enabled"] === "true",
      autoRoute: persistedRow?.["auto_route"] === "true",
    });
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/sentry/acme/g/1", value: "sentry-token" });
    const calls: Array<Record<string, unknown>> = [];
    const connector = createSentryConnector({
      secrets,
      authority: testSentryIntakeAuthority("credential/sentry/acme/g/1"),
      sentryHttp: {
        async request(input) {
          calls.push(input);
          return { status: 200, body: [{ id: "issue-1", title: "live defect" }] };
        },
      },
    });

    const items = await connector.fetch(source);
    expect(items.map((item) => item.title)).toEqual(["live defect"]);
    expect(calls[0]).toMatchObject({
      baseUrl: "https://sentry.example",
      token: "sentry-token",
      path: "/api/0/projects/acme/web/issues/?query=is%3Aunresolved&statsPeriod=14d",
    });
  });

  it("fails closed when the managed source project is outside the requested organization", async () => {
    const client: IntegrationQueryClient = {
      async query(sql) {
        expect(sql).toContain("FROM projects");
        expect(sql).toContain("project_id = $3 AND org_id = $2");
        return { rows: [], rowCount: 0 };
      },
    };
    await expect(
      persistProvisionedArtifact(
        client,
        { orgId: "org_a", projectId: "project_b" },
        {
          inboxSource: {
            kind: "errors",
            config: { org: "acme", project: "web", baseUrl: "https://sentry.example" },
          },
        },
        { kind: "operator", id: "user_a" },
      ),
    ).rejects.toBeInstanceOf(InboxSourceProjectScopeError);
  });
});
