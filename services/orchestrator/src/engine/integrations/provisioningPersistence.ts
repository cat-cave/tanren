import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { ProvisionedArtifact } from "../contracts/integrationProvisioner.js";
import { mutateProjectConfig } from "../config/projectConfigMutate.js";
import type { IntegrationQueryClient } from "../repositories/integrationQuery.js";
import { InboxStore } from "../repositories/inbox.js";
import { SourceKind } from "../forge/inbox/types.js";
import { ChannelKind } from "../notifications/schemas.js";
import type { ActorRef } from "../state/actor.js";
import type {
  CompleteIntegrationReconciliationInput,
  IntegrationStateWriter,
  MarkIntegrationReconciliationStateUnknownInput,
} from "../contracts/integrationStateWriter.js";

interface ArtifactPersistenceRequest {
  projectId: string;
  orgId: string;
  name?: string;
}

export interface PersistedIntegrationSurfaces {
  inboxSourceId?: string;
  notificationTargetId?: string;
  projectConfigKeys: string[];
  deployRef?: string;
}

/** The data-plane hand-off for one provider operation's durable lifecycle row. */
export interface ProvisioningLifecycleWork<T> {
  writer: IntegrationStateWriter;
  claim: {
    orgId: string;
    reconciliationId: string;
    claimOwner: string;
    leaseMs: number;
  };
  work(): Promise<T>;
  completion(result: T): Omit<CompleteIntegrationReconciliationInput, "orgId" | "reconciliationId" | "claimOwner">;
  stateUnknown: Omit<MarkIntegrationReconciliationStateUnknownInput, "orgId" | "reconciliationId" | "claimOwner">;
}

export type ProvisioningLifecycleResult<T> = { status: "not_claimed" } | { status: "completed"; result: T };

/**
 * Run provider/persistence work only while the control-plane writer holds the
 * reconciliation claim. This module deliberately has no integration_reconciliations
 * SQL: lifecycle state can move only through {@link IntegrationStateWriter}.
 */
export async function runProvisioningLifecycle<T>(
  input: ProvisioningLifecycleWork<T>,
): Promise<ProvisioningLifecycleResult<T>> {
  const claimed = await input.writer.claim(input.claim);
  if (claimed === undefined) return { status: "not_claimed" };
  try {
    const result = await input.work();
    const complete = input.completion(result);
    const completed = await input.writer.complete({
      orgId: input.claim.orgId,
      reconciliationId: input.claim.reconciliationId,
      claimOwner: input.claim.claimOwner,
      ...complete,
    });
    if (!completed) {
      throw new Error(`integration reconciliation '${input.claim.reconciliationId}' lost its claim before completion`);
    }
    return { status: "completed", result };
  } catch (error) {
    // A provider might have completed just before a persistence failure. Do not
    // replay that effect blindly: record the frozen state_unknown transition via
    // the writer and let a reconciler inspect the provider idempotency key. A
    // normal transition is fenced to this worker's live lease. If that lease
    // lapsed or was stolen, use the writer's still-claimed fallback so this
    // ambiguity remains observable without exposing lifecycle SQL to the data
    // plane.
    const stateUnknown = {
      orgId: input.claim.orgId,
      reconciliationId: input.claim.reconciliationId,
      claimOwner: input.claim.claimOwner,
      ...input.stateUnknown,
    };
    const marked = await input.writer.stateUnknown(stateUnknown);
    if (!marked) {
      await input.writer.stateUnknownAfterClaimLost(stateUnknown);
    }
    throw error;
  }
}

/** Persist every populated artifact surface without ever reading secret values. */
export async function persistProvisionedArtifact(
  client: IntegrationQueryClient,
  request: ArtifactPersistenceRequest,
  artifact: ProvisionedArtifact,
  actor: ActorRef,
): Promise<PersistedIntegrationSurfaces> {
  const result: PersistedIntegrationSurfaces = { projectConfigKeys: [] };
  const projectConfig = artifact.projectConfig;
  if (projectConfig !== undefined && Object.keys(projectConfig).length > 0) {
    // Preserve the ProjectsStore generation-aware compare-and-swap boundary.
    await mutateProjectConfig(asProjectConfigClient(client), request.projectId, actor, (rawCurrent) => ({
      ...asRecord(rawCurrent),
      ...projectConfig,
    }));
    result.projectConfigKeys = Object.keys(projectConfig);
  }
  if (artifact.inboxSource !== undefined) {
    result.inboxSourceId = await upsertInboxSource(client, request, artifact.inboxSource);
  }
  if (artifact.notificationTarget !== undefined) {
    result.notificationTargetId = await upsertNotificationTarget(client, request, artifact.notificationTarget);
  }
  if (artifact.deployRef !== undefined) {
    result.deployRef = `${artifact.deployRef.provider}:${artifact.deployRef.appId}`;
  }
  return result;
}

