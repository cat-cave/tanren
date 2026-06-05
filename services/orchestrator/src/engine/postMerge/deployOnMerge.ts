// Deploy-on-merge (apex "a deploy happened"): once a run's PR merges onto the
// default branch, this watcher TRIGGERS a real deploy of the merged commit onto the
// project's deploy app (Vercel/Fly) and attaches the project's runtime app env, so
// the live product reflects the merge. It reacts on the SAME `merge.completed`
// run-activity bus the post-merge issue-watcher uses — no new poller.
//
// GATED on a deploy artifact: a project with NO deploy integration (no
// `deployProvider` + `deployAppId` in its config) is a CLEAN NO-OP (not an error) —
// most projects have no deploy target. A project that DOES configure a deploy and
// whose deploy genuinely FAILS is a LOUD error (the `triggerDeploy` throw
// propagates), never a silent degrade.
//
// IDEMPOTENT per merge: before triggering it checks for a prior `deploy.triggered`
// event on the run — present ⇒ this merge already deployed and it returns. So a
// notification storm collapses to one deploy per merge.
//
// SECRET DISCIPLINE: the runtime env VALUES flow only into `attachRuntimeAppEnv`'s
// provider set-env request; the deploy token only into the provider's bearer. The
// emitted `deploy.triggered` event carries the provider + app id + the resolved live
// URL + the deployment id — all non-secret — and never a token/value.

