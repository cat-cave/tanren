import { describe, expect, it } from "vitest";
import { persistProvisionedArtifact } from "../src/engine/integrations/provisioningPersistence.js";
import type { IntegrationQueryClient, IntegrationQueryResult } from "../src/engine/repositories/integrationQuery.js";
import type { ProvisionedArtifact } from "../src/engine/contracts/integrationProvisioner.js";
import { systemActor } from "../src/engine/state/actor.js";

// gv-6 Slack provisioner ↔ persistence ↔ channel contract. The runtime Slack
// channel is an INCOMING-WEBHOOK publisher, so the persisted target `destination`
// MUST be a webhook credential ref. The persistence layer must NEVER store a bot
// token ref as a webhook destination (the mismatch that POSTed an xoxb-… token as
// a webhook). It selects the webhook ref, not `botTokenRef`, and fail-loud rejects
// a bot-token + channel-id artifact that carries no webhook ref.

const actor = systemActor;

class RecordingClient implements IntegrationQueryClient {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  async query(sql: string, params: unknown[] = []): Promise<IntegrationQueryResult> {
    this.queries.push({ sql, params });
    if (sql.includes("INSERT INTO notification_targets")) {
      return { rows: [{ id: "notif_target_persisted" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("slack notification target persistence contract (gv-6)", () => {
  it("rejects the provisioner's bot-token + channel-id artifact (no webhook ref) — never stores a token as a webhook", async () => {
    const client = new RecordingClient();
    // This is exactly what SlackProvisioner.artifactFor now emits: channel id +
    // name, and the bot token ref surfaced ONLY under secretRefs (NOT in config).
    const artifact: ProvisionedArtifact = {
      secretRefs: { botToken: "secret://org/slack-bot-token/g/1" },
      notificationTarget: {
        kind: "slack",
        config: { channelId: "C_tanren-x", channelName: "tanren-x" },
      },
    };
    await expect(
      persistProvisionedArtifact(client, { projectId: "p", orgId: "org_1" }, artifact, actor),
    ).rejects.toThrow(/no incoming-webhook credential ref/u);
    // Nothing was written.
    expect(client.queries.some((q) => q.sql.includes("INSERT INTO notification_targets"))).toBe(false);
  });

  it("persists a Slack target when it carries an incoming-webhook credential ref", async () => {
    const client = new RecordingClient();
    const artifact: ProvisionedArtifact = {
      notificationTarget: {
        kind: "slack",
        config: { webhookRef: "credential/slack/incoming-webhook" },
      },
    };
    const surfaces = await persistProvisionedArtifact(client, { projectId: "p", orgId: "org_1" }, artifact, actor);
    expect(surfaces.notificationTargetId).toBe("notif_target_persisted");
    const insert = client.queries.find((q) => q.sql.includes("INSERT INTO notification_targets"))!;
    // params: [id, orgId, channelKind, destination, label] — destination is the webhook ref.
    expect(insert.params[2]).toBe("slack");
    expect(insert.params[3]).toBe("credential/slack/incoming-webhook");
  });
});
