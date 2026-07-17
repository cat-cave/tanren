import { runWithOrgScope } from "@tanren/db";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  AdvanceSideEffectWatermarkInput,
  EffectObservation,
  EffectObservationClassification,
  ObserveSideEffectInput,
  SideEffectObserverAdapter,
} from "../../contracts/sideEffectObserverAdapter.js";
import type { QueryClient } from "../../data/orgScopedDb.js";
import { PgEventStore, type EventStore } from "../../eventStore.js";
import { EffectObservationsRepository } from "../../repositories/effectObservations.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface PgSideEffectObserverAdapterOptions {
  readonly repository?: EffectObservationsRepository;
  readonly eventsForClient?: (client: QueryClient) => EventStore;
  readonly observationId?: () => string;
}

/**
 * Persists redacted provider evidence for one poll. A caller-supplied trigger
 * is unique until it has already been observed for this observer/provider;
 * absent triggers are durable missing observations. The watermark remains a
 * separate mutable cursor by schema design.
 */
export class PgSideEffectObserverAdapter implements SideEffectObserverAdapter {
  private readonly repository: EffectObservationsRepository;
  private readonly eventsForClient: (client: QueryClient) => EventStore;
  private readonly observationId: () => string;

  public constructor(
    private readonly pool: pg.Pool,
    options: PgSideEffectObserverAdapterOptions = {},
  ) {
    this.repository = options.repository ?? new EffectObservationsRepository();
    this.eventsForClient = options.eventsForClient ?? ((client) => new PgEventStore(client));
    this.observationId = options.observationId ?? (() => `effect_observation_${randomUUID()}`);
  }

  public async observe(input: ObserveSideEffectInput): Promise<ReadonlyArray<EffectObservation>> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const triggerIdHash = resolveTriggerIdHash(input);
      const prior = triggerIdHash === undefined ? [] : await this.findPriorObservations(client, input, triggerIdHash);
      const classification = classify(input, prior.length);
      const providerObjectHash = triggerIdHash === undefined ? undefined : providerObjectDigest(input, triggerIdHash);
      const observation = await this.repository.append(client, {
        orgId: input.orgId,
        projectId: input.projectId,
        observationId: this.observationId(),
        triggerIdHash,
        observer: input.observer,
        provider: input.provider,
        ...(providerObjectHash === undefined ? {} : { providerObjectHash }),
        ...(input.afterWatermark === undefined ? {} : { cursor: input.afterWatermark }),
        occurrenceCount: classification === "missing" ? 0 : prior.length + 1,
        classification,
      });
      await appendClassificationEvents(this.eventsForClient(client), observation);
      return [observation];
    });
  }

  public async advanceWatermark(input: AdvanceSideEffectWatermarkInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, async (client) => {
      await this.repository.advanceWatermark(client, input);
      await this.eventsForClient(client).append({
        orgId: input.orgId,
        projectId: input.projectId,
        eventType: "observer.watermark.advanced",
        payload: {
          projectId: input.projectId,
          observer: input.observer,
          watermarkHash: sha256(input.watermark),
        },
      });
    });
  }

  private async findPriorObservations(
    client: QueryClient,
    input: ObserveSideEffectInput,
    triggerIdHash: string,
  ): Promise<ReadonlyArray<EffectObservation>> {
    const trigger = {
      orgId: input.orgId,
      projectId: input.projectId,
      observer: input.observer,
      provider: input.provider,
      triggerIdHash,
    };
    await this.repository.lockTrigger(client, trigger);
    return this.repository.findByTrigger(client, trigger);
  }
}

function classify(input: ObserveSideEffectInput, priorCount: number): EffectObservationClassification {
  if (input.triggerIdHash === undefined) return "missing";
  return priorCount === 0 ? "ok" : "duplicate";
}

function resolveTriggerIdHash(input: ObserveSideEffectInput): string | undefined {
  if (input.triggerIdHash !== undefined) {
    if (!SHA256.test(input.triggerIdHash)) {
      throw new Error("triggerIdHash must be a sha256 digest");
    }
    return input.triggerIdHash;
  }
  return undefined;
}

function providerObjectDigest(input: ObserveSideEffectInput, triggerIdHash: string): string {
  return sha256(`${input.provider}\u0000${input.observer}\u0000${triggerIdHash}\u0000${input.afterWatermark ?? ""}`);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function appendClassificationEvents(eventStore: EventStore, observation: EffectObservation): Promise<void> {
  switch (observation.classification) {
    case "ok": {
      const triggerIdHash = requireTriggerIdHash(observation);
      await eventStore.append({
        orgId: observation.orgId,
        projectId: observation.projectId,
        eventType: "behavior.effect.observed",
        payload: {
          behaviorRevisionId: triggerIdHash,
          shardId: observation.observer,
          correlationId: observation.observationId,
          providerReceiptId: observation.providerObjectHash ?? observation.observationId,
        },
      });
      return;
    }
    case "duplicate": {
      const triggerIdHash = requireTriggerIdHash(observation);
      const providerObjectHash = observation.providerObjectHash;
      if (providerObjectHash === undefined) throw new Error("duplicate observation requires a provider object hash");
      await eventStore.append({
        orgId: observation.orgId,
        projectId: observation.projectId,
        eventType: "behavior.effect.duplicate",
        payload: {
          projectId: observation.projectId,
          observationId: observation.observationId,
          triggerIdHash,
          providerObjectHash,
          observer: observation.observer,
          provider: observation.provider,
          occurrenceCount: observation.occurrenceCount,
        },
      });
      return;
    }
    case "missing": {
      // The row correctly retains NULL when the provider did not expose a
      // trigger. The frozen event schema requires a digest, so publish a
      // stable redacted correlation key without inventing a database value.
      const triggerIdHash = missingCorrelationHash(observation);
      await eventStore.append({
        orgId: observation.orgId,
        projectId: observation.projectId,
        eventType: "behavior.effect.missing",
        payload: {
          projectId: observation.projectId,
          observationId: observation.observationId,
          triggerIdHash,
          observer: observation.observer,
          provider: observation.provider,
          occurrenceCount: observation.occurrenceCount,
        },
      });
      await eventStore.append({
        orgId: observation.orgId,
        projectId: observation.projectId,
        eventType: "observer.inconclusive_external",
        payload: {
          projectId: observation.projectId,
          observationId: observation.observationId,
          observer: observation.observer,
          provider: observation.provider,
          ...(observation.cursor === undefined ? {} : { cursorHash: sha256(observation.cursor) }),
        },
      });
    }
  }
}

function requireTriggerIdHash(observation: EffectObservation): string {
  if (observation.triggerIdHash === undefined) throw new Error("effect observation requires a trigger hash");
  return observation.triggerIdHash;
}

function missingCorrelationHash(observation: EffectObservation): string {
  return sha256(
    `${observation.orgId}\u0000${observation.projectId}\u0000${observation.observer}\u0000${observation.provider}\u0000${observation.cursor ?? ""}`,
  );
}
