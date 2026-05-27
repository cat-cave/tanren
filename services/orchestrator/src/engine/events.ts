// Compatibility shim. The event registry now lives in `events/registry.ts`
// alongside per-event Zod schemas and sensitivity tags. This module
// re-exports the public surface so existing imports keep working.

export {
  EventRegistry,
  type EventName,
  type EventPayload,
  type TypedEvent,
  type RawEventRow,
  isEventName,
  assertEventName,
  listEventNames,
  decodeEvent,
  UnknownEventTypeError
} from "./events/index.js";
