import type { ChannelKind, NotificationPayload, NotificationTargetRow } from "../schemas.js";
import type { NotificationChannel } from "./types.js";

// P2A-0017 stub channel.
//
// Every channel kind that has not yet shipped a real adapter (slack,
// github_checks, teams, discord, email, twilio, pagerduty, webhook) is
// registered as a `StubChannel`. The matrix UI can configure routes
// against these targets; the dispatcher invokes their publish() the same
// way it would a real channel; the only difference is that publish() is a
// no-op and the channel reports `wired = false` so the dispatcher records
// the dispatch as `stubbed` in the `notifications` log instead of `sent`.
//
// The intent (from the spec): "other channel rows render as stubbed
// delivery, NOT as silent failures". A failed unwired delivery would be
// indistinguishable from a successful one; the stubbed status keeps the
// audit trail honest.

export class StubChannel implements NotificationChannel {
  readonly kind: ChannelKind;
  readonly wired = false;

  constructor(kind: ChannelKind) {
    this.kind = kind;
  }

  // publish is intentionally a no-op. The dispatcher's catch path is not
  // triggered (no throw), and the status is reconciled via `wired = false`.
  async publish(_target: NotificationTargetRow, _payload: NotificationPayload): Promise<void> {
    // No-op. See class doc.
  }
}
