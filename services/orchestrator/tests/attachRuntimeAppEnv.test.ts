// attach-flow coverage: the project's RUNTIME-scoped app env is
// attached to the DEPLOYED app (right names + values reach the deploy transport),
// a non-runtime-scoped entry is NOT attached, the plaintext never appears in the
// emitted event / the result, and the flow works over both Vercel + Fly via the
// scripted transport.

import { describe, expect, it } from "vitest";
import type { OrgGrant } from "../src/engine/contracts/integrationProvisioner.js";
import type { IntegrationQueryClient } from "../src/engine/repositories/integrationQuery.js";
import { systemActor } from "../src/engine/state/actor.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { AppEnvironmentStore } from "../src/engine/repositories/appEnvironment.js";
import { attachRuntimeAppEnv } from "../src/engine/workflow/attachRuntimeAppEnv.js";
import { scriptedDeployTransport } from "./conformance/fakes/scriptedDeployTransport.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

const RUNTIME_SECRET = "re_live_super_secret";

// A minimal in-memory pg target for the lifecycle tables the attach flow reads:
// project_app_env (the runtime env) + connection/control-grant authority. Models
// rows so the flow's scope-filter + grant resolution run without a real database.
class AttachDb implements IntegrationQueryClient {
  readonly appEnvRows: Record<string, unknown>[] = [];
  readonly integrationRows: Record<string, unknown>[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(
    rawSql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    if (/INSERT INTO project_app_env/u.test(sql)) {
      const [
        orgId,
        id,
        projectId,
        environment,
        key,
        valueRef,
        plainValue,
        scopes,
        source,
        bindingId,
        bindingGeneration,
        secretGeneration,
        description,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string[],
        string,
        string | null,
        number | null,
        number | null,
        string,
      ];
      const row = {
        id,
        org_id: orgId,
        project_id: projectId,
        environment,
        key,
        value_ref: valueRef,
        plain_value: plainValue,
        scopes,
        source,
        binding_id: bindingId,
        binding_generation: bindingGeneration,
        secret_generation: secretGeneration,
        description,
      };
      this.appEnvRows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/FROM project_app_env WHERE org_id = \$1/u.test(sql)) {
      const [orgId, projectId, environment] = params as [string, string, string];
      const rows = this.appEnvRows.filter(
        (r) => r["org_id"] === orgId && r["project_id"] === projectId && r["environment"] === environment,
      );
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("WITH connection AS ( INSERT INTO org_integration_connections")) {
      const [
        orgId,
        connectionId,
        providerKind,
        upstreamAccountId,
        authKind,
        credentialRef,
        ownerId,
        metadata,
        grantId,
        capabilities,
        operations,
        providerScopes,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string[],
        string[],
        string[],
      ];
      const row = {
        connection_id: connectionId,
        grant_id: grantId,
        org_id: orgId,
        provider_kind: providerKind,
        upstream_account_id: upstreamAccountId,
        auth_kind: authKind,
        credential_ref: credentialRef,
        auth_generation: 1,
        owner_id: ownerId,
        health: "unknown",
        connection_status: "active",
        metadata: JSON.parse(metadata),
        plane: "control",
        environment: "control",
        capabilities,
        operations,
        provider_scopes: providerScopes,
        grant_generation: 1,
        grant_status: "active",
      };
      this.integrationRows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/FROM org_integration_connections c JOIN org_integration_grants g/u.test(sql)) {
      const [orgId, providerKind] = params as [string, string];
      const rows = this.integrationRows.filter((r) => r["org_id"] === orgId && r["provider_kind"] === providerKind);
      return { rows, rowCount: rows.length };
    }
    throw new Error(`AttachDb: unrecognized SQL: ${sql}`);
  }
}

async function seedAppEnv(db: AttachDb): Promise<void> {
  const client = db;
  // runtime + test → attached. A `dev`-only and a `build`/`test`-only entry must
  // NOT reach the deployed app.
  await AppEnvironmentStore.upsert(
    client,
    {
      orgId: "org_1",
      projectId: "proj",
      environment: "production",
      key: "RESEND_API_KEY",
      valueRef: "secret://proj/resend",
      secretGeneration: 1,
      scopes: ["runtime"],
    },
    systemActor,
  );
  await AppEnvironmentStore.upsert(
    client,
    {
      orgId: "org_1",
      projectId: "proj",
      environment: "production",
      key: "PUBLIC_URL",
      plainValue: "https://app.example",
      scopes: ["runtime", "build"],
    },
    systemActor,
  );
  await AppEnvironmentStore.upsert(
    client,
    {
      orgId: "org_1",
      projectId: "proj",
      environment: "production",
      key: "DEV_ONLY",
      plainValue: "dev-value",
      scopes: ["dev"],
    },
    systemActor,
  );
  await AppEnvironmentStore.upsert(
    client,
    {
      orgId: "org_1",
      projectId: "proj",
      environment: "production",
      key: "CI_ONLY",
      plainValue: "ci-value",
      scopes: ["test"],
    },
    systemActor,
  );
}

async function seedGrant(providerKind: string, metadata: Record<string, unknown>, appId: string): Promise<OrgGrant> {
  const { testOrgGrant } = await import("./helpers/orgGrant.js");
  return await testOrgGrant({
    providerKind,
    providerPrincipalId: "account-1",
    credentialRef: "secret://org/deploy-token/g/1",
    metadata,
    capability: "deploy",
    operation: "attach_runtime_env",
    target: { resourceId: appId, environment: "production" },
    orgId: "org_1",
    projectId: "proj",
  });
}

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: "secret://org/deploy-token/g/1", value: "deploy_token_value" });
  void store.put({ ref: "secret://proj/resend", value: RUNTIME_SECRET });
  return store;
}

