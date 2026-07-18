// FLY-MACHINE ORPHAN SWEEPER (apex-v96 guard) — the durable, out-of-band reconciler
// for accumulated Fly machines the inline post-verify reap missed.
//
// THE LEAK SHAPE. A single-instance Fly product must converge to exactly ONE machine
// per deploy. The inline post-verify reap (DirectApiDeployAdapter.verify →
// FlyDeployApi.afterVerifiedDeployment) destroys the app's prior machines after a new
// release verifies live. But that reap is best-effort: if Fly's list/delete API blips
// during a deploy, prior machines survive. Accumulated machines FRAGMENT a
// single-instance product's file store (each machine has its own volume) — which
// presents as a false "persistence broken" PRODUCT symptom whose real cause is INFRA.
// That is the apex-v96 halt class. The inline reap now emits a LOUD `deploy.reap_failed`
// when it cannot converge, but a durable RECONCILER is the real fix: it re-runs the
// reap out-of-band on a cadence, so a transient deploy-time blip is corrected on the
// next sweep instead of silently accumulating.
//
// SIGN-OF-LIFE OVER WALL-CLOCK (doctrine, timeout-eradication.md §1). There is NO
// deadline and NO age filter: `intervalMs` is HOW OFTEN to reconcile, never a budget.
// Reaping is idempotent — a machine already gone is a no-op (a 404 delete counts as
// reaped), and an app already at one machine reaps nothing. The reconcile keeps ONLY
// the release_instances-recorded LIVE deployment's machine; every other machine is
// stale by construction (a single-instance app).
//
// ORG-SCOPED + CROSS-TENANT. The live-deployment enumeration is cross-tenant (one
// sweeper across all orgs, same as the runner-row orphan sweeper), but each reap runs
// under the deployment's OWN org grant (its Fly token), and a reap failure emits the
// org-scoped `deploy.reap_failed`. One bad deployment never stops the sweep.

import { createLogger } from "../observability/logger.js";
import type { OrgGrant } from "../contracts/integrationProvisioner.js";
import type { ReapFailureReporter } from "../deploy/reapFailureReporter.js";
import { reapHadFailure, type DeployProvisioner } from "./deployProvisioner.js";
import { FLY_PROVIDER_KIND } from "./flyDeployProvisioner.js";

const log = createLogger("fly-machine-orphan-sweeper");

/** One live Fly deployment to reconcile — the tenant scope + app + the machine to KEEP. */
export interface LiveFlyDeployment {
  orgId: string;
  projectId: string;
  /** The Fly app id (as recorded on `release_instances.app_id`). */
  appId: string;
  /** The live deployment/machine id the reap keeps (every OTHER machine is stale). */
  deploymentId: string;
}

/** Enumerates the current live Fly deployments to reconcile (cross-tenant, system-scope). */
export interface LiveFlyDeploymentSource {
  list(): Promise<LiveFlyDeployment[]>;
}

/** Resolves a fresh per-deployment Fly deploy grant (the reap token source). */
export interface FlyReapGrantResolver {
  resolve(deployment: LiveFlyDeployment): Promise<OrgGrant | undefined>;
}

export interface FlyMachineOrphanSweeperDeps {
  liveDeployments: LiveFlyDeploymentSource;
  grants: FlyReapGrantResolver;
  /** The Fly deploy provisioner the reconciler drives the reap through (reuses the inline reap). */
  provisioner: DeployProvisioner;
  /** The durable `deploy.reap_failed` reporter (org-scoped). */
  reporter: ReapFailureReporter;
  /** How often the sweeper reconciles. Defaults to 300_000 ms (one sweep / 5 min). */
  intervalMs?: number;
}

/** One sweep tick's outcome. Zero reconciled / zero reaped is a clean idempotent pass. */
export interface FlySweepSummary {
  /** How many live Fly deployments were reconciled this pass. */
  reconciled: number;
  /** Every stale machine id reaped this pass (across all deployments). */
  reapedMachineIds: string[];
  /** How many deployments had a non-converged reap (each emitted `deploy.reap_failed`). */
  reapFailures: number;
}

