// Demos-as-evidence, WIRED (design doc § "Native Deployment And Demos"). This is the
// post-merge subscriber that turns a VERIFIED deploy into per-behavior demo evidence:
// once a run's deploy is proven live (`deploy.verified`), it resolves the deployed
// EXERCISE SURFACE (via the DeployAdapter's `demoSurface`), loads the spec's
// BEHAVIORS, and runs the DemoEngine to exercise + record evidence PER behavior.
//
// It is the production caller the `demo` role was missing. It reacts on the SAME
// `merge.completed` run-activity wake the deploy-on-merge watcher uses — driven right
// AFTER it in the post-merge subscriber, so by the time this runs the deploy watcher
// has already emitted `deploy.verified`.
//
// GATED on a verified deploy: a run with no `deploy.verified` (no deploy target, or a
// deploy not yet verified) is a CLEAN NO-OP — demos are tied to a real live surface,
// never narrated for an app that was never deployed. IDEMPOTENT per run: a prior
// `demo.completed` short-circuits, so a notification storm collapses to one demo.
//
// SECRET DISCIPLINE: the deploy token never reaches this file (it is resolved inside
// the wrapped provisioner). The evidence events carry only behavior ids/titles +
// surface kind + outcome + an observable detail — never a token or a response body.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { EventStore } from "../eventStore.js";
import { PgEventStore } from "../eventStore.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { DemoSurface, DeployRef } from "../contracts/deployAdapter.js";
import { type DeployHttpTransport, fetchDeployTransport } from "../provisioners/deployTransport.js";
import { OrgIntegrationsStore } from "../repositories/orgIntegrations.js";
import { systemActor } from "../state/actor.js";
import { buildDeployAdapter } from "../deploy/buildDeployAdapter.js";
import { DIRECT_API_ADAPTER_KIND } from "../deploy/directApiDeployAdapter.js";
import { DemoEngine, type DemoBehavior } from "../demo/demoEngine.js";
import { fetchDemoWebProbe } from "../demo/demoWebProbe.js";
import type { DemoWebProbe } from "../demo/demoEvidence.js";
import { loadVerifiedDeploy, loadSpecBehaviors, type VerifiedDeploy } from "./demoOnDeployReads.js";

export interface DemoOnDeployWatcherDeps {
  /** The runtime (`tanren_app`) pool; the watcher re-reads under the system scope. */
  pool: pg.Pool;
  secrets: SecretStore;
  /** The deploy transport the DeployAdapter's `demoSurface` status read runs over (scripted in tests). */
  transport: DeployHttpTransport;
  /** Injectable for tests; defaults to a `PgEventStore` over `pool`. */
  eventStore?: EventStore;
  /**
   * Plane-split: the control-plane run-state writer. When present the demo evidence
   * appends route through the control plane (the de-privileged data plane can no
   * longer write `events` directly); absent, in-process via `PgEventStore`.
   */
  runStateWriter?: RunStateWriter;
  /**
   * The HTTP reach probe a `web_url` surface is exercised over. Injectable for tests
   * (a scripted probe); defaults to the production fetch probe when absent.
   */
  webProbe?: DemoWebProbe;
}

/**
 * The demo-on-deploy watcher. `check(runId)` is the per-run pass the post-merge
 * subscriber drives on each `merge.completed` wake, AFTER the deploy watcher. A no-op
 * unless the run's deploy is verified; idempotent (one demo per run).
 */
export class DemoOnDeployWatcher {
  private readonly eventStore: EventStore;
  private readonly engine: DemoEngine;

  constructor(private readonly deps: DemoOnDeployWatcherDeps) {
    this.eventStore = deps.eventStore ?? deps.runStateWriter ?? new PgEventStore(deps.pool);
    this.engine = new DemoEngine({
      events: this.eventStore,
      webProbe: deps.webProbe ?? fetchDemoWebProbe(),
    });
  }

  /**
   * Exercise the spec's behaviors against the run's verified deploy surface + record
   * per-behavior evidence. Returns without effect when the run's deploy is not
   * verified or this run already ran a demo.
   */
  async check(runId: string): Promise<void> {
    if (runId === "") return;
    const verified = await runWithSystemScope(this.deps.pool, (client) => loadVerifiedDeploy(client, runId));
    // No verified deploy ⇒ no live surface to exercise ⇒ clean no-op (not an error).
    if (verified === undefined) return;
    // Idempotent: this run already ran its demo.
    if (verified.alreadyDemoed) return;

    const surface = await this.resolveSurface(verified);
    const behaviors = await runWithSystemScope(this.deps.pool, (client) =>
      loadSpecBehaviors(client, verified.specId, verified.orgId, verified.projectId),
    );

    await this.engine.exercise(
      { runId, specId: verified.specId, projectId: verified.projectId, orgId: verified.orgId },
      surface,
      behaviors satisfies ReadonlyArray<DemoBehavior>,
    );
  }

  /**
   * Resolve the deployed EXERCISE SURFACE for the verified deploy via the DeployAdapter
   * — the provider-agnostic seam. The grant must still resolve (it resolved at verify
   * time); its disappearance mid-flight is a LOUD error, never a skipped demo.
   */
  private async resolveSurface(verified: VerifiedDeploy): Promise<DemoSurface> {
    const grant = await runWithSystemScope(this.deps.pool, (client) =>
      OrgIntegrationsStore.getGrant(client, verified.orgId, verified.provider, systemActor),
    );
    if (grant === undefined) {
      throw new Error(
        `demoOnDeploy: run '${verified.runId}' has a verified deploy on '${verified.provider}' but org ` +
          `'${verified.orgId}' has no matching grant — cannot resolve the demo surface`,
      );
    }
    const adapter = buildDeployAdapter(DIRECT_API_ADAPTER_KIND, {
      provisioner: { transport: this.deps.transport, secrets: this.deps.secrets },
    });
    const ref: DeployRef = { provider: grant.providerKind, appId: verified.appId };
    return adapter.demoSurface(grant, ref, verified.deploymentId);
  }
}

/**
 * Build the production demo-on-deploy watcher with the default deploy transport — a
 * thin factory so the autonomy-loops boot imports ONE symbol (keeps that file under
 * the max-dependencies cap; mirrors `buildDeployOnMergeWatcher`).
 */
export function buildDemoOnDeployWatcher(deps: {
  pool: pg.Pool;
  secrets: SecretStore;
  runStateWriter?: RunStateWriter;
}): DemoOnDeployWatcher {
  return new DemoOnDeployWatcher({
    pool: deps.pool,
    secrets: deps.secrets,
    transport: fetchDeployTransport(),
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
  });
}
