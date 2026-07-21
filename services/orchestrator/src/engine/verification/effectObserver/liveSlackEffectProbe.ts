/**
 * A3's independent Slack effect probe. It reads the real product channel through
 * `conversations.history`, rejects incomplete or malformed snapshots, and records
 * one immutable observation per exact trigger correlation. The sealed delivery
 * binding generation is the only coordinate it can use; a mutable current binding
 * pointer is intentionally never consulted.
 */

import { runWithOrgScope } from "@tanren/db";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { parseIntegrationRequirement } from "../../contracts/integrationRequirement.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import type { EffectObservation } from "../../contracts/sideEffectObserverAdapter.js";
import { PgEventStore, type EventStore } from "../../eventStore.js";
import { GenerationAddressedIntegrationSecretStore } from "../../integrations/integrationSecretStoreImpl.js";
import { PgIntegrationAuthority } from "../../integrations/integrationAuthorityImpl.js";
import { secretValueForLease } from "../../repositories/integrationConnectionResolve.js";
import { EffectObservationsRepository } from "../../repositories/effectObservations.js";
import { systemActor } from "../../state/actor.js";
import type { CauseWatermark, CauseWatermarkProbe } from "../acceptance/httpCauseDriver.js";
import type { CausalEffectReader, CausalEffectReaderInput } from "../acceptance/causalStage.js";
import { compareCursor } from "../acceptance/causalCorrelation.js";
import {
  FetchSlackHistoryTransport,
  distinctSlackHistoryMessages,
  type SlackHistoryMessage,
  type SlackHistorySnapshot,
  type SlackHistoryTransport,
} from "./slackHistoryTransport.js";

export { FetchSlackHistoryTransport, type SlackHistoryMessage, type SlackHistorySnapshot, type SlackHistoryTransport };

const SLACK_OBSERVER = "slack";
const SLACK_PROVIDER = "slack";
const SLACK_PRODUCT_PROVIDER_KIND = "slack.product.message.v1";
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface LiveSlackEffectProbeOptions {
  readonly transport?: SlackHistoryTransport;
  readonly repository?: EffectObservationStore;
  readonly eventsForClient?: (client: pg.PoolClient) => EventStore;
  readonly observationId?: () => string;
  readonly coordinateResolver?: LiveSlackEffectCoordinateResolver;
  readonly tokenResolver?: LiveSlackEffectTokenResolver;
}

export interface LiveSlackEffectBindingCoordinate {
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly connectionId: string;
  readonly authGeneration: number;
  readonly grantId: string;
  readonly grantGeneration: number;
  readonly channelId: string;
}

export interface LiveSlackEffectCoordinateResolver {
  resolve(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly behaviorRevisionId: string;
    readonly deliveryRunId: string;
    readonly observer: string;
    readonly provider: string;
  }): Promise<LiveSlackEffectBindingCoordinate>;
}

export interface LiveSlackEffectTokenResolver {
  resolve(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly coordinate: LiveSlackEffectBindingCoordinate;
  }): Promise<string>;
}

interface EffectObservationStore {
  lockTrigger(
    client: pg.PoolClient,
    input: {
      readonly orgId: string;
      readonly projectId: string;
      readonly observer: string;
      readonly provider: string;
      readonly triggerIdHash: string;
    },
  ): Promise<void>;
  append(
    client: pg.PoolClient,
    input: {
      readonly orgId: string;
      readonly projectId: string;
      readonly observationId: string;
      readonly triggerIdHash: string;
      readonly observer: string;
      readonly provider: string;
      readonly providerObjectHash?: string;
      readonly cursor?: string;
      readonly occurrenceCount: number;
      readonly classification: "ok" | "missing" | "duplicate";
    },
  ): Promise<EffectObservation>;
}

const BindingRow = z
  .object({
    binding_id: z.string().min(1),
    binding_generation: z.coerce.number().int().positive(),
    provider_kind: z.literal(SLACK_PRODUCT_PROVIDER_KIND),
    connection_id: z.string().min(1),
    auth_generation: z.coerce.number().int().positive(),
    grant_id: z.string().min(1),
    grant_generation: z.coerce.number().int().positive(),
    external_resource_id: z.string().min(1),
    desired_state: z.unknown(),
  })
  .strict();

