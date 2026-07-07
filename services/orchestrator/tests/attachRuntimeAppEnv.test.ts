// attach-flow coverage: the project's RUNTIME-scoped app env is
// attached to the DEPLOYED app (right names + values reach the deploy transport),
// a non-runtime-scoped entry is NOT attached, the plaintext never appears in the
// emitted event / the result, and the flow works over both Vercel + Fly via the
// scripted transport.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { systemActor } from "../src/engine/state/actor.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { AppEnvironmentStore } from "../src/engine/repositories/appEnvironment.js";
import { OrgIntegrationsStore } from "../src/engine/repositories/orgIntegrations.js";
import { attachRuntimeAppEnv } from "../src/engine/workflow/attachRuntimeAppEnv.js";
import { scriptedDeployTransport } from "./conformance/fakes/scriptedDeployTransport.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

const RUNTIME_SECRET = "re_live_super_secret";

// A minimal in-memory pg target for the two tables the attach flow reads:
// project_app_env (the runtime env) + org_integrations (the deploy grant). Models
// rows so the flow's scope-filter + grant resolution run without a real database.
class AttachDb {
  readonly appEnvRows: Record<string, unknown>[] = [];
  readonly orgIntegrationRows: Record<string, unknown>[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(
    rawSql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    if (/INSERT INTO project_app_env/u.test(sql)) {
      const [id, projectId, key, valueRef, plainValue, scopes, source, description] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        string[],
        string,
        string,
      ];
      const row = {
        id,
        project_id: projectId,
        key,
        value_ref: valueRef,
        plain_value: plainValue,
        scopes,
        source,
        description,
      };
      this.appEnvRows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/FROM project_app_env WHERE project_id = \$1/u.test(sql)) {
      const [projectId] = params as [string];
      const rows = this.appEnvRows.filter((r) => r["project_id"] === projectId);
      return { rows, rowCount: rows.length };
    }
    if (/INSERT INTO org_integrations/u.test(sql)) {
      const [id, orgId, providerKind, credentialRef, metadata, capabilities, status] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const row = {
        id,
        org_id: orgId,
        provider_kind: providerKind,
        credential_ref: credentialRef,
        metadata: JSON.parse(metadata),
        capabilities: JSON.parse(capabilities),
        status,
      };
      this.orgIntegrationRows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/FROM org_integrations WHERE org_id = \$1 AND provider_kind = \$2/u.test(sql)) {
      const [orgId, providerKind] = params as [string, string];
      const rows = this.orgIntegrationRows.filter((r) => r["org_id"] === orgId && r["provider_kind"] === providerKind);
      return { rows, rowCount: rows.length };
    }
    throw new Error(`AttachDb: unrecognized SQL: ${sql}`);
  }
}

type Client = Pick<pg.Pool, "query">;

async function seedAppEnv(db: AttachDb): Promise<void> {
  const client = db as unknown as Client;
  // runtime + test → attached. A `dev`-only and a `build`/`test`-only entry must
  // NOT reach the deployed app.
  await AppEnvironmentStore.upsert(
    client,
    { projectId: "proj", key: "RESEND_API_KEY", valueRef: "secret://proj/resend", scopes: ["runtime"] },
    systemActor,
  );
  await AppEnvironmentStore.upsert(
    client,
    { projectId: "proj", key: "PUBLIC_URL", plainValue: "https://app.example", scopes: ["runtime", "build"] },
    systemActor,
  );
  await AppEnvironmentStore.upsert(
    client,
    { projectId: "proj", key: "DEV_ONLY", plainValue: "dev-value", scopes: ["dev"] },
    systemActor,
  );
  await AppEnvironmentStore.upsert(
    client,
    { projectId: "proj", key: "CI_ONLY", plainValue: "ci-value", scopes: ["test"] },
    systemActor,
  );
}

