// Single import surface for the P2A-0017 notifications matrix. Wiring
// (orchestrator startup, route handlers, tests) should import from this
// barrel rather than reaching into individual files.

export {
  ChannelKind,
  Severity,
  TargetScope,
  NotificationPayload,
  NotificationRouteCreateInput,
  NotificationRouteRow,
  NotificationTargetCreateInput,
  NotificationTargetRow,
  severityMeetsFloor,
  severityRank
} from "./schemas.js";

export { defaultSeverityFor, eventDefaultSeverity } from "./eventDefaultSeverity.js";

export {
  NotificationChannel
} from "./channels/types.js";
export { NtfyChannel, type NtfyChannelDeps } from "./channels/ntfy.js";
export { StubChannel } from "./channels/stub.js";

export {
  NotificationTargetStore,
  NotificationRouteStore,
  NotificationDispatchLog,
  type DispatchLogInput,
  type DispatchStatus
} from "./store.js";

export {
  evaluateMatrix,
  isWeekendInUtc,
  type MatrixContext,
  type MatrixEvaluationInput,
  type MatrixMatch
} from "./matrix.js";

export {
  NotificationDispatcher,
  effectiveSeverityFor,
  type DispatcherDeps,
  type EventContext
} from "./dispatcher.js";

export { buildChannelRegistry, type ChannelRegistryDeps } from "./registry.js";
