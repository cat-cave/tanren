// After merge, attach runtime env with the project's exact deploy grant, trigger
// the merged revision, and verify it live. Three-way intent resolution prevents a
// configured-but-broken deploy from skipping; terminal events make retries
// idempotent. Events carry references only, never tokens or environment values.

import { runWithJobOrgId, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { EventStore } from "../eventStore.js";
import { PgEventStore } from "../eventStore.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { systemActor } from "../state/actor.js";
import {
  appendDeployFailed,
  appendDeploySkipped,
  deployAuditEnvelope,
  type DeployVerifyContext,
  mergeShaFromPayload,
  repoSlugFromPrUrl,
  verifyDeployUntilConverged,
} from "./deployOnMergeReads.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { OrgGrant } from "../contracts/integrationProvisioner.js";
import {
  type DeployTargetResolution,
  grantsSignalDeployIntent,
  resolveDeployTarget,
} from "./deployTargetResolution.js";
import { type EgressPolicy, defaultEgressPolicy } from "../security/egressPolicy.js";
import { type DeployHttpTransport, fetchDeployTransport } from "../provisioners/deployTransport.js";
import type { FlyImageBuilder } from "../provisioners/flyImageBuilder.js";
import { IntegrationConnectionsStore } from "../repositories/integrationConnections.js";
import { attachRuntimeAppEnv } from "../workflow/attachRuntimeAppEnv.js";
import { deployProvisionerFor } from "../workflow/deployProvisionerFor.js";
import type { UrlReachabilityProbe, VerifyPollPolicy } from "../contracts/deployAdapter.js";
import { createLogger } from "../observability/logger.js";
const log = createLogger("deploy-on-merge");

/** The deploy artifact a project carries in its config once a deploy capability was provisioned. */
export interface ProjectDeployTarget {
  /** The deploy provider kind (`deploy.vercel` | `deploy.flyio`). */
  provider: string;
  /** The deployed app/project id (the deployRef's appId). */
  appId: string;
  orgId: string;
  /**
   * AUDIT-EVIDENCE BASELINE: the governance policy version (the project config version),
   * stamped onto the governing `deploy.triggered` / `deploy.verified` events so the audit
   * trail records which policy revision the deploy ran under.
   */
  policyVersion: number;
}

/** The merged-run coordinates a deploy is triggered FROM. */
interface MergedRunInfo {
  projectId: string;
  /** The merged repo, `owner/name`. */
  repoSlug: string;
  /** The git ref the provider builds + releases (the run's branch / the default branch). */
  ref: string;
}

/**
 * The result of reading a run's merge coordinates: NOT-merged (no deploy to consider),
 * MERGED-but-NO-SHA (a merge-wiring bug — record durably + fail loud when a deploy is
 * expected; carries `projectId` so `check()` can resolve deploy intent), or the OK info.
 */
type MergedRunResult =
  | { kind: "not_merged" }
  | { kind: "no_sha"; projectId: string }
  | { kind: "ok"; info: MergedRunInfo };

export interface DeployOnMergeWatcherDeps {
  /** The runtime (`tanren_app`) pool; the watcher re-reads under the system scope. */
  pool: pg.Pool;
  secrets: SecretStore;
  /** The deploy transport the provisioner runs over (scripted fake in tests). */
  transport: DeployHttpTransport;
  /** Injectable for tests; defaults to a `PgEventStore` over `pool`. */
  eventStore?: EventStore;
  /**
   * Plane-split: the control-plane run-state writer. When present (remote-writes on)
   * the `deploy.triggered` + `app_env.runtime_attached` appends route through the
   * control plane (the de-privileged data plane can no longer write `events`
   * directly); absent, in-process via `PgEventStore`.
   */
  runStateWriter?: RunStateWriter;
  /**
   * The URL smoke-check probe the post-trigger `verify` runs against the resolved
   * deploy URL. Injectable for tests; defaults to the production fetch probe.
   */
  urlProbe?: UrlReachabilityProbe;
  /** The verify poll cadence (the spacing between polls); defaults to the production policy when absent. */
  verifyPoll?: VerifyPollPolicy;
  /**
   * SECURITY-BASELINE deploy-target allowlist (egressPolicy.ts). Consulted BEFORE a
   * deploy fires so the target is governed by policy, not assumed allowed. Defaults
   * to the permissive policy (OSS posture); a managed build slots a restrictive one.
   */
  egressPolicy?: EgressPolicy;
  /**
   * The merge-reflecting image builder for Fly deploys (`deploy.flyio`). When present,
   * `triggerDeploy` builds the merged commit into `registry.fly.io/<app>:<sha>` and
   * releases THAT (the DEFAULT path — no flag). When absent, a Fly deploy fails loud
   * unless `TANREN_ALLOW_FLY_STATIC_DEPLOY=1` (the explicit non-merge-reflecting escape
   * hatch). Supplied by the boot wiring from `buildFlyImageBuilderFromEnv`; undefined
   * when the builder is not opted in. Ignored by non-Fly providers (Vercel builds its own).
   */
  flyImageBuilder?: FlyImageBuilder;
}

/**
 * The deploy-on-merge watcher. `check(runId)` is the per-run pass the post-merge
 * subscriber drives on each `merge.completed` wake. A no-op unless the run merged +
 * the project has a deploy target; idempotent (one deploy per merge).
 */
export class DeployOnMergeWatcher {
  private readonly eventStore: EventStore;

  constructor(private readonly deps: DeployOnMergeWatcherDeps) {
    this.eventStore = deps.eventStore ?? deps.runStateWriter ?? new PgEventStore(deps.pool);
  }

  /**
   * Attach runtime env + trigger the project's deploy for a merged run. A no-op when not
   * merged / no deploy configured (LOGGED) / already deployed; a durable `deploy.skipped`
   * + LOUD throw on a pre-resolution failure (incomplete config / missing mergeSha);
   * LOUD throw when a configured deploy fails.
   */
  async check(runId: string): Promise<void> {
    if (runId === "") return;
    const merged = await this.loadMergedRun(runId);
    if (merged.kind === "not_merged") return;

    const projectId = merged.kind === "ok" ? merged.info.projectId : merged.projectId;

    const resolved = await this.loadDeployTarget(projectId);
    if (resolved.kind === "none") {
      // No deploy EXPECTED (no config, no linked deploy integration) — a legitimate no-op.
      log.info("merged with no deploy configured/linked — skipping deploy (legitimate no-op)", { runId, projectId });
      return;
    }

    // A deploy IS expected (incomplete or configured); the org (the `deploy.skipped` write
    // scope) lives on `.orgId` (incomplete) or `.target.orgId` (configured).
    const orgId = resolved.kind === "configured" ? resolved.target.orgId : resolved.orgId;

    // Idempotent on ANY terminal outcome — GATE EARLY so the pre-resolution `deploy.skipped`
    // branches below cannot self-loop the run-activity bus. `deploy.skipped` NOTIFYs the same
    // wake path (per `eventStore.ts`), so without this gate a merge with no_sha /
    // config_incomplete would re-wake into the same branch, re-append, and storm at every
    // `warn`. A VERIFIED / FAILED deploy is likewise terminal (the FAILED verify-retry append
    // wakes the subscriber; without the gate it would re-verify + re-append). One append per
    // merge suffices — the throw at the pre-resolution branches is fail-loud, not a signal
    // to re-drive.
    if (await this.alreadyTerminal(runId)) return;

    // A merge with NO mergeSha cannot deploy — DURABLE `deploy.skipped` then fail LOUD.
    if (merged.kind === "no_sha") {
      const detail = `run ${runId} merge.completed carries no mergeSha — cannot determine the merged commit to deploy`;
      await appendDeploySkipped(this.verifyCtx, {
        runId,
        projectId,
        orgId,
        reason: "merge_sha_missing",
        detail,
      });
      throw new Error(`deployOnMerge: ${detail}`);
    }

    // A deploy is expected but the config has no COMPLETE target — DURABLE `deploy.skipped`
    // (vs a console-only swallow) then fail LOUD.
    if (resolved.kind === "incomplete") {
      const detail =
        `project '${projectId}' (org '${orgId}') links a deploy integration (deploy expected) but ` +
        `its config has no complete deploy target: ${resolved.reason}. Set deployProvider + deployAppId.`;
      await appendDeploySkipped(this.verifyCtx, {
        runId,
        projectId,
        orgId,
        reason: "config_incomplete",
        detail,
      });
      throw new Error(`deployOnMerge: ${detail} Refusing to silently skip.`);
    }
    const target = resolved.target;
    const mergedInfo = merged.info;

    // FAIL-CLOSED + LOUD + DURABLE: a deploy is now genuinely EXPECTED (a target
    // resolved). ANY throw — denied egress, a missing/lost grant, the provider
    // build/release failing, the env attach failing — must surface as a durable
    // `deploy.failed` (→ a `warn`) so the merge can never look "done" with no live URL.
    // `verifyWithRetry` records its OWN verify-phase failure first (the `verifyPhase`
    // guard skips a duplicate trigger-phase append for it).
    const recorded = { verifyPhase: false };
    try {
      await this.driveExpectedDeploy(runId, mergedInfo, target, recorded);
    } catch (error) {
      if (!recorded.verifyPhase) {
        await appendDeployFailed(this.verifyCtx, { runId, projectId, target, phase: "trigger" });
      }
      throw error;
    }
  }

  /**
   * Drive an EXPECTED deploy to a verified live URL (resume-verify OR trigger + attach
   * + verify). Any throw propagates LOUD to {@link check}, which records a durable
   * trigger-phase `deploy.failed` — UNLESS the verify retry already recorded a
   * verify-phase one (it sets `recorded.verifyPhase`), so the caller skips the duplicate.
   */
  private async driveExpectedDeploy(
    runId: string,
    merged: MergedRunInfo,
    target: ProjectDeployTarget,
    recorded: { verifyPhase: boolean },
  ): Promise<void> {
    // SECURITY-BASELINE deploy-target allowlist: a denied target is a LOUD hard failure
    // (no silent fallback). The default policy is permissive (OSS posture), so this is a
    // no-op until a managed restrictive policy is slotted.
    const policy = this.deps.egressPolicy ?? defaultEgressPolicy;
    const decision = policy.allowsDeployTarget({ provider: target.provider, appId: target.appId });
    if (!decision.allowed) {
      throw new Error(
        `deployOnMerge: deploy target '${target.provider}' for project '${merged.projectId}' is not ` +
          `allowed by the egress policy: ${decision.reason}`,
      );
    }

    const grant = await this.loadGrant(merged.projectId, target);
    if (grant === undefined) {
      throw new Error(
        `deployOnMerge: project '${merged.projectId}' configures deploy '${target.provider}' but org ` +
          `'${target.orgId}' has no matching grant in the active connection authority`,
      );
    }

    // RESUME: a prior trigger that never reached `deploy.verified` (transient verify
    // failure / a crash between trigger and verify) re-runs VERIFICATION ONLY against the
    // already-released deployment — it does NOT re-trigger.
    const priorDeploymentId = await this.priorTriggeredDeploymentId(runId);
    if (priorDeploymentId !== undefined) {
      await this.verifyWithRetry(runId, merged.projectId, target, grant, priorDeploymentId, recorded);
      return;
    }

    const provisioner = deployProvisionerFor(target.provider, {
      transport: this.deps.transport,
      secrets: this.deps.secrets,
      // Thread the merge-reflecting Fly builder so a Fly deploy builds the merged commit
      // (the seam PR2 added was unreachable until this wiring; without it prod Fly deploys
      // could never be merge-reflecting). Spread only when set (Vercel ignores it).
      ...(this.deps.flyImageBuilder === undefined ? {} : { flyImageBuilder: this.deps.flyImageBuilder }),
    });

    // ENV BEFORE TRIGGER: attach the project's RUNTIME-scoped app env onto the app FIRST,
    // so the build/release picks it up — a trigger-then-attach order would release a
    // deployment WITHOUT its runtime env (e.g. the merge introducing the Slack token would
    // ship a deploy that can't reach Slack until a later re-deploy). System-scoped read;
    // the values flow only into the provider set-env request. A failure throws LOUD.
    await runWithSystemScope(this.deps.pool, async (client) => {
      await attachRuntimeAppEnv({
        client,
        secrets: this.deps.secrets,
        transport: this.deps.transport,
        events: this.eventStore,
        projectId: merged.projectId,
        orgId: target.orgId,
        deployRef: { provider: target.provider, appId: target.appId },
        grant,
        actor: systemActor,
      });
    });

    // Trigger the real build + release of the merged ref onto the app (now that the
    // runtime env is attached). A configured deploy that fails to release throws here
    // (LOUD) — never a silent no-op.
    const result = await provisioner.deploy(grant, target.appId, { repo: merged.repoSlug, ref: merged.ref });

    // Record the deploy — the deploy target + resolved live URL + deployment id, all
    // non-secret. Under the run's org scope so the tenant `events` write is allowed.
    await runWithJobOrgId(target.orgId, async () => {
      await this.eventStore.append({
        runId,
        projectId: merged.projectId,
        orgId: target.orgId,
        eventType: "deploy.triggered",
        payload: {
          provider: target.provider,
          appId: target.appId,
          repo: merged.repoSlug,
          ref: merged.ref,
          deploymentId: result.deploymentId,
          url: result.url,
          state: result.state,
          // AUDIT-EVIDENCE BASELINE: the released artifact's NON-SECRET provenance —
          // the provider's stable deployment handle bound to the merged source ref
          // (`<provider>:<deploymentId>@<ref>`), the reference a provenance attestation
          // keys on. No `checksum`: the `direct_api` provider exposes no content digest
          // at trigger time, so it is honestly absent (never a fabricated hash).
          artifact: { provenanceRef: `${target.provider}:${result.deploymentId}@${merged.ref}` },
          ...deployAuditEnvelope(target),
        },
      });
    });

    // PROVE the deploy: poll the provider to a READY terminal + smoke-check the URL.
    // A configured deploy that never becomes ready (or whose URL never serves) throws
    // LOUD here — `deploy.triggered` is no longer the end; `deploy.verified` is the
    // proof. On success emit `deploy.verified` (provider + url + state, non-secret).
    await this.verifyWithRetry(runId, merged.projectId, target, grant, result.deploymentId, recorded);
  }

  /**
   * Verify with a PROGRESS-BASED in-process RETRY (feedback_no_timeouts_progress_based) — NO
   * 3-strikes, NO attempt cap. Delegates to {@link verifyDeployUntilConverged}, which re-drives
   * `verifyDeploy` (itself an UNBOUNDED poll-to-READY that fails LOUD on a provider ERROR
   * terminal / proven stuck-deploy) while the verify error keeps CHANGING (progress) and
   * escalates ONLY at an intelligent non-convergence fixed point (the SAME verify error
   * recurring). On escalation it records the LOUD verify-phase `deploy.failed`, sets
   * `recorded.verifyPhase` (so the outer guard skips a duplicate trigger-phase append), and
   * re-throws — never leaving the run silently triggered-but-unverified.
   */
  private async verifyWithRetry(
    runId: string,
    projectId: string,
    target: ProjectDeployTarget,
    grant: OrgGrant,
    deploymentId: string,
    recorded: { verifyPhase: boolean },
  ): Promise<void> {
    await verifyDeployUntilConverged(
      this.verifyCtx,
      { runId, projectId, target, providerKind: grant.providerKind, deploymentId, recorded },
      () => Promise.resolve(grant),
    );
  }

  /** The verify/append-failed collaborators' deps subset (built once off `this.deps`). */
  private get verifyCtx(): DeployVerifyContext {
    return {
      eventStore: this.eventStore,
      transport: this.deps.transport,
      secrets: this.deps.secrets,
      ...(this.deps.urlProbe !== undefined && { urlProbe: this.deps.urlProbe }),
      ...(this.deps.verifyPoll !== undefined && { verifyPoll: this.deps.verifyPoll }),
    };
  }

  /**
   * Read the run's merge coordinates (project, merged repo slug, ref), system-scoped:
   * `not_merged` (no merge / no usable PR URL), `no_sha` (merge recorded NO mergeSha — a
   * wiring bug `check()` records durably + fails loud on), or `ok`.
   */
  private async loadMergedRun(runId: string): Promise<MergedRunResult> {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const merge = await client.query<{ payload: unknown }>(
        `SELECT payload FROM events WHERE run_id = $1 AND event_type = 'merge.completed'
           ORDER BY ts DESC, id DESC LIMIT 1`,
        [runId],
      );
      if (merge.rows[0] === undefined) return { kind: "not_merged" };
      const run = await client.query<{ project_id: string; pr_url: string | null }>(
        `SELECT r.project_id, r.pr_url FROM runs r WHERE r.run_id = $1`,
        [runId],
      );
      const row = run.rows[0];
      if (row === undefined || row.pr_url === null) return { kind: "not_merged" };
      const repoSlug = repoSlugFromPrUrl(row.pr_url);
      if (repoSlug === undefined) return { kind: "not_merged" };
      // Deploy the MERGED COMMIT SHA recorded on `merge.completed` — NOT the run's PR
      // branch (squash-merge deletes it) nor the mutable default-branch HEAD (drifts
      // to a LATER merge before verify). A merge that recorded none is a wiring bug —
      // `check()` records a durable `deploy.skipped` then fails LOUD (no silent fallback).
      const ref = mergeShaFromPayload(merge.rows[0].payload);
      if (ref === undefined) {
        return { kind: "no_sha", projectId: row.project_id };
      }
      return { kind: "ok", info: { projectId: row.project_id, repoSlug, ref } };
    });
  }
  /**
   * Resolve the project's deploy intent on merge (system-scoped) into the THREE-WAY
   * {@link DeployTargetResolution}. Reads the project config + probes the org's
   * active control grants for deploy intent, then defers the configured/none/
   * incomplete decision to {@link resolveDeployTarget} (full rationale there).
   */
  private async loadDeployTarget(projectId: string): Promise<DeployTargetResolution> {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<{ config: unknown; org_id: string | null }>(
        "SELECT config, org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      const row = result.rows[0];
      // A project row with no org cannot resolve any tenant deploy grant — there is
      // no deploy intent to honor, so this is a legitimate no-op.
      if (row === undefined || row.org_id === null) return { kind: "none" };
      const orgId = row.org_id;
      const config =
        row.config !== null && typeof row.config === "object" && !Array.isArray(row.config)
          ? (row.config as Record<string, unknown>)
          : {};
      // Probe whether a deploy is EXPECTED: does the org link a deploy-capable
      // integration grant? Only consulted to distinguish an incomplete-but-expected
      // deploy (LOUD) from a legitimate "no deploy configured" no-op.
      const grants = await IntegrationConnectionsStore.listExactControlGrants(client, orgId);
      return resolveDeployTarget({
        orgId,
        config,
        deployIntent: grantsSignalDeployIntent(
          grants.map((grant) => ({ providerKind: grant.providerKind, capabilities: ["deploy"] })),
        ),
      });
    });
  }
  /**
   * Whether this run reached a TERMINAL deploy outcome — `deploy.verified` (proven live),
   * `deploy.failed` (verify retry exhausted / trigger failure), OR `deploy.skipped`
   * (pre-resolution failure — no_sha / config_incomplete). All three gate `check()` to a
   * no-op: their run-scoped append fires a `tanren_run` NOTIFY that wakes the subscriber, so
   * without the terminal gate the next pass would re-enter the same branch, re-append, and
   * self-loop (a per-merge `warn` storm to the operator). One terminal append per merge.
   */
  private async alreadyTerminal(runId: string): Promise<boolean> {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<{ id: string }>(
        "SELECT id FROM events WHERE run_id = $1 AND event_type IN ('deploy.verified', 'deploy.failed', 'deploy.skipped') LIMIT 1",
        [runId],
      );
      return result.rows[0] !== undefined;
    });
  }
  /** The latest `deploy.triggered` deploymentId, if any — drives the RESUME (re-verify) path. */
  private async priorTriggeredDeploymentId(runId: string): Promise<string | undefined> {
    return runWithSystemScope(this.deps.pool, async (client): Promise<string | undefined> => {
      const result = await client.query<{ payload: unknown }>(
        `SELECT payload FROM events WHERE run_id = $1 AND event_type = 'deploy.triggered'
           ORDER BY ts DESC, id DESC LIMIT 1`,
        [runId],
      );
      const payload = result.rows[0]?.payload;
      if (typeof payload !== "object" || payload === null) return undefined;
      const deploymentId = (payload as Record<string, unknown>)["deploymentId"];
      return typeof deploymentId === "string" && deploymentId.trim() !== "" ? deploymentId : undefined;
    });
  }
  private async loadGrant(projectId: string, target: ProjectDeployTarget) {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const authority = new (await import("../integrations/integrationAuthorityImpl.js")).PgIntegrationAuthority();
      const resolution = await authority.authorizeOperation(client, {
        orgId: target.orgId,
        projectId,
        providerKind: target.provider,
        capability: "deploy",
        operation: "provision",
        actor: systemActor,
      });
      if (resolution.status === "selection_required") {
        throw new Error(
          `deployOnMerge: project '${projectId}' requires an explicit active '${target.provider}' account selection (${resolution.reason})`,
        );
      }
      if (resolution.status === "ineligible") {
        throw new Error(
          `deployOnMerge: project '${projectId}' deploy grant ineligible (${resolution.reasons.join(",")})`,
        );
      }
      return resolution.status === "eligible"
        ? IntegrationConnectionsStore.orgGrantFromLease(resolution.lease)
        : undefined;
    });
  }
}
/**
 * Build the production deploy-on-merge watcher with the default deploy transport —
 * a thin factory so the autonomy-loops boot imports ONE symbol (keeps that file
 * under the max-dependencies cap).
 */
export function buildDeployOnMergeWatcher(deps: {
  pool: pg.Pool;
  secrets: SecretStore;
  runStateWriter?: RunStateWriter;
  /**
   * The merge-reflecting Fly image builder (from `buildFlyImageBuilderFromEnv`). When
   * present, Fly deploys build the merged commit; absent, a Fly deploy fails loud at
   * trigger time unless the static-image escape hatch is on. Optional — Vercel-only
   * installs leave it unset.
   */
  flyImageBuilder?: FlyImageBuilder;
}): DeployOnMergeWatcher {
  return new DeployOnMergeWatcher({
    pool: deps.pool,
    secrets: deps.secrets,
    transport: fetchDeployTransport(),
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
    ...(deps.flyImageBuilder !== undefined && { flyImageBuilder: deps.flyImageBuilder }),
  });
}
// Re-export the demo-on-deploy watcher factory off this same module so the autonomy-loops
// boot imports both deploy-path watchers from ONE symbol source (the max-dependencies cap).
export { buildDemoOnDeployWatcher } from "./demoOnDeploy.js";