/**
 * The recurring out-of-band Fly-machine reconciler. Mirrors `RunnerRowOrphanSweeper`:
 * `start()`/`stop()`/`tick()`, an `unref()`'d timer, per-tick error tolerance (one bad
 * poll never stops the loop), `stop()` AWAITS the in-flight tick so teardown never races
 * a live sweep. Idempotent — a second tick over converged apps reaps nothing new.
 */
export class FlyMachineOrphanSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private ticking = false;
  private inFlightTick: Promise<unknown> | undefined;
  private readonly intervalMs: number;

  constructor(private readonly deps: FlyMachineOrphanSweeperDeps) {
    this.intervalMs = deps.intervalMs ?? 300_000;
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    // No immediate tick at boot (mirror RunnerRowOrphanSweeper): the first sweep fires
    // after one interval; the timer is `unref()`'d so the sweeper never holds the
    // process alive on its own.
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  /** Stop the loop and AWAIT any in-flight tick. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlightTick?.catch(() => {});
  }

  /** Run one reconciliation pass. A concurrent tick or a stopped sweeper is a clean no-op. */
  async tick(): Promise<FlySweepSummary> {
    if (this.ticking || this.stopped) {
      return emptySummary();
    }
    this.ticking = true;
    const settled = this.runTick();
    this.inFlightTick = settled;
    try {
      return await settled;
    } finally {
      this.ticking = false;
      if (this.inFlightTick === settled) {
        this.inFlightTick = undefined;
      }
    }
  }

  private async runTick(): Promise<FlySweepSummary> {
    let deployments: LiveFlyDeployment[];
    try {
      deployments = await this.deps.liveDeployments.list();
    } catch (error) {
      // A failure to enumerate is logged and the next tick retries — one bad poll
      // never stops the loop (same shape as the runner-row sweeper).
      log.error("fly machine sweep failed to enumerate live deployments (will retry next tick)", {}, error);
      return emptySummary();
    }
    const reapedMachineIds: string[] = [];
    let reapFailures = 0;
    for (const deployment of deployments) {
      const reaped = await this.reconcileOne(deployment);
      if (reaped === undefined) {
        continue;
      }
      reapedMachineIds.push(...reaped.reapedMachineIds);
      reapFailures += reaped.failed ? 1 : 0;
    }
    if (reapedMachineIds.length > 0) {
      log.info("fly machine sweep reaped stale machine(s)", { total: reapedMachineIds.length, reapFailures });
    }
    return { reconciled: deployments.length, reapedMachineIds, reapFailures };
  }

  /** Reconcile ONE live deployment. Never throws — a bad deployment never stops the sweep. */
  private async reconcileOne(
    deployment: LiveFlyDeployment,
  ): Promise<{ reapedMachineIds: string[]; failed: boolean } | undefined> {
    try {
      const grant = await this.deps.grants.resolve(deployment);
      if (grant === undefined) {
        log.warn("no eligible fly deploy grant for live deployment (skipping reap this tick)", {
          orgId: deployment.orgId,
          appId: deployment.appId,
        });
        return undefined;
      }
      const outcome = await this.deps.provisioner.afterVerifiedDeployment(
        grant,
        deployment.appId,
        deployment.deploymentId,
      );
      if (outcome === undefined) {
        return undefined;
      }
      let failed = false;
      if (reapHadFailure(outcome)) {
        failed = true;
        await this.deps.reporter.report(outcome, {
          orgId: deployment.orgId,
          projectId: deployment.projectId,
          provider: FLY_PROVIDER_KIND,
          appId: deployment.appId,
          deploymentId: deployment.deploymentId,
          source: "sweeper",
        });
      }
      return { reapedMachineIds: outcome.reapedMachineIds, failed };
    } catch (error) {
      log.error(
        "fly machine reconcile failed for deployment (will retry next tick)",
        {
          orgId: deployment.orgId,
          appId: deployment.appId,
        },
        error,
      );
      return undefined;
    }
  }
}

function emptySummary(): FlySweepSummary {
  return { reconciled: 0, reapedMachineIds: [], reapFailures: 0 };
}
