// The LOUD, durable signal for a swallowed single-instance machine reap. When a
// Fly app's stale-machine reap cannot fully converge (a list/delete blip left prior
// machines behind), the deploy STILL succeeds — but the failure must NOT be silently
// swallowed: the resulting machine accumulation fragments a single-instance product's
// file store (the apex-v96 class), presenting as a false "persistence broken" PRODUCT
// symptom whose real cause is INFRA. This reporter appends the durable
// `deploy.reap_failed` (warn) so an apex halt from accumulation is attributable to
// infra, not blamed on product code.
//
// Two callers share it: the inline post-verify reap (source `verify`) and the
// out-of-band Fly-machine orphan reconciler sweep (source `sweeper`). Both go through
// the SAME EventStore append under the org scope, so the event is tenant-attributable.

import { runWithJobOrgId } from "@tanren/db";
import { serviceAuditActor } from "../events/schemas/audit.js";
import type { EventStore } from "../eventStore.js";
import { reapHadFailure, type ReapOutcome } from "../provisioners/deployProvisioner.js";

/** Where a reap ran — the inline post-verify reap, or the out-of-band reconciler sweep. */
export type ReapSource = "verify" | "sweeper";

/** The tenant + target context a reap-failure event is stamped with. */
export interface ReapFailureContext {
  orgId: string;
  projectId: string;
  provider: string;
  appId: string;
  /** The live deployment/machine id the reap keeps (the reap must never delete it). */
  deploymentId: string;
  source: ReapSource;
  /** The governance policy version, when the caller has a resolved deploy target. */
  policyVersion?: number;
}

/**
 * Report a non-converged reap. Implementations make the failure LOUD + durable; the
 * deploy itself is unaffected (the reap already returned best-effort). A clean reap
 * ({@link reapHadFailure} false) is never reported.
 */
export interface ReapFailureReporter {
  report(outcome: ReapOutcome, ctx: ReapFailureContext): Promise<void>;
}

// A FIXED, non-secret summary — never raw provider HTTP text (which can embed secrets).
const REAP_FAILED_REASON =
  "single-instance machine reap did not fully converge (list/delete blip); prior machines may be " +
  "accumulating — the durable Fly-machine reconciler will retry on its next sweep";

/**
 * The production reporter: append `deploy.reap_failed` under the org scope. A clean
 * outcome is a no-op. Non-secret payload only (provider + ids + counts + a fixed reason).
 */
export class EventReapFailureReporter implements ReapFailureReporter {
  constructor(private readonly events: EventStore) {}

  async report(outcome: ReapOutcome, ctx: ReapFailureContext): Promise<void> {
    if (!reapHadFailure(outcome)) {
      return;
    }
    await runWithJobOrgId(ctx.orgId, async () => {
      await this.events.append({
        projectId: ctx.projectId,
        orgId: ctx.orgId,
        eventType: "deploy.reap_failed",
        payload: {
          provider: ctx.provider,
          appId: ctx.appId,
          deploymentId: ctx.deploymentId,
          source: ctx.source,
          listFailed: outcome.listFailed,
          failedMachineCount: outcome.failedMachineIds.length,
          reapedMachineCount: outcome.reapedMachineIds.length,
          reason: REAP_FAILED_REASON,
          ...(ctx.policyVersion !== undefined && { policyVersion: ctx.policyVersion }),
          initiatingActor: serviceAuditActor,
        },
      });
    });
  }
}
