import type { ChannelKind, NotificationPayload, NotificationTargetRow } from "../schemas.js";

// P2A-0017 channel interface.
//
// Every channel kind (ntfy, slack, github_checks, teams, discord, email,
// twilio, pagerduty, webhook) implements this interface. In Phase 2A v0,
// only `NtfyChannel` performs real delivery; the remaining kinds are
// registered as `StubChannel` so the matrix can be configured and the
// dispatcher can record "stubbed delivery" log rows instead of crashing.
//
// Implementations MUST treat publish as fire-and-forget from the
// orchestrator's perspective. Failures are caught by the dispatcher and
// logged via the `notifications` table (see store.recordDispatch); they
// MUST NOT propagate back into the workflow.

export interface NotificationChannel {
  readonly kind: ChannelKind;

  // Returns true when the channel is actually wired in this build. The
  // dispatcher uses this to render `notifications.status` as either
  // `stubbed` (no real delivery happened) or `sent`/`failed` (real
  // delivery was attempted). UI surfaces use the same signal to render
  // the matrix cell as "configured but not yet wired" rather than as a
  // silent enabled-row.
  readonly wired: boolean;

  publish(target: NotificationTargetRow, payload: NotificationPayload): Promise<void>;
}