/**
 * Integration repositories deliberately expose a narrow, fake-friendly SQL
 * port. At runtime it is the same pg client used by ProjectStore; retain that
 * narrow contract here while adapting only the overloaded query signature.
 */
function asProjectConfigClient(client: IntegrationQueryClient): Pick<pg.PoolClient, "query"> {
  return { query: client.query.bind(client) as Pick<pg.PoolClient, "query">["query"] };
}

/** Marker used by the partial idempotency index for provisioner-owned rows. */
const MANAGED_BY = "integration-provisioner";

async function upsertInboxSource(
  client: IntegrationQueryClient,
  request: ArtifactPersistenceRequest,
  inboxSource: { kind: string; config: Record<string, unknown> },
): Promise<string> {
  const name = `${inboxSource.kind} (${request.name ?? request.projectId})`;
  const config = { ...inboxSource.config, managedBy: MANAGED_BY };
  const source = await InboxStore.upsertManagedSource(client, {
    orgId: request.orgId,
    projectId: request.projectId,
    kind: SourceKind.parse(inboxSource.kind),
    name,
    config,
    enabled: true,
    autoRoute: false,
  });
  return source.id;
}

async function upsertNotificationTarget(
  client: IntegrationQueryClient,
  request: ArtifactPersistenceRequest,
  notificationTarget: { kind: string; config: Record<string, unknown> },
): Promise<string> {
  const channelKind = ChannelKind.parse(notificationTarget.kind);
  const destination = notificationTargetDestination(channelKind, notificationTarget.config);
  const label = `${notificationTarget.kind} (${request.name ?? request.projectId})`;
  const id = `notif_target_${randomUUID()}`;
  const result = await client.query(
    `INSERT INTO notification_targets
       (id, org_id, scope, user_id, channel_kind, destination, label, enabled, weekend_mute)
     VALUES ($1, $2, 'org', NULL, $3, $4, $5, 1, 0)
     ON CONFLICT (org_id, channel_kind, destination) WHERE scope = 'org' AND user_id IS NULL DO UPDATE SET
       label = EXCLUDED.label
     RETURNING id`,
    [id, request.orgId, channelKind, destination, label],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `notification_targets upsert returned no row for (${request.orgId}, ${channelKind}, ${destination})`,
    );
  }
  return z.object({ id: z.string() }).parse(row).id;
}

function notificationTargetDestination(kind: string, config: Record<string, unknown>): string {
  if (kind === "slack") {
    // The runtime Slack channel is an INCOMING-WEBHOOK publisher: its target
    // `destination` MUST be a webhook credential ref that resolves to an https
    // webhook URL. A bot-token + channel-id artifact (the chat.postMessage
    // model) is NOT deliverable by that channel — never persist the bot-token
    // ref as a webhook destination (that mismatch is what caused an `xoxb-…`
    // token to be POSTed as a webhook). Fail loud, mirroring the
    // `provisionCapability` SlackDeliveryAdapterUnavailable guard.
    const webhookRef = config["webhookRef"] ?? config["destination"];
    if (typeof webhookRef === "string" && webhookRef.length > 0) {
      return webhookRef;
    }
    throw new Error(
      "slack notification target has no incoming-webhook credential ref (webhookRef/destination); " +
        "the bot-token + channel-id model is not deliverable by the incoming-webhook channel",
    );
  }
  // Non-Slack kinds carry a direct destination or credential ref. `botTokenRef`
  // is intentionally NOT a candidate here — it is Slack-bot-only and must never
  // become a channel destination.
  const ref = config["destination"] ?? config["webhookRef"] ?? config["channelId"];
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error("notification target config carried no destination/channelId/credential ref");
  }
  return ref;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