async function seedGrant(db: AttachDb, providerKind: string, metadata: Record<string, unknown>): Promise<void> {
  await OrgIntegrationsStore.upsert(
    db as unknown as Client,
    { orgId: "org_1", providerKind, credentialRef: "secret://org/deploy-token", metadata, capabilities: ["deploy"] },
    systemActor,
  );
}

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: "secret://org/deploy-token", value: "deploy_token_value" });
  void store.put({ ref: "secret://proj/resend", value: RUNTIME_SECRET });
  return store;
}

describe("attachRuntimeAppEnv (P-APP-ENV-2)", () => {
  it("attaches only runtime-scoped entries to the Vercel app; values reach the transport", async () => {
    const db = new AttachDb();
    await seedAppEnv(db);
    await seedGrant(db, "deploy.vercel", { teamId: "team_abc", slug: "acme" });
    const transport = scriptedDeployTransport("vercel");
    const events = new FakeEventStore();

    const result = await attachRuntimeAppEnv({
      client: db as unknown as Client,
      secrets: secrets(),
      transport,
      events,
      projectId: "proj",
      orgId: "org_1",
      deployRef: { provider: "deploy.vercel", appId: "prj_live" },
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
    await seedGrant(db, "deploy.flyio", { orgSlug: "acme" });
    const transport = scriptedDeployTransport("fly");

    await attachRuntimeAppEnv({
      client: db as unknown as Client,
      secrets: secrets(),
      transport,
      events: new FakeEventStore(),
      projectId: "proj",
      orgId: "org_1",
      deployRef: { provider: "deploy.flyio", appId: "acme-web" },
      actor: systemActor,
    });

    expect(transport.envByApp()).toEqual({
      "acme-web": { RESEND_API_KEY: RUNTIME_SECRET, PUBLIC_URL: "https://app.example" },
    });
  });

  it("the runtime VALUE never appears in the emitted event or the result", async () => {
    const db = new AttachDb();
    await seedAppEnv(db);
    await seedGrant(db, "deploy.vercel", { teamId: "team_abc" });
    const events = new FakeEventStore();

    const result = await attachRuntimeAppEnv({
      client: db as unknown as Client,
      secrets: secrets(),
      transport: scriptedDeployTransport("vercel"),
      events,
      projectId: "proj",
      orgId: "org_1",
      deployRef: { provider: "deploy.vercel", appId: "prj_live" },
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
    const client = db as unknown as Client;
    // Only a dev-scoped entry — nothing runtime.
    await AppEnvironmentStore.upsert(
      client,
      { projectId: "proj", key: "DEV_ONLY", plainValue: "d", scopes: ["dev"] },
      systemActor,
    );
    await seedGrant(db, "deploy.vercel", {});
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
      actor: systemActor,
    });

    expect(result.attachedKeys).toEqual([]);
    expect(transport.bearersSeen).toEqual([]);
    expect(events.events).toHaveLength(0);
  });

  it("fails loud when the org has no deploy grant for the deployRef provider", async () => {
    const db = new AttachDb();
    await seedAppEnv(db);
    // No grant seeded.
    await expect(
      attachRuntimeAppEnv({
        client: db as unknown as Client,
        secrets: secrets(),
        transport: scriptedDeployTransport("vercel"),
        events: new FakeEventStore(),
        projectId: "proj",
        orgId: "org_1",
        deployRef: { provider: "deploy.vercel", appId: "prj_live" },
        actor: systemActor,
      }),
    ).rejects.toThrow(/no 'deploy\.vercel' grant/u);
  });

  it("fails loud on an unknown deployRef provider (never a silent skip)", async () => {
    const db = new AttachDb();
    await seedAppEnv(db);
    await seedGrant(db, "deploy.render", {});
    await expect(
      attachRuntimeAppEnv({
        client: db as unknown as Client,
        secrets: secrets(),
        transport: scriptedDeployTransport("vercel"),
        events: new FakeEventStore(),
        projectId: "proj",
        orgId: "org_1",
        deployRef: { provider: "deploy.render", appId: "x" },
        actor: systemActor,
      }),
    ).rejects.toThrow(/is not a deploy provisioner/u);
  });
});
