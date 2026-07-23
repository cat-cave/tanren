import { describe, expect, it } from "vitest";
import { persistProvisionedArtifact } from "../src/engine/integrations/provisioningPersistence.js";
import type { IntegrationQueryClient, IntegrationQueryResult } from "../src/engine/repositories/integrationQuery.js";
import type { ProvisionedArtifact } from "../src/engine/contracts/integrationProvisioner.js";
import { systemActor } from "../src/engine/state/actor.js";

// Slack provisioner ↔ persistence ↔ channel contract. Bot delivery stores a
// versioned opaque target containing the credential REF and channel id; it never
// persists a token as a webhook destination. Legacy incoming-webhook targets
// remain supported.

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

describe("slack notification target persistence contract", () => {
  it("persists bot delivery coordinates as an opaque target, never as a webhook", async () => {
    const client = new RecordingClient();
    const artifact: ProvisionedArtifact = {
      secretRefs: { botToken: "secret://org/slack-bot-token/g/1" },
      notificationTarget: {
        kind: "slack",
        config: { botTokenRef: "secret://org/slack-bot-token/g/1", channelId: "C_tanren-x", channelName: "tanren-x" },
      },
    };
    const surfaces = await persistProvisionedArtifact(client, { projectId: "p", orgId: "org_1" }, artifact, actor);
    expect(surfaces.notificationTargetId).toBe("notif_target_persisted");
    const insert = client.queries.find((q) => q.sql.includes("INSERT INTO notification_targets"))!;
    const destination = `slack-bot-v1:${encodeURIComponent("secret://org/slack-bot-token/g/1")}:C_tanren-x`;
    expect(insert.params[3]).toBe(destination);
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

  it("rejects incomplete bot delivery coordinates before persistence", async () => {
    const client = new RecordingClient();
    const artifact: ProvisionedArtifact = {
      notificationTarget: { kind: "slack", config: { channelId: "C_tanren-x" } },
    };
    await expect(
      persistProvisionedArtifact(client, { projectId: "p", orgId: "org_1" }, artifact, actor),
    ).rejects.toThrow(/requires both botTokenRef and channelId/u);
    expect(client.queries.some((query) => query.sql.includes("INSERT INTO notification_targets"))).toBe(false);
  });
});
