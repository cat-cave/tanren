// Progress-driven merge-claim lease renewal. A merge claim is recoverable when its
// drive dies, but a working drive can run indefinitely: only ActivityWatchdog-proven
// work advancement refreshes this lease. There is deliberately no timer here.

import type { MergeQueueModel } from "../contracts/mergeCoordinator.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("merge-claim-lease");

/**
 * Bridges a queued merge drive's ActivityWatchdog sign-of-life events to its claim
 * heartbeat. A fixed-point watchdog emits no progress, while the session liveness
 * fence is lost automatically when a coordinator actually dies.
 */
export class MergeClaimActivityLease {
  private renewal = Promise.resolve();
  private renewalQueued = false;

  constructor(
    private readonly queue: MergeQueueModel,
    private readonly queueId: string,
  ) {}

  /** Request a refresh from a real ActivityWatchdog work-signature advancement. */
  onWatchdogProgress(): void {
    if (this.renewalQueued) return;
    const renew = this.queue.renewClaim;
    if (renew === undefined) return;
    this.renewalQueued = true;
    this.renewal = renew
      .call(this.queue, this.queueId)
      .then(() => {})
      .catch((error: unknown) => {
        // The watchdog callback is intentionally synchronous. Surface failed refreshes
        // loudly; a later real progress signal retries, while persistent failure leaves
        // the claim reclaimable instead of pretending the lease is fresh.
        log.error("merge claim activity renewal failed", { queueId: this.queueId }, error);
      })
      .finally(() => {
        this.renewalQueued = false;
      });
  }

  /** Finish any already-requested refresh before the caller settles the claim. */
  async drain(): Promise<void> {
    await this.renewal;
  }
}