/** Real provider observer and A3 pre-trigger watermark reader for direct Slack product bindings. */
export class LiveSlackEffectProbe implements CausalEffectReader, CauseWatermarkProbe {
  private readonly transport: SlackHistoryTransport;
  private readonly repository: EffectObservationStore;
  private readonly eventsForClient: (client: pg.PoolClient) => EventStore;
  private readonly observationId: () => string;
  private readonly coordinateResolver: LiveSlackEffectCoordinateResolver;
  private readonly tokenResolver: LiveSlackEffectTokenResolver;

  public constructor(
    private readonly pool: pg.Pool,
    private readonly secrets: SecretStore,
    options: LiveSlackEffectProbeOptions = {},
  ) {
    this.transport = options.transport ?? new FetchSlackHistoryTransport();
    this.repository = options.repository ?? new EffectObservationsRepository();
    this.eventsForClient = options.eventsForClient ?? ((client) => new PgEventStore(client));
    this.observationId = options.observationId ?? (() => `a3_effect_observation_${randomUUID()}`);
    this.coordinateResolver = options.coordinateResolver ?? { resolve: (input) => this.resolveCoordinateFromDb(input) };
    this.tokenResolver = options.tokenResolver ?? { resolve: (input) => this.resolveTokenFromAuthority(input) };
  }

