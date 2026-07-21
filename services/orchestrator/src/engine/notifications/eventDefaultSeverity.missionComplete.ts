import type { EventName } from "../events/index.js";
import type { Severity } from "./schemas.js";

/** Explicit operator-facing severities for mission-complete event vocabulary. */
export const missionCompleteSeverityOverrides: Partial<Record<EventName, Severity>> = {
  "governance.policy.created": "info",
  "governance.policy.compiled": "info",
  "governance.policy.activated": "info",
  "governanceFragment.authoring.started": "info",
  "governanceFragment.authoring.attempt": "info",
  "governanceFragment.authoring.succeeded": "info",
  "governanceFragment.authoring.failed": "fail",
  "integration.proof.invalidated": "warn",
  "merge.beam.stale": "warn",
  "merge.policy.revised": "info",
  "merge.queue.command_applied": "info",
  "merge.queue.window_changed": "info",
  "merge.queue.admission_held": "warn",
};