import { runWithJobOrgId, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { EventStore } from "../eventStore.js";
import { PgEventStore } from "../eventStore.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { serviceAuditActor, type AuditEnvelope } from "../events/schemas/audit.js";
import { systemActor } from "../state/actor.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { migrateProjectConfig } from "../config/index.js";
import { type EgressPolicy, defaultEgressPolicy } from "../security/egressPolicy.js";
import { type DeployHttpTransport, fetchDeployTransport } from "../provisioners/deployTransport.js";
import { OrgIntegrationsStore } from "../repositories/orgIntegrations.js";
import { attachRuntimeAppEnv } from "../workflow/attachRuntimeAppEnv.js";
import { deployProvisionerFor } from "../workflow/deployProvisionerFor.js";
import { buildDeployAdapter } from "../deploy/buildDeployAdapter.js";
import { DIRECT_API_ADAPTER_KIND } from "../deploy/directApiDeployAdapter.js";
import type { UrlReachabilityProbe, VerifyPollPolicy } from "../contracts/deployAdapter.js";

/** The deploy artifact a project carries in its config once a deploy capability was provisioned. */
export interface ProjectDeployTarget {
  /** The deploy provider kind (`deploy.vercel` | `deploy.flyio`). */
  provider: string;
  /** The deployed app/project id (the deployRef's appId). */
  appId: string;
  orgId: string;
  /**
   * AUDIT-EVIDENCE BASELINE: the governance policy version (the project config
   * version), stamped onto the governing `deploy.triggered` / `deploy.verified`
   * events so the audit trail records which policy revision the deploy ran under.
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
   * deploy URL. Injectable for tests (a scripted probe); defaults to the production
   * fetch probe inside `buildDeployAdapter` when absent.
   */
  urlProbe?: UrlReachabilityProbe;
  /** The verify poll cadence + bound; defaults to the production policy when absent. */
  verifyPoll?: VerifyPollPolicy;
  /**
   * SECURITY-BASELINE deploy-target allowlist (egressPolicy.ts). Consulted BEFORE a
   * deploy fires so the deploy target is governed by policy, not assumed allowed.
   * Defaults to the default-permissive policy (OSS / self-host posture); a
   * managed-hosting build slots a restrictive policy WITHOUT touching this watcher.
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
   * Trigger the project's deploy for a merged run + attach its runtime env. Returns
   * without effect when the run has not merged, the project has no deploy target, or
   * this merge already deployed. A configured deploy that fails throws LOUD.
   */
  async check(runId: string): Promise<void> {
    if (runId === "") return;
    const merged = await this.loadMergedRun(runId);
    if (merged === undefined) return;

    const target = await this.loadDeployTarget(merged.projectId);
    // No deploy integration on the project ⇒ clean no-op (not an error).
    if (target === undefined) return;

    // SECURITY-BASELINE deploy-target allowlist: a denied target is a LOUD hard
    // failure (no silent fallback) — the deploy never fires against an off-allowlist
    // target. The default policy is permissive (OSS posture), so this is a no-op
    // until a managed restrictive policy is slotted.
    const policy = this.deps.egressPolicy ?? defaultEgressPolicy;
    const decision = policy.allowsDeployTarget({ provider: target.provider, appId: target.appId });
    if (!decision.allowed) {
      throw new Error(
        `deployOnMerge: deploy target '${target.provider}' for project '${merged.projectId}' is not ` +
          `allowed by the egress policy: ${decision.reason}`,
      );
    }

    // Idempotent: this merge already deployed.
    if (await this.alreadyDeployed(runId)) return;

    const grant = await this.loadGrant(target);
    if (grant === undefined) {
      throw new Error(
        `deployOnMerge: project '${merged.projectId}' configures deploy '${target.provider}' but org ` +
          `'${target.orgId}' has no matching grant in org_integrations`,
      );
    }

    // Trigger the real build + release of the merged ref onto the app. A configured
    // deploy that fails to release throws here (LOUD) — never a silent no-op.
    const provisioner = deployProvisionerFor(target.provider, {
      transport: this.deps.transport,
      secrets: this.deps.secrets,
    });
    const result = await provisioner.deploy(grant, target.appId, { repo: merged.repoSlug, ref: merged.ref });

    // Attach the project's RUNTIME-scoped app env onto the deployed app (the live
    // product gets its secrets). System-scoped read of the app env; the values flow
    // only into the provider set-env request.
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
    await this.verifyDeploy(runId, merged.projectId, target, grant.providerKind, result.deploymentId);
  }

  /**
   * Verify the just-triggered deploy is live, then record `deploy.verified`. Builds
   * the `direct_api` DeployAdapter (the wrapped provider provisioner + the verify
   * seams), polls to READY + smoke-checks the resolved URL (LOUD throw on failure /
   * never-ready / unreachable), and appends the non-secret proof under the org scope.
   */
  private async verifyDeploy(
    runId: string,
    projectId: string,
    target: ProjectDeployTarget,
    providerKind: string,
    deploymentId: string,
  ): Promise<void> {
    const grant = await this.loadGrant(target);
    if (grant === undefined) {
      // The grant was present moments ago (the trigger resolved it); a disappearance
      // mid-flight is a hard error, never a skipped verify.
      throw new Error(`deployOnMerge: verify lost the org grant for '${target.provider}' on project '${projectId}'`);
    }
    const adapter = buildDeployAdapter(DIRECT_API_ADAPTER_KIND, {
      provisioner: { transport: this.deps.transport, secrets: this.deps.secrets },
      ...(this.deps.urlProbe !== undefined && { urlProbe: this.deps.urlProbe }),
      ...(this.deps.verifyPoll !== undefined && { poll: this.deps.verifyPoll }),
    });
    const verification = await adapter.verify(grant, { provider: providerKind, appId: target.appId }, deploymentId);
    await runWithJobOrgId(target.orgId, async () => {
      await this.eventStore.append({
        runId,
        projectId,
        eventType: "deploy.verified",
        payload: {
          provider: target.provider,
          appId: target.appId,
          deploymentId,
          url: verification.url,
          state: verification.state,
          smokeStatus: verification.smokeStatus,
          ...deployAuditEnvelope(target),
        },
      });
    });
  }

  /** Read the run's merge coordinates (project, merged repo slug, ref), system-scoped — undefined when not merged. */
  private async loadMergedRun(runId: string): Promise<MergedRunInfo | undefined> {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const merge = await client.query<{ payload: unknown }>(
        `SELECT payload FROM events WHERE run_id = $1 AND event_type = 'merge.completed'
           ORDER BY ts DESC, id DESC LIMIT 1`,
        [runId],
      );
      if (merge.rows[0] === undefined) return;
      const run = await client.query<{ project_id: string; pr_url: string | null; branch: string | null }>(
        `SELECT r.project_id, r.pr_url, r.branch, p.default_branch
           FROM runs r JOIN projects p ON p.project_id = r.project_id WHERE r.run_id = $1`,
        [runId],
      );
      const row = run.rows[0];
      if (row === undefined || row.pr_url === null) return;
      const repoSlug = repoSlugFromPrUrl(row.pr_url);
      if (repoSlug === undefined) return;
      return { projectId: row.project_id, repoSlug, ref: row.branch ?? "main" };
    });
  }

  /** Read the project's deploy target (provider + appId + org) from its config, system-scoped. */
  private async loadDeployTarget(projectId: string): Promise<ProjectDeployTarget | undefined> {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<{ config: unknown; org_id: string | null }>(
        "SELECT config, org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      const row = result.rows[0];
      if (row === undefined || row.org_id === null) return;
      const config =
        row.config !== null && typeof row.config === "object" && !Array.isArray(row.config)
          ? (row.config as Record<string, unknown>)
          : {};
      const provider = config["deployProvider"];
      const appId = config["deployAppId"];
      if (typeof provider !== "string" || typeof appId !== "string") return;
      // The governance policy version IS the project config version; parse it
      // through the strict migrator (a missing/unknown version is a LOUD error,
      // never a silent default) so the deploy audit record carries the real policy.
      const policyVersion = migrateProjectConfig(config).version;
      return { provider, appId, orgId: row.org_id, policyVersion };
    });
  }

  /** Whether this run already fired a `deploy.triggered` (one deploy per merge). */
  private async alreadyDeployed(runId: string): Promise<boolean> {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<{ id: string }>(
        "SELECT id FROM events WHERE run_id = $1 AND event_type = 'deploy.triggered' LIMIT 1",
        [runId],
      );
      return result.rows[0] !== undefined;
    });
  }

  private async loadGrant(target: ProjectDeployTarget) {
    return runWithSystemScope(this.deps.pool, async (client) =>
      OrgIntegrationsStore.getGrant(client, target.orgId, target.provider, systemActor),
    );
  }
}

/**
 * AUDIT-EVIDENCE BASELINE: the audit envelope stamped onto the governing deploy
 * events. A deploy-on-merge is driven by the autonomous engine with no human in the
 * loop, so the initiating actor is the SERVICE and there is no approving actor; the
 * policy version is the project's governance config revision. Shared by both the
 * trigger and the verify so they carry an identical envelope.
 */
function deployAuditEnvelope(target: ProjectDeployTarget): AuditEnvelope {
  return { policyVersion: target.policyVersion, initiatingActor: serviceAuditActor };
}

/** Derive `owner/name` from a GitHub PR URL (`https://github.com/owner/name/pull/N`). */
function repoSlugFromPrUrl(prUrl: string): string | undefined {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/u.exec(prUrl);
  return match === null ? undefined : `${match[1]}/${match[2]}`;
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

// Re-export the demo-on-deploy watcher factory off this same post-merge-deploy-path
// module, so the autonomy-loops boot imports both deploy-path watchers from ONE
// symbol source (keeps that file under the max-dependencies cap). The demo watcher
// runs right after this one on the same wake (demos-as-evidence).
export { buildDemoOnDeployWatcher } from "./demoOnDeploy.js";
