import type { z } from "zod";
import { appEnvironmentEventRegistry } from "./schemas/appEnvironmentVocabulary.js";
import { dagEventRegistry } from "./schemas/dagVocabulary.js";
import { deliveryEventRegistry } from "./schemas/deliveryVocabulary.js";
import { eventVocabularyMiscRegistry } from "./schemas/eventVocabularyMisc.js";
import {
  designSystemVocabularyRegistry,
  governanceVocabularyRegistry,
  w0EventRegistry,
  wave1EventRegistry,
  wave4EventRegistry,
  wave5And6AndResolutionClusterEventRegistry,
} from "./schemas/integrations.js";
import { recoveryEventRegistry } from "./schemas/recoveryVocabulary.js";
import { workflowAndInfrastructureEventRegistry } from "./schemas/workflowAndInfrastructureVocabulary.js";

// Single source of truth mapping event names to typed Zod payload schemas.
export const EventRegistry = {
  ...w0EventRegistry,
  ...wave1EventRegistry,
  ...governanceVocabularyRegistry,
  ...designSystemVocabularyRegistry,
  ...wave4EventRegistry,
  ...wave5And6AndResolutionClusterEventRegistry,
  ...eventVocabularyMiscRegistry,
  ...workflowAndInfrastructureEventRegistry,
  ...deliveryEventRegistry,
  ...recoveryEventRegistry,
  ...dagEventRegistry,
  ...appEnvironmentEventRegistry,
} as const satisfies Record<string, z.ZodTypeAny>;

export type EventRegistry = typeof EventRegistry;
export type EventName = keyof EventRegistry;
export type EventPayload<N extends EventName> = z.infer<EventRegistry[N]>;

const eventNames = new Set<EventName>(Object.keys(EventRegistry) as EventName[]);

export function isEventName(value: string): value is EventName {
  return eventNames.has(value as EventName);
}

export function assertEventName(value: string): asserts value is EventName {
  if (!isEventName(value)) throw new Error(`undeclared event name: ${value}`);
}

export function listEventNames(): EventName[] {
  return [...eventNames].sort();
}

export class UnknownEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`unknown event type: ${eventType}`);
  }
}
export interface TypedEvent<N extends EventName = EventName> {
  eventType: N;
  payload: EventPayload<N>;
}
export interface RawEventRow {
  event_type: string;
  payload: unknown;
}

// decodeEvent parses a DB row payload through the registered Zod schema (defense-in-depth for replay/import; write-time producers are already validated).
export function decodeEvent(row: RawEventRow): TypedEvent {
  if (!isEventName(row.event_type)) {
    throw new UnknownEventTypeError(row.event_type);
  }
  const payload = EventRegistry[row.event_type].parse(row.payload);
  return { eventType: row.event_type, payload } as TypedEvent;
}
