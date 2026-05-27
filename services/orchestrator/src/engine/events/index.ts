// Single import surface for typed event payloads, the event registry, and
// the sensitivity-tag layer that feeds P2A-0009 redaction.
//
// Importing this barrel registers every Sensitivity rule via the side-effect
// import below, so downstream callers do not need to explicitly initialize
// the rule table.

import "./sensitivityRules.js";

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
} from "./registry.js";

export {
  Sensitivity,
  type FieldPath,
  type SensitivityRule,
  sensitivityFor,
  listSensitivityRules,
  listSensitivityPathsFor,
  registerSensitivity,
  registerSensitivities,
  resetSensitivityRulesForTesting
} from "./sensitivity.js";

export { ensureSensitivityRulesRegistered, sensitivityRules } from "./sensitivityRules.js";