  public async captureWatermark(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly behaviorRevisionId: string;
    readonly deliveryRunId: string;
    readonly observer: string;
    readonly provider: string;
  }): Promise<CauseWatermark> {
    const coordinate = await this.coordinateResolver.resolve(input);
    const snapshot = await this.readCompleteHistory(input, coordinate);
    return {
      cursor: latestCursor(snapshot.messages),
      bindingId: coordinate.bindingId,
      bindingGeneration: coordinate.bindingGeneration,
    };
  }

  public async effectsForProvider(input: CausalEffectReaderInput): Promise<readonly EffectObservation[]> {
    if (!isNonBlankString(input.deliveryRunId)) {
      throw new Error("A3 effect reader requires the delivery run binding set");
    }
    const afterWatermark = input.afterWatermark;
    if (!isNonBlankString(afterWatermark)) {
      throw new Error("A3 effect reader requires a non-blank pre-trigger watermark");
    }
    if (!Array.isArray(input.correlationIds) || input.correlationIds.length === 0) {
      throw new Error("A3 effect reader requires at least one trigger correlation");
    }
    if (
      new Set(input.correlationIds).size !== input.correlationIds.length ||
      input.correlationIds.some((id) => !isDigest(id))
    ) {
      throw new Error("A3 effect reader received invalid or duplicate trigger correlations");
    }
    if (
      !Array.isArray(input.triggers) ||
      input.triggers.length !== input.correlationIds.length ||
      new Set(input.triggers.map((trigger) => trigger.correlationId)).size !== input.triggers.length ||
      input.triggers.some(
        (trigger) =>
          !isDigest(trigger.correlationId) ||
          !Number.isSafeInteger(trigger.causeOrdinal) ||
          trigger.causeOrdinal < 0 ||
          !input.correlationIds.includes(trigger.correlationId),
      )
    ) {
      throw new Error("A3 effect reader requires exact stable cause coordinates for every trigger correlation");
    }
    const coordinate = await this.coordinateResolver.resolve({
      orgId: input.orgId,
      projectId: input.projectId,
      behaviorRevisionId: input.behaviorRevisionId,
      deliveryRunId: input.deliveryRunId,
      observer: input.observer,
      provider: input.provider,
    });
    const snapshot = await this.readCompleteHistory(input, coordinate);
    const observations = await runWithOrgScope(this.pool, input.orgId, async (client) => {
      const appended: EffectObservation[] = [];
      for (const trigger of input.triggers) {
        const correlationId = trigger.correlationId;
        await this.repository.lockTrigger(client, {
          orgId: input.orgId,
          projectId: input.projectId,
          observer: input.observer,
          provider: input.provider,
          triggerIdHash: correlationId,
        });
        const matches = matchingMessages(snapshot.messages, correlationId, afterWatermark);
        const observation = await this.repository.append(
          client,
          observationInput(input, coordinate, this.observationId(), correlationId, matches),
        );
        await appendObservationEvent(
          this.eventsForClient(client),
          input,
          coordinate,
          trigger.causeOrdinal,
          observation,
        );
        appended.push(observation);
      }
      return appended;
    });
    return observations;
  }

  private async resolveCoordinateFromDb(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly behaviorRevisionId: string;
    readonly deliveryRunId: string;
    readonly observer: string;
    readonly provider: string;
  }): Promise<LiveSlackEffectBindingCoordinate> {
    if (input.observer !== SLACK_OBSERVER || input.provider !== SLACK_PROVIDER) {
      throw new Error(`A3 has no independent probe for ${input.observer}/${input.provider}`);
    }
    const coordinate = await runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query(
        `SELECT drb.binding_id, drb.binding_generation, g.provider_kind, g.connection_id,
                g.auth_generation, g.grant_id, g.grant_generation, g.external_resource_id, r.desired_state
           FROM behavior_integration_requirements bir
           JOIN integration_requirements r
             ON r.org_id = bir.org_id AND r.project_id = bir.project_id AND r.id = bir.requirement_id
           JOIN delivery_run_bindings drb
             ON drb.org_id = r.org_id AND drb.project_id = r.project_id AND drb.delivery_run_id = $4
           JOIN integration_binding_generations g
             ON g.org_id = drb.org_id AND g.project_id = drb.project_id
            AND g.binding_id = drb.binding_id AND g.generation = drb.binding_generation
            AND g.requirement_id = r.id
          WHERE bir.org_id = $1 AND bir.project_id = $2 AND bir.behavior_revision_id = $3
            AND bir.relation_role = 'requires' AND r.plane = 'product' AND r.status = 'active'
            AND r.criticality = 'release_required'`,
        [input.orgId, input.projectId, input.behaviorRevisionId, input.deliveryRunId],
      );
      const candidates = result.rows.flatMap((raw) => {
        const parsed = BindingRow.safeParse(raw);
        if (!parsed.success) return [];
        const requirement = parseIntegrationRequirement(parsed.data.desired_state);
        if (!requirement.ok) return [];
        if (
          requirement.requirement.expectedEffect.provider !== input.provider ||
          !requirement.requirement.expectedEffect.independent ||
          !requirement.requirement.validation.postDeploy.liveStimulus ||
          !requirement.requirement.validation.postDeploy.independentObservation
        ) {
          return [];
        }
        return [
          {
            bindingId: parsed.data.binding_id,
            bindingGeneration: parsed.data.binding_generation,
            connectionId: parsed.data.connection_id,
            authGeneration: parsed.data.auth_generation,
            grantId: parsed.data.grant_id,
            grantGeneration: parsed.data.grant_generation,
            channelId: parsed.data.external_resource_id,
          },
        ];
      });
      if (candidates.length !== 1) {
        throw new Error("A3 requires exactly one sealed, independently-observable Slack binding for this behavior");
      }
      const candidate = candidates[0];
      if (candidate === undefined) throw new Error("A3 Slack binding resolution was unexpectedly empty");
      return candidate;
    });
    return coordinate;
  }

  private async readCompleteHistory(
    input: { readonly orgId: string; readonly projectId: string },
    coordinate: LiveSlackEffectBindingCoordinate,
  ): Promise<SlackHistorySnapshot> {
    const token = await this.tokenResolver.resolve({ ...input, coordinate });
    if (!isNonBlankString(token)) throw new Error("A3 Slack history token is blank or malformed");
    const snapshot = await this.transport.history({ token, channelId: coordinate.channelId });
    if (
      !snapshot.complete ||
      !Array.isArray(snapshot.messages) ||
      snapshot.messages.some((message) => invalidMessage(message))
    ) {
      throw new Error("A3 Slack history snapshot is incomplete or malformed");
    }
    return snapshot;
  }

  private async resolveTokenFromAuthority(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly coordinate: LiveSlackEffectBindingCoordinate;
  }): Promise<string> {
    const token = await runWithOrgScope(this.pool, input.orgId, async (client) => {
      const resolution = await new PgIntegrationAuthority().authorizeOperation(client, {
        orgId: input.orgId,
        projectId: input.projectId,
        providerKind: SLACK_PROVIDER,
        capability: "messaging.send",
        operation: "verify",
        target: { resourceId: input.coordinate.channelId, environment: "production" },
        actor: systemActor,
      });
      if (resolution.status !== "eligible") throw new Error("A3 Slack history authority is not eligible");
      const lease = resolution.lease;
      if (
        lease.connectionId !== input.coordinate.connectionId ||
        lease.authGeneration !== input.coordinate.authGeneration ||
        lease.grantId !== input.coordinate.grantId ||
        lease.grantGeneration !== input.coordinate.grantGeneration
      ) {
        throw new Error("A3 Slack history lease does not match the sealed binding generation");
      }
      return secretValueForLease(new GenerationAddressedIntegrationSecretStore(this.secrets), lease, {
        orgId: input.orgId,
        projectId: input.projectId,
        providerKind: SLACK_PROVIDER,
        capability: "messaging.send",
        operation: "verify",
        target: { resourceId: input.coordinate.channelId, environment: "production" },
      });
    });
    return token;
  }
}

