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
import type { OrgGrant, ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import { FetchSlackApiTransport } from "../../src/engine/integrations/slack/slackApiTransport.js";
import { ScriptedSlackTransport } from "../conformance/fakes/scriptedSlackTransport.js";

const grant: OrgGrant = {
  providerKind: "slack",
  credentialRef: "secret://org/slack-bot-token",
  metadata: { workspaceId: "T123" },
};

const ctx = (projectId: string): ProjectContext => ({ projectId, orgId: "org_1", orgSlug: "tanren", name: projectId });

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
    const artifact = await provisionerOver(transport).provision(grant, ctx("alpha"));

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
    const artifact = await provisionerOver(transport).provision(grant, ctx("beta"));

    expect(artifact.secretRefs?.["botToken"]).toBe(grant.credentialRef);
    // The credential ref is a pointer; the target carries the ref, not a value.
    expect(artifact.notificationTarget?.config["botTokenRef"]).toBe(grant.credentialRef);
    expect(JSON.stringify(artifact)).not.toContain("xoxb-");
  });

  it("is idempotent — a second provision reuses the same channel, never creating a duplicate", async () => {
    const transport = new ScriptedSlackTransport();
    const provisioner = provisionerOver(transport);
    const first = await provisioner.provision(grant, ctx("gamma"));
    const second = await provisioner.provision(grant, ctx("gamma"));

    expect(second.notificationTarget?.config["channelId"]).toBe(first.notificationTarget?.config["channelId"]);
    expect(transport.createCount).toBe(1);
    const channels = await provisioner.discover(grant);
    expect(channels.filter((c) => c.label === "tanren-gamma")).toHaveLength(1);
  });

  it("reuses a pre-existing channel of the convention name without creating one (brownfield find)", async () => {
    const transport = new ScriptedSlackTransport({
      channels: [{ id: "C_pre", name: "tanren-delta", isMember: true }],
    });
    const artifact = await provisionerOver(transport).provision(grant, ctx("delta"));
    expect(artifact.notificationTarget?.config["channelId"]).toBe("C_pre");
    expect(transport.createCount).toBe(0);
  });

  it("ensures the bot joins a channel it found but is not yet a member of", async () => {
    const transport = new ScriptedSlackTransport({
      channels: [{ id: "C_pre", name: "tanren-epsilon", isMember: false }],
    });
    const provisioner = provisionerOver(transport);
    await provisioner.provision(grant, ctx("epsilon"));
    const discovered = await provisioner.discover(grant);
    expect(discovered.find((c) => c.id === "C_pre")?.metadata["isMember"]).toBe(true);
  });
});

describe("SlackProvisioner.bind", () => {
  it("links an existing channel by id and returns its bot channel-id target", async () => {
    const transport = new ScriptedSlackTransport({
      channels: [{ id: "C_team", name: "team-ops", isMember: false }],
    });
    const artifact = await provisionerOver(transport).bind(grant, "C_team", ctx("zeta"));
    expect(artifact.notificationTarget?.config["channelId"]).toBe("C_team");
    expect(artifact.secretRefs?.["botToken"]).toBe(grant.credentialRef);
  });

  it("rejects binding an unknown channel id (no silent success)", async () => {
    const transport = new ScriptedSlackTransport();
    await expect(provisionerOver(transport).bind(grant, "C_missing", ctx("eta"))).rejects.toThrow(
      /unknown Slack channel/u,
    );
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
    const resources = await provisionerOver(transport).discover(grant);
    expect(resources.map((r) => r.id)).toEqual(["C1", "C2", "C3"]);
    expect(resources.map((r) => r.label)).toEqual(["general", "random", "ops"]);
  });
});

describe("secretStoreSlackTransportFactory", () => {
  it("resolves the grant credential ref into a live token only inside the transport", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: grant.credentialRef, value: "xoxb-real-token" });
    let handed: string | undefined;
    const factory = secretStoreSlackTransportFactory(secrets, (token) => {
      handed = token;
      return new FetchSlackApiTransport(token, () => {
        throw new Error("no network in this test");
      });
    });
    const transport = await factory(grant);
    expect(transport).toBeInstanceOf(FetchSlackApiTransport);
    expect(handed).toBe("xoxb-real-token");
  });

  it("throws loudly when the bot-token credential ref is missing (no silent fallback)", async () => {
    const secrets = new InMemorySecretStore();
    const factory = secretStoreSlackTransportFactory(secrets, (token) => new FetchSlackApiTransport(token));
    await expect(factory(grant)).rejects.toThrow(/missing Slack bot-token credential ref/u);
  });
});
