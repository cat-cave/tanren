// Progress-driven merge-claim lease renewal. A merge claim is recoverable when its
// drive dies, but a working drive can run indefinitely: only ActivityWatchdog-proven
// work advancement refreshes this lease. There is deliberately no timer here.

import type { MergeQueueModel } from "../contracts/mergeCoordinator.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("merge-claim-lease");

/**
 * Bridges a queued merge drive's ActivityWatchdog sign-of-life events to its claim
 * heartbeat. A fixed-point watchdog emits no progress; a process that dies stops
 * writing this durable sign-of-life and is therefore safely recoverable.
 */
export class MergeClaimActivityLease {
  private renewal = Promise.resolve();
  private renewalQueued = false;
  private progressPending = false;
  private claimLost = false;
  private readonly abortController = new AbortController();

  constructor(
    private readonly queue: MergeQueueModel,
    private readonly queueId: string,
  ) {}

  /** Request a refresh from a real ActivityWatchdog work-signature advancement. */
  onWatchdogProgress(): void {
    this.progressPending = true;
    if (this.renewalQueued || this.claimLost) return;
    this.queueRenewal();
  }

  private queueRenewal(): void {
    const renew = this.queue.renewClaim;
    if (renew === undefined) return;
    this.renewalQueued = true;
    this.progressPending = false;
    this.renewal = renew
      .call(this.queue, this.queueId)
      .then((renewed) => {
        if (renewed) return;
        this.loseClaim("merge claim progress heartbeat lost ownership");
      })
      .catch((error: unknown) => {
        // The watchdog callback is intentionally synchronous. A refresh error cannot
        // prove ownership, so fail closed before the drive can reach the land call.
        log.error("merge claim activity renewal failed", { queueId: this.queueId }, error);
        this.loseClaim("merge claim progress heartbeat could not prove ownership");
      })
      .finally(() => {
        this.renewalQueued = false;
        // Coalescing must retain the most recent observed progress. Otherwise a
        // burst of advancing watchdog signals can renew an old heartbeat after
        // the merge has moved on, making a live drive look stale to recovery.
        if (this.progressPending && !this.claimLost) this.queueRenewal();
      });
  }

  /** Finish any already-requested refresh before the caller settles the claim. */
  async drain(): Promise<void> {
    const renewing = this.renewal;
    await renewing;
    if (renewing !== this.renewal) await this.drain();
  }

  /** The irreversible host-land boundary is itself a durable work advancement. */
  async confirmBeforeLand(): Promise<boolean> {
    await this.drain();
    if (this.claimLost) return false;
    const renew = this.queue.renewClaim;
    if (renew === undefined) return true;
    try {
      const renewed = await renew.call(this.queue, this.queueId);
      if (!renewed) this.loseClaim("merge claim ownership was lost before host land");
      return renewed;
    } catch (error) {
      log.error("merge claim land fence failed", { queueId: this.queueId }, error);
      this.loseClaim("merge claim ownership could not be confirmed before host land");
      return false;
    }
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get active(): boolean {
    return !this.claimLost;
  }

  private loseClaim(reason: string): void {
    if (this.claimLost) return;
    this.claimLost = true;
    this.abortController.abort(new Error(reason));
  }
}