function invalidMessage(message: SlackHistoryMessage): boolean {
  return !isNonBlankString(message.ts) || !Number.isFinite(Number(message.ts)) || typeof message.text !== "string";
}

function latestCursor(messages: readonly SlackHistoryMessage[]): string {
  let latest = "0";
  for (const message of messages) if (compareCursor(message.ts, latest) > 0) latest = message.ts;
  return latest;
}

function matchingMessages(
  messages: readonly SlackHistoryMessage[],
  correlationId: string,
  after: string,
): readonly SlackHistoryMessage[] {
  return distinctSlackHistoryMessages(messages).filter(
    (message) => compareCursor(message.ts, after) > 0 && message.text.includes(correlationId),
  );
}

function observationInput(
  input: CausalEffectReaderInput,
  coordinate: LiveSlackEffectBindingCoordinate,
  observationId: string,
  correlationId: string,
  matches: readonly SlackHistoryMessage[],
) {
  const classification = matches.length === 0 ? "missing" : matches.length === 1 ? "ok" : "duplicate";
  const matched = matches[0];
  return {
    orgId: input.orgId,
    projectId: input.projectId,
    observationId,
    triggerIdHash: correlationId,
    observer: input.observer,
    provider: input.provider,
    ...(matched === undefined
      ? {}
      : {
          providerObjectHash: digest(`${coordinate.bindingId}\u0000${coordinate.bindingGeneration}\u0000${matched.ts}`),
          cursor: matched.ts,
        }),
    ...(matched === undefined ? { cursor: input.afterWatermark } : {}),
    occurrenceCount: matches.length,
    classification,
  } as const;
}

async function appendObservationEvent(
  events: EventStore,
  input: CausalEffectReaderInput,
  coordinate: LiveSlackEffectBindingCoordinate,
  causeOrdinal: number,
  observation: EffectObservation,
): Promise<void> {
  const common = {
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    orgId: input.orgId,
    projectId: input.projectId,
  };
  if (observation.classification === "ok") {
    await events.append({
      ...common,
      eventType: "behavior.effect.observed",
      payload: {
        behaviorRevisionId: input.behaviorRevisionId,
        shardId: `a3:${coordinate.bindingId}:${String(coordinate.bindingGeneration)}`,
        correlationId: requireDigest(observation.triggerIdHash, "observed effect correlation"),
        providerReceiptId: requireDigest(observation.providerObjectHash, "observed effect receipt"),
        deliveryRunId: input.deliveryRunId,
        causeOrdinal,
        occurrenceCount: observation.occurrenceCount,
      },
    });
    return;
  }
  if (observation.classification === "missing") {
    await events.append({
      ...common,
      eventType: "behavior.effect.missing",
      payload: {
        projectId: input.projectId,
        observationId: observation.observationId,
        triggerIdHash: requireDigest(observation.triggerIdHash, "missing effect correlation"),
        observer: input.observer,
        provider: input.provider,
        occurrenceCount: observation.occurrenceCount,
      },
    });
    return;
  }
  await events.append({
    ...common,
    eventType: "behavior.effect.duplicate",
    payload: {
      projectId: input.projectId,
      observationId: observation.observationId,
      triggerIdHash: requireDigest(observation.triggerIdHash, "duplicate effect correlation"),
      providerObjectHash: requireDigest(observation.providerObjectHash, "duplicate effect receipt"),
      observer: input.observer,
      provider: input.provider,
      occurrenceCount: observation.occurrenceCount,
    },
  });
}

function requireDigest(value: string | undefined, field: string): string {
  if (!isDigest(value)) throw new Error(`${field} is missing or malformed`);
  return value;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
