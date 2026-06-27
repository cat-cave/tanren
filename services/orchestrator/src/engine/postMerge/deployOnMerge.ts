// Deploy-on-merge (apex "a deploy happened"): once a run's PR merges onto the
// default branch, this watcher attaches the project's runtime app env and THEN
// TRIGGERS a real deploy of the merged commit onto the project's deploy app
// (Vercel/Fly) — env-before-trigger, so the released deployment actually carries its
// runtime secrets — so the live product reflects the merge. It reacts on the SAME
// `merge.completed` run-activity bus the post-merge issue-watcher uses — no new poller.
//
// GATED via a THREE-WAY intent resolution — NONE (legitimate no-op, LOGGED) /
// INCOMPLETE-but-expected (LOUD fail-closed) / CONFIGURED (fires) — so a
// misconfigured-but-expected deploy can NEVER silently skip and make a run (apex) look
// "done" without a live deployment. Full rationale in `deployTargetResolution.ts`.
//
// DURABLE FAILURE: once a target resolves (a deploy is EXPECTED), ANY throw — verify
// exhaustion OR a trigger/attach failure — records a durable `deploy.failed` (→ a `warn`)
// BEFORE re-throwing, never a swallowed log line that leaves the merge looking "done".
// IDEMPOTENT per merge: gates on a prior TERMINAL `deploy.verified`/`deploy.failed` and
// resumes a prior unverified `deploy.triggered` — one deploy per merge.
//
// SECRET DISCIPLINE: the runtime env VALUES flow only into `attachRuntimeAppEnv`'s
// provider set-env request; the deploy token only into the provider's bearer. The emitted
// `deploy.triggered` carries provider + app id + resolved URL + deployment id — all
// non-secret — never a token/value.

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
import {
  type DeployTargetResolution,
  grantsSignalDeployIntent,
  resolveDeployTarget,
} from "./deployTargetResolution.js";
import { type EgressPolicy, defaultEgressPolicy } from "../security/egressPolicy.js";
import { type DeployHttpTransport, fetchDeployTransport } from "../provisioners/deployTransport.js";
import { OrgIntegrationsStore } from "../repositories/orgIntegrations.js";
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

    // Idempotent on a TERMINAL outcome: a VERIFIED deploy is done, and a FAILED
    // deploy (verify exhausted OR a trigger failure) must NOT be re-run — both gate to
    // a no-op so a `deploy.failed` append can't self-loop the run-activity bus.
    if (await this.alreadyTerminal(runId)) return;

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

    const grant = await this.loadGrant(target);
    if (grant === undefined) {
      throw new Error(
        `deployOnMerge: project '${merged.projectId}' configures deploy '${target.provider}' but org ` +
          `'${target.orgId}' has no matching grant in org_integrations`,
      );
    }

    // RESUME: a prior trigger that never reached `deploy.verified` (transient verify
    // failure / a crash between trigger and verify) re-runs VERIFICATION ONLY against the
    // already-released deployment — it does NOT re-trigger.
    const priorDeploymentId = await this.priorTriggeredDeploymentId(runId);
    if (priorDeploymentId !== undefined) {
      await this.verifyWithRetry(runId, merged.projectId, target, grant.providerKind, priorDeploymentId, recorded);
      return;
    }

    const provisioner = deployProvisionerFor(target.provider, {
      transport: this.deps.transport,
      secrets: this.deps.secrets,
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
    await this.verifyWithRetry(runId, merged.projectId, target, grant.providerKind, result.deploymentId, recorded);
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
    providerKind: string,
    deploymentId: string,
    recorded: { verifyPhase: boolean },
  ): Promise<void> {
    await verifyDeployUntilConverged(
      this.verifyCtx,
      { runId, projectId, target, providerKind, deploymentId, recorded },
      () => this.loadGrant(target),
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
   * `org_integrations` grants for deploy intent, then defers the configured/none/
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
      const grants = await OrgIntegrationsStore.list(client, orgId, systemActor);
      return resolveDeployTarget({ orgId, config, deployIntent: grantsSignalDeployIntent(grants) });
    });
  }

  /**
   * Whether this run reached a TERMINAL deploy outcome — `deploy.verified` (proven live) OR
   * `deploy.failed` (verify retry exhausted). Both gate `check()` to a no-op: a FAILED deploy
   * must NOT be re-verified — its run-scoped append wakes the subscriber, so without the
   * terminal gate the next pass would re-verify + re-append, self-looping.
   */
  private async alreadyTerminal(runId: string): Promise<boolean> {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<{ id: string }>(
        "SELECT id FROM events WHERE run_id = $1 AND event_type IN ('deploy.verified', 'deploy.failed') LIMIT 1",
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

  private async loadGrant(target: ProjectDeployTarget) {
    return runWithSystemScope(this.deps.pool, async (client) =>
      OrgIntegrationsStore.getGrant(client, target.orgId, target.provider, systemActor),
    );
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
}): DeployOnMergeWatcher {
  return new DeployOnMergeWatcher({
    pool: deps.pool,
    secrets: deps.secrets,
    transport: fetchDeployTransport(),
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
  });
}

// Re-export the demo-on-deploy watcher factory off this same module so the autonomy-loops
// boot imports both deploy-path watchers from ONE symbol source (the max-dependencies cap).
export { buildDemoOnDeployWatcher } from "./demoOnDeploy.js";
