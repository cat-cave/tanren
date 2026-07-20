// mq-13 Finding A — the CONTINUOUS liveness heartbeat that keeps a LIVE delivery owner's claim
// fresh for the WHOLE drive (including DURING the long external calls build/applyPreview/promote/
// demo the foreground is awaiting), so a genuinely-live owner NEVER ages out and is never taken
// over mid-external-effect (the double-deploy class). A takeover then happens ONLY when the owner
// is DEAD (this background loop stopped). It is a PROGRESS / sign-of-life renewal, NOT a
// wall-clock give-up cap — it bounds no work; it only proves the owner is still alive.

import { LandGroupDeliveryClaimLostError } from "./groupDeliveryCore.js";

/** The renew surface the heartbeat drives (a subset of PgLandGroupDeliveryStore). */
export interface ClaimRenewer {
  renewClaim(orgId: string, landGroupId: string, token: string): Promise<boolean>;
}

/** The default continuous-renew cadence — well under the liveness lease so a live owner stays fresh. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

export interface ClaimHeartbeat {
  /**
   * Authoritative fence-recheck: renew the claim NOW and throw {@link LandGroupDeliveryClaimLostError}
   * if it was taken over. The drive calls this before each irreversible external effect (and per
   * verify poll), so a lost claim aborts BEFORE firing.
   */
  assertOwned(): Promise<void>;
  /** Stop the background renew loop (idempotent). */
  stop(): void;
}

/**
 * Start a continuous background liveness heartbeat for an owned claim. Renews on a fixed cadence
 * (progress sign-of-life, not a deadline) for the whole drive; a definitive `renewClaim === false`
 * (taken over) marks the claim lost so the next `assertOwned` aborts. Never bounds any work.
 */
export function startClaimHeartbeat(input: {
  renewer: ClaimRenewer;
  orgId: string;
  landGroupId: string;
  token: string;
  intervalMs?: number;
}): ClaimHeartbeat {
  let lost = false;
  // Serialize renews so a slow renew never overlaps the next tick.
  let pending: Promise<void> = Promise.resolve();
  const tick = (): void => {
    pending = pending
      .then(() => input.renewer.renewClaim(input.orgId, input.landGroupId, input.token))
      .then((ok) => {
        if (!ok) lost = true;
      })
      .catch(() => {
        // A transient renew blip does NOT lose the claim (the lease still has slack); the next
        // tick retries. Only a definitive `renewClaim === false` (taken over) sets `lost`.
      });
  };
  const timer = setInterval(tick, input.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  // Do not hold the event loop open for the renew cadence — the drive stops it explicitly.
  (timer as { unref?: () => void }).unref?.();
  return {
    async assertOwned(): Promise<void> {
      if (lost) throw new LandGroupDeliveryClaimLostError(input.landGroupId);
      // Authoritative real-time fence-recheck (not just the cached flag): a lost claim aborts here.
      if (!(await input.renewer.renewClaim(input.orgId, input.landGroupId, input.token))) {
        lost = true;
        throw new LandGroupDeliveryClaimLostError(input.landGroupId);
      }
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}
