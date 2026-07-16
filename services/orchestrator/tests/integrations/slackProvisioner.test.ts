import { testOrgGrant } from "../helpers/orgGrant.js";
// Slack-specific unit coverage for the Plane-A SlackProvisioner: the
// notificationTarget shape (bot channel-id model, NOT a webhook), idempotent
// find-or-create, the org bot token surfaced only as a REF (never a value), the
// name_taken race convergence, and the SecretStore-backed transport factory.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import {
  SlackProvisioner,
  secretStoreSlackTransportFactory,
  tanrenNotifyChannelName,
} from "../../src/engine/integrations/slack/slackProvisioner.js";
import type { ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import { FetchSlackApiTransport } from "../../src/engine/integrations/slack/slackApiTransport.js";
import { ScriptedSlackTransport } from "../conformance/fakes/scriptedSlackTransport.js";
import {
  projectIntegrationOperationTarget,
  type EligibleOperationExpectation,
  type IntegrationPrivilegedOperation,
} from "../../src/engine/contracts/integrationAuthority.js";

const CREDENTIAL_REF = "secret://org/slack-bot-token/g/1";

const ctx = (projectId: string): ProjectContext => ({ projectId, orgId: "org_1", orgSlug: "tanren", name: projectId });

async function operationGrant(
  projectCtx: ProjectContext,
  operation: IntegrationPrivilegedOperation,
  target: EligibleOperationExpectation["target"],
) {
  return testOrgGrant({
    providerKind: "slack",
    credentialRef: CREDENTIAL_REF,
    metadata: { workspaceId: "T123" },
    capability: "notify",
    operation,
    target,
    orgId: projectCtx.orgId,
    projectId: projectCtx.projectId,
  });
}

const provisionGrant = (projectCtx: ProjectContext) =>
  operationGrant(projectCtx, "provision", projectIntegrationOperationTarget(projectCtx));
const discoverGrant = (projectCtx: ProjectContext) => operationGrant(projectCtx, "discover", {});
const bindGrant = (projectCtx: ProjectContext, resourceId: string) =>
  operationGrant(projectCtx, "bind", projectIntegrationOperationTarget(projectCtx, resourceId));

function provisionerOver(transport: ScriptedSlackTransport): SlackProvisioner {
  // eslint-disable-next-line @typescript-eslint/require-await
  return new SlackProvisioner({ transportFactory: async () => transport });
}

describe("tanrenNotifyChannelName", () => {
  it("derives a stable lowercase tanren-<projectId> slack name", () => {
    expect(tanrenNotifyChannelName(ctx("Acme_Web.Prod"))).toBe("tanren-acme_web-prod");
  });

  it("is keyed on the project id (stable), not the mutable display name", () => {
    const a = tanrenNotifyChannelName({ projectId: "proj_42", orgId: "o", name: "First Name" });
    const b = tanrenNotifyChannelName({ projectId: "proj_42", orgId: "o", name: "Renamed Later" });
    expect(a).toBe(b);
  });
});

describe("SlackProvisioner.provision", () => {
  it("creates the project notify channel and returns a bot channel-id notificationTarget (no webhook)", async () => {
    const transport = new ScriptedSlackTransport();
    const projectCtx = ctx("alpha");
    const artifact = await provisionerOver(transport).provision(await provisionGrant(projectCtx), projectCtx);

    expect(artifact.notificationTarget?.kind).toBe("slack");
    const cfg = artifact.notificationTarget?.config ?? {};
    expect(cfg["channelId"]).toBe("C_tanren-alpha");
    expect(cfg["channelName"]).toBe("tanren-alpha");
    // The bot-token model: a channel id is the target; there is NO webhook URL.
    expect(JSON.stringify(artifact)).not.toContain("hooks.slack.com");
    expect(transport.createCount).toBe(1);
  });

  it("surfaces the org bot token only as a secret REF — never the token value", async () => {
    const transport = new ScriptedSlackTransport();
    const projectCtx = ctx("beta");
    const grant = await provisionGrant(projectCtx);
    const artifact = await provisionerOver(transport).provision(grant, projectCtx);

    expect(artifact.secretRefs?.["botToken"]).toBe(grant.eligibleOperation.credentialRef);
    // The credential ref is a pointer; the target carries the ref, not a value.
    expect(artifact.notificationTarget?.config["botTokenRef"]).toBe(grant.eligibleOperation.credentialRef);
    expect(JSON.stringify(artifact)).not.toContain("xoxb-");
  });

  it("is idempotent — a second provision reuses the same channel, never creating a duplicate", async () => {
    const transport = new ScriptedSlackTransport();
    const provisioner = provisionerOver(transport);
    const projectCtx = ctx("gamma");
    const first = await provisioner.provision(await provisionGrant(projectCtx), projectCtx);
    const second = await provisioner.provision(await provisionGrant(projectCtx), projectCtx);

    expect(second.notificationTarget?.config["channelId"]).toBe(first.notificationTarget?.config["channelId"]);
    expect(transport.createCount).toBe(1);
    const channels = await provisioner.discover(await discoverGrant(projectCtx), projectCtx);
    expect(channels.filter((c) => c.label === "tanren-gamma")).toHaveLength(1);
  });

  it("reuses a pre-existing channel of the convention name without creating one (brownfield find)", async () => {
    const transport = new ScriptedSlackTransport({
      channels: [{ id: "C_pre", name: "tanren-delta", isMember: true }],
    });
    const projectCtx = ctx("delta");
    const artifact = await provisionerOver(transport).provision(await provisionGrant(projectCtx), projectCtx);
    expect(artifact.notificationTarget?.config["channelId"]).toBe("C_pre");
    expect(transport.createCount).toBe(0);
  });

  it("ensures the bot joins a channel it found but is not yet a member of", async () => {
    const transport = new ScriptedSlackTransport({
      channels: [{ id: "C_pre", name: "tanren-epsilon", isMember: false }],
    });
    const provisioner = provisionerOver(transport);
    const projectCtx = ctx("epsilon");
    await provisioner.provision(await provisionGrant(projectCtx), projectCtx);
    const discovered = await provisioner.discover(await discoverGrant(projectCtx), projectCtx);
    expect(discovered.find((c) => c.id === "C_pre")?.metadata["isMember"]).toBe(true);
  });
});

describe("SlackProvisioner.bind", () => {
  it("links an existing channel by id and returns its bot channel-id target", async () => {
    const transport = new ScriptedSlackTransport({
      channels: [{ id: "C_team", name: "team-ops", isMember: false }],
    });
    const projectCtx = ctx("zeta");
    const grant = await bindGrant(projectCtx, "C_team");
    const artifact = await provisionerOver(transport).bind(grant, "C_team", projectCtx);
    expect(artifact.notificationTarget?.config["channelId"]).toBe("C_team");
    expect(artifact.secretRefs?.["botToken"]).toBe(grant.eligibleOperation.credentialRef);
  });

  it("rejects binding an unknown channel id (no silent success)", async () => {
    const transport = new ScriptedSlackTransport();
    const projectCtx = ctx("eta");
    await expect(
      provisionerOver(transport).bind(await bindGrant(projectCtx, "C_missing"), "C_missing", projectCtx),
    ).rejects.toThrow(/unknown Slack channel/u);
  });
});

describe("SlackProvisioner.discover", () => {
  it("lists the workspace channels as ExistingResource[] (paging through the cursor)", async () => {
    const transport = new ScriptedSlackTransport({
      channels: [
        { id: "C1", name: "general", isMember: true },
        { id: "C2", name: "random", isMember: false },
        { id: "C3", name: "ops", isMember: true },
      ],
      pageSize: 1,
    });
    const projectCtx = ctx("discover");
    const resources = await provisionerOver(transport).discover(await discoverGrant(projectCtx), projectCtx);
    expect(resources.map((r) => r.id)).toEqual(["C1", "C2", "C3"]);
    expect(resources.map((r) => r.label)).toEqual(["general", "random", "ops"]);
  });
});

describe("secretStoreSlackTransportFactory", () => {
  it("resolves the grant credential ref into a live token only inside the transport", async () => {
    const secrets = new InMemorySecretStore();
    const projectCtx = ctx("transport");
    const grant = await discoverGrant(projectCtx);
    await secrets.put({ ref: grant.eligibleOperation.credentialRef, value: "xoxb-real-token" });
    let authorization: string | null = null;
    const factory = secretStoreSlackTransportFactory(secrets, (tokenForAttempt) => {
      return new FetchSlackApiTransport(tokenForAttempt, async (_url, init) => {
        authorization = new Headers(init?.headers).get("Authorization");
        return new Response(JSON.stringify({ ok: true, user_id: "U_BOT" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
    });
    const transport = await factory(grant, {
      orgId: projectCtx.orgId,
      projectId: projectCtx.projectId,
      providerKind: "slack",
      capability: "notify",
      operation: "discover",
      target: {},
    });
    expect(transport).toBeInstanceOf(FetchSlackApiTransport);
    await transport.authTest();
    expect(authorization).toBe("Bearer xoxb-real-token");
  });

  it("throws loudly when the bot-token credential ref is missing (no silent fallback)", async () => {
    const secrets = new InMemorySecretStore();
    const factory = secretStoreSlackTransportFactory(
      secrets,
      (tokenForAttempt) => new FetchSlackApiTransport(tokenForAttempt),
    );
    const projectCtx = ctx("missing");
    const grant = await discoverGrant(projectCtx);
    const transport = await factory(grant, {
      orgId: projectCtx.orgId,
      projectId: projectCtx.projectId,
      providerKind: "slack",
      capability: "notify",
      operation: "discover",
      target: {},
    });
    await expect(transport.authTest()).rejects.toThrow(/missing integration secret for generation/u);
  });
});