describe("attachRuntimeAppEnv (P-APP-ENV-2)", () => {
  it("attaches only runtime-scoped entries to the Vercel app; values reach the transport", async () => {
    const db = new AttachDb();
    await seedAppEnv(db);
    const grant = await seedGrant("deploy.vercel", { teamId: "team_abc", slug: "acme" }, "prj_live");
    const transport = scriptedDeployTransport("vercel");
    const events = new FakeEventStore();

    const result = await attachRuntimeAppEnv({
      client: db,
      secrets: secrets(),
      transport,
      events,
      projectId: "proj",
      orgId: "org_1",
      deployRef: { provider: "deploy.vercel", appId: "prj_live" },
      grant,
      actor: systemActor,
    });

    // RUNTIME entries only: RESEND (secret, resolved) + PUBLIC_URL (plain). NOT
    // DEV_ONLY (dev) and NOT CI_ONLY (test).
    expect(transport.envByApp()).toEqual({
      prj_live: { RESEND_API_KEY: RUNTIME_SECRET, PUBLIC_URL: "https://app.example" },
    });
    expect(result.attachedKeys).toEqual(["PUBLIC_URL", "RESEND_API_KEY"]);
  });

  it("attaches runtime env to a Fly app in one secrets call", async () => {
    const db = new AttachDb();
    await seedAppEnv(db);
    const grant = await seedGrant("deploy.flyio", { orgSlug: "acme" }, "acme-web");
    const transport = scriptedDeployTransport("fly");

    await attachRuntimeAppEnv({
      client: db,
      secrets: secrets(),
      transport,
      events: new FakeEventStore(),
      projectId: "proj",
      orgId: "org_1",
      deployRef: { provider: "deploy.flyio", appId: "acme-web" },
      grant,
      actor: systemActor,
    });

    expect(transport.envByApp()).toEqual({
      "acme-web": { RESEND_API_KEY: RUNTIME_SECRET, PUBLIC_URL: "https://app.example" },
    });
  });

  it("the runtime VALUE never appears in the emitted event or the result", async () => {
    const db = new AttachDb();
    await seedAppEnv(db);
    const grant = await seedGrant("deploy.vercel", { teamId: "team_abc" }, "prj_live");
    const events = new FakeEventStore();

    const result = await attachRuntimeAppEnv({
      client: db,
      secrets: secrets(),
      transport: scriptedDeployTransport("vercel"),
      events,
      projectId: "proj",
      orgId: "org_1",
      deployRef: { provider: "deploy.vercel", appId: "prj_live" },
      grant,
      actor: systemActor,
    });

    // Exactly one event: app_env.runtime_attached, KEY NAMES only.
    expect(events.events).toHaveLength(1);
    const emitted = events.events[0]!;
    expect(emitted.eventType).toBe("app_env.runtime_attached");
    expect(emitted.projectId).toBe("proj");
    expect(emitted.payload).toEqual({
      provider: "deploy.vercel",
      appId: "prj_live",
      keys: ["PUBLIC_URL", "RESEND_API_KEY"],
    });
    // The secret VALUE leaks into NEITHER the event NOR the returned result.
    expect(JSON.stringify(emitted)).not.toContain(RUNTIME_SECRET);
    expect(JSON.stringify(result)).not.toContain(RUNTIME_SECRET);
  });

  it("a project with no runtime-scoped env is a no-op (no provider call, no event)", async () => {
    const db = new AttachDb();
    const client = db;
    // Only a dev-scoped entry — nothing runtime.
    await AppEnvironmentStore.upsert(
      client,
      {
        orgId: "org_1",
        projectId: "proj",
        environment: "production",
        key: "DEV_ONLY",
        plainValue: "d",
        scopes: ["dev"],
      },
      systemActor,
    );
    const grant = await seedGrant("deploy.vercel", {}, "prj_live");
    const transport = scriptedDeployTransport("vercel");
    const events = new FakeEventStore();

    const result = await attachRuntimeAppEnv({
      client,
      secrets: secrets(),
      transport,
      events,
      projectId: "proj",
      orgId: "org_1",
      deployRef: { provider: "deploy.vercel", appId: "prj_live" },
      grant,
      actor: systemActor,
    });

    expect(result.attachedKeys).toEqual([]);
    expect(transport.bearersSeen).toEqual([]);
    expect(events.events).toHaveLength(0);
  });

  it("fails loud when the supplied exact grant does not match the deployRef provider", async () => {
    const db = new AttachDb();
    await seedAppEnv(db);
    const grant = await seedGrant("deploy.flyio", {}, "prj_live");
    await expect(
      attachRuntimeAppEnv({
        client: db,
        secrets: secrets(),
        transport: scriptedDeployTransport("vercel"),
        events: new FakeEventStore(),
        projectId: "proj",
        orgId: "org_1",
        deployRef: { provider: "deploy.vercel", appId: "prj_live" },
        grant,
        actor: systemActor,
      }),
    ).rejects.toThrow(/does not match deployRef provider/u);
  });

  it("fails loud on an unknown deployRef provider before provider I/O (never a silent skip)", async () => {
    const db = new AttachDb();
    await seedAppEnv(db);
    const grant = await seedGrant("deploy.vercel", {}, "x");
    const transport = scriptedDeployTransport("vercel");
    await expect(
      attachRuntimeAppEnv({
        client: db,
        secrets: secrets(),
        transport,
        events: new FakeEventStore(),
        projectId: "proj",
        orgId: "org_1",
        deployRef: { provider: "deploy.render", appId: "x" },
        grant,
        actor: systemActor,
      }),
    ).rejects.toThrow(/does not match deployRef provider/u);
    expect(transport.bearersSeen).toEqual([]);
  });
});
