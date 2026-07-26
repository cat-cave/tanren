import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { IntegrationProvisioner } from "../src/engine/contracts/integrationProvisioner.js";
import { provisionCapability } from "../src/engine/integrations/provisioningEngine.js";
import { PgIntegrationAuthority } from "../src/engine/integrations/integrationAuthorityImpl.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { ACTOR, ORG, PROJECT, freshState, StubDatabase } from "./integrationProvisioningEngine.test.js";

describe("provisionCapability — Slack notify", () => {
  it("rejects an unlinked Slack request before the provisioner can perform provider I/O", async () => {
    const state = freshState(false);
    let providerCalls = 0;
    const provisioner: IntegrationProvisioner = {
      capability: () => ["notify"],
      discover: async () => {
        providerCalls += 1;
        return [];
      },
      provision: async () => {
        providerCalls += 1;
        return { notificationTarget: { kind: "slack", config: { botTokenRef: "secret://bot", channelId: "C1" } } };
      },
      bind: async () => {
        providerCalls += 1;
        return { notificationTarget: { kind: "slack", config: { botTokenRef: "secret://bot", channelId: "C1" } } };
      },
    };
    const outcome = await provisionCapability(
      {
        database: new StubDatabase(state),
        secrets: new InMemorySecretStore(),
        events: new FakeEventStore(),
        actor: ACTOR,
        authority: new PgIntegrationAuthority(),
        buildProvisioner: () => provisioner,
      },
      { orgId: ORG, projectId: PROJECT, capability: "notify", mode: "greenfield", name: "acme-web" },
    );
    expect(outcome).toMatchObject({ status: "not_linked", capability: "notify", providerKind: "slack" });
    expect(providerCalls).toBe(0);
  });

  it("provisions Slack through the ordinary authority/provider/persistence path", async () => {
    const state = freshState(true, "slack");
    let provisionCalls = 0;
    const provisioner: IntegrationProvisioner = {
      capability: () => ["notify"],
      discover: async () => [],
      provision: async () => {
        provisionCalls += 1;
        return {
          projectConfig: { slackChannelId: "C_NOTIFY" },
          secretRefs: { botToken: "secret://org/slack/bot/g/1" },
          notificationTarget: {
            kind: "slack",
            config: { botTokenRef: "secret://org/slack/bot/g/1", channelId: "C_NOTIFY" },
          },
        };
      },
      bind: async () => {
        throw new Error("unexpected bind");
      },
    };
    const outcome = await provisionCapability(
      {
        database: new StubDatabase(state),
        secrets: new InMemorySecretStore(),
        events: new FakeEventStore(),
        actor: ACTOR,
        authority: new PgIntegrationAuthority(),
        buildProvisioner: () => provisioner,
      },
      { orgId: ORG, projectId: PROJECT, capability: "notify", mode: "greenfield", name: "acme-web" },
    );
    expect(outcome).toMatchObject({
      status: "provisioned",
      capability: "notify",
      providerKind: "slack",
      action: "provision",
    });
    expect(provisionCalls).toBe(1);
    expect(state.notificationTargets).toHaveLength(1);
    expect(state.notificationTargets[0]?.destination).toBe(
      `slack-bot-v1:${encodeURIComponent("secret://org/slack/bot/g/1")}:C_NOTIFY`,
    );
  });
});
