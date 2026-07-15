import { describe, expect, it } from "vitest";
import {
  credentialRefForIntegrationAccount,
  IntegrationConnectionsStore,
} from "../../src/engine/repositories/integrationConnections.js";
import { systemActor } from "../../src/engine/state/actor.js";
import { IntegrationMemoryDb } from "../helpers/integrationMemoryDb.js";
import { preflightGreenfieldDeploy } from "../../src/routes/projects/greenfieldDeployAuthority.js";

const linkInput = {
  orgId: "org_a",
  providerKind: "sentry",
  upstreamAccountId: "account-a",
  authKind: "api_key" as const,
  credentialRef: "secret://org_a/sentry/a",
  capabilities: ["errors"],
};

describe("IntegrationConnectionsStore conformance", () => {
  it("requires a durable project selection instead of choosing an eligible account", async () => {
    const db = new IntegrationMemoryDb();
    db.seedProject("proj_a", "org_a");
    const client = db.clientForOrg("org_a");
    const linked = await IntegrationConnectionsStore.linkControlGrant(client, linkInput, systemActor);

    expect(
      await IntegrationConnectionsStore.resolveControlGrant(client, "org_a", "proj_a", "sentry", systemActor),
    ).toMatchObject({
      status: "selection_required",
      reason: "selection_missing",
    });
    const selected = await IntegrationConnectionsStore.selectControlGrant(
      client,
      {
        orgId: "org_a",
        projectId: "proj_a",
        providerKind: "sentry",
        connectionId: linked.connectionId,
        grantId: linked.grantId,
      },
      systemActor,
    );
    expect(selected).toMatchObject({ connectionId: linked.connectionId, grantId: linked.grantId });
    expect(
      await IntegrationConnectionsStore.resolveControlGrant(client, "org_a", "proj_a", "sentry", systemActor),
    ).toMatchObject({
      status: "selected",
      grant: { connectionId: linked.connectionId, grantId: linked.grantId },
    });
  });

  it("isolates account credentials and rotates only the matching account", async () => {
    const db = new IntegrationMemoryDb();
    const client = db.clientForOrg("org_a");
    const accountARef = credentialRefForIntegrationAccount("org_a", "sentry", "account-a");
    const accountBRef = credentialRefForIntegrationAccount("org_a", "sentry", "account-b");
    expect(accountARef).not.toBe(accountBRef);
    expect(credentialRefForIntegrationAccount("org_a", "sentry", "account-a")).toBe(accountARef);

    await IntegrationConnectionsStore.linkControlGrant(
      client,
      { ...linkInput, credentialRef: accountARef },
      systemActor,
    );
    await IntegrationConnectionsStore.linkControlGrant(
      client,
      { ...linkInput, upstreamAccountId: "account-b", credentialRef: accountBRef },
      systemActor,
    );
    const rotated = await IntegrationConnectionsStore.linkControlGrant(
      client,
      { ...linkInput, credentialRef: accountARef },
      systemActor,
    );
    const rows = await IntegrationConnectionsStore.listControlGrants(client, "org_a", systemActor);
    expect(rotated).toMatchObject({ authGeneration: 2, grantGeneration: 2 });
    expect(rows.find((row) => row.upstreamAccountId === "account-b")).toMatchObject({
      credentialRef: accountBRef,
      authGeneration: 1,
      grantGeneration: 1,
    });
  });

  it("reports ambiguity and a stale selection without falling back to newest", async () => {
    const db = new IntegrationMemoryDb();
    db.seedProject("proj_a", "org_a");
    const client = db.clientForOrg("org_a");
    const first = await IntegrationConnectionsStore.linkControlGrant(client, linkInput, systemActor);
    await IntegrationConnectionsStore.linkControlGrant(
      client,
      { ...linkInput, upstreamAccountId: "account-b", credentialRef: "secret://org_a/sentry/b" },
      systemActor,
    );
    expect(
      await IntegrationConnectionsStore.resolveControlGrant(client, "org_a", "proj_a", "sentry", systemActor),
    ).toMatchObject({
      status: "selection_required",
      reason: "multiple_eligible",
    });
    await IntegrationConnectionsStore.selectControlGrant(
      client,
      {
        orgId: "org_a",
        projectId: "proj_a",
        providerKind: "sentry",
        connectionId: first.connectionId,
        grantId: first.grantId,
      },
      systemActor,
    );
    await IntegrationConnectionsStore.revoke(client, "org_a", first.connectionId, systemActor);
    expect(
      await IntegrationConnectionsStore.resolveControlGrant(client, "org_a", "proj_a", "sentry", systemActor),
    ).toMatchObject({
      status: "selection_required",
      reason: "selected_grant_unavailable",
    });
  });

  it("keeps off-org reads empty", async () => {
    const db = new IntegrationMemoryDb();
    const client = db.clientForOrg("org_a");
    await IntegrationConnectionsStore.linkControlGrant(client, linkInput, systemActor);
    expect(await IntegrationConnectionsStore.listControlGrants(db.clientForOrg("org_b"), "org_a", systemActor)).toEqual(
      [],
    );
  });

  it("requires an exact greenfield account before any external resource is created", async () => {
    const db = new IntegrationMemoryDb();
    const client = db.clientForOrg("org_a");
    const first = await IntegrationConnectionsStore.linkControlGrant(
      client,
      { ...linkInput, providerKind: "deploy.vercel", capabilities: ["deploy"] },
      systemActor,
    );
    await IntegrationConnectionsStore.linkControlGrant(
      client,
      {
        ...linkInput,
        providerKind: "deploy.vercel",
        upstreamAccountId: "account-b",
        credentialRef: "secret://org_a/vercel/b",
        capabilities: ["deploy"],
      },
      systemActor,
    );
    const base = {
      client,
      orgId: "org_a",
      providerKind: "deploy.vercel" as const,
      actorId: "user_a",
    };
    await expect(preflightGreenfieldDeploy(base)).resolves.toMatchObject({
      status: "selection_required",
      reason: "multiple_eligible",
    });
    await expect(
      preflightGreenfieldDeploy({ ...base, connectionId: first.connectionId, grantId: first.grantId }),
    ).resolves.toBeUndefined();
    await expect(preflightGreenfieldDeploy({ ...base, connectionId: "gone", grantId: "gone" })).resolves.toMatchObject({
      status: "selection_required",
      reason: "selected_grant_unavailable",
    });
  });
});
