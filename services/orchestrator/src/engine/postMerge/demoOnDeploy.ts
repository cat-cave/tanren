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
// never narrated for an app that was never deployed. IDEMPOTENT per run on ANY
// terminal demo outcome (`demo.completed` OR `demo.failed`) — both are run-scoped
// appends that wake the run-activity bus, so gating only on `demo.completed`
// self-loops on any real demo failure. One terminal demo per run suffices; a
// notification storm collapses to a single demo.
//
// SECRET DISCIPLINE: the deploy token never reaches this file (it is resolved inside
// the wrapped provisioner). The evidence events carry only behavior ids/titles +
// surface kind + outcome + an observable detail — never a token or a response body.

import { runWithJobOrgId, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { EventStore } from "../eventStore.js";
import { PgEventStore } from "../eventStore.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { DemoSurface, DeployRef } from "../contracts/deployAdapter.js";
import { type DeployHttpTransport, fetchDeployTransport } from "../provisioners/deployTransport.js";
import { OrgIntegrationsStore } from "../repositories/orgIntegrations.js";
import { systemActor } from "../state/actor.js";
import { adapterKindForProviderKind, buildDeployAdapter } from "../deploy/buildDeployAdapter.js";
import type { PulumiStackRunner } from "../deploy/pulumiDeployAdapter.js";
import type { PackageRegistryClient } from "../deploy/packageReleaseDeployAdapter.js";
import type { MobileDistributionClient } from "../deploy/mobileReleaseDeployAdapter.js";
import type { ManualAttestationStore } from "../deploy/manualExternalDeployAdapter.js";
import { DemoEngine, type DemoBehavior } from "../demo/demoEngine.js";
import { fetchDemoWebProbe } from "../demo/demoWebProbe.js";
import type { DemoWebProbe } from "../demo/demoEvidence.js";
import { type DemoPackageProbe, fetchDemoPackageProbe } from "../demo/demoPackageArm.js";
import { type DemoDownloadProbe, fetchDemoDownloadProbe } from "../demo/demoDownloadArm.js";
import { type DemoAppChannelProbe, surfaceDescriptorAppChannelProbe } from "../demo/demoAppChannelArm.js";
import { loadVerifiedDeploy, loadSpecBehaviors, type VerifiedDeploy } from "./demoOnDeployReads.js";

/** The phase a demo failed in — drives the fixed, machine-parseable `demo.failed.reason`. */
type DemoFailPhase = "resolve_surface_failed" | "load_behaviors_failed" | "exercise_failed";

/**
 * The FIXED, non-secret `demo.failed.detail` summaries. Deliberately NOT the raw error
 * (which can embed provider-supplied HTTP response text); the full error is preserved
 * via the subscriber's `log.error` re-throw. Mirrors `deployOnMergeReads.ts`'s
 * `DEPLOY_FAILED_REASON` discipline.
 */
const DEMO_FAILED_DETAIL: Record<DemoFailPhase, string> = {
  resolve_surface_failed:
    "demo could not resolve the deployed exercise surface (grant lost mid-flight, or the DeployAdapter's demoSurface read failed); see the run logs for provider detail",
  load_behaviors_failed:
    "demo could not load the spec's behaviors before exercising the surface; see the run logs for the underlying error",
  exercise_failed:
    "demo threw while exercising the spec's behaviors against the deployed surface; see the run logs for the underlying error",
};

/** The engine's unsupported-surface-kind exhaustive throw is a distinct diagnosis — surface it. */
const UNSUPPORTED_SURFACE_DETAIL =
  "demo cannot exercise this deployed surface kind — either no arm is registered (a new surface kind on the " +
  "contract) or the arm's probe is not wired in the demo-on-deploy watcher deps";

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
  /**
   * The registry-metadata probe a `package` surface is exercised over. Injectable for
   * tests; defaults to the production `fetch`-backed probe when absent.
   */
  packageProbe?: DemoPackageProbe;
  /**
   * The streamed-fetch + SHA-256 probe a `download` surface is exercised over.
   * Injectable for tests; defaults to the production `fetch`-backed streaming probe.
   */
  downloadProbe?: DemoDownloadProbe;
  /**
   * The presence-reread probe an `app_channel` surface is exercised over. Injectable
   * for tests; defaults to the surface-descriptor probe (the DeployAdapter's
   * `demoSurface` already validated the buildRef at surface-resolve time — the base
   * probe attests to that presence at demo time).
   */
  appChannelProbe?: DemoAppChannelProbe;
  /**
   * External drivers the non-`direct_api` DeployAdapters require for their
   * `demoSurface` reads (mirrors {@link BuildDeployAdapterDeps}). Present only when the
   * project's deploy provider requires them (a `pulumi` project must wire
   * `pulumiRunner`, a `package_release` must wire `packageRegistry`, etc.); absent when
   * the project's provider is `direct_api` (Vercel/Fly) or `manual_external` (in-process
   * attestations). An unwired driver for a provider that requires one fails LOUD (typed
   * `DeployAdapterConfigError`) — never a silent skip.
   */
  pulumiRunner?: PulumiStackRunner;
  packageRegistry?: PackageRegistryClient;
  mobileDistribution?: MobileDistributionClient;
  manualAttestations?: ManualAttestationStore;
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
      packageProbe: deps.packageProbe ?? fetchDemoPackageProbe(),
      downloadProbe: deps.downloadProbe ?? fetchDemoDownloadProbe(),
      appChannelProbe: deps.appChannelProbe ?? surfaceDescriptorAppChannelProbe(),
    });
  }

  /**
   * Exercise the spec's behaviors against the run's verified deploy surface + record
   * per-behavior evidence. Returns without effect when the run's deploy is not
   * verified or this run already reached a terminal demo outcome
   * (`demo.completed` OR `demo.failed`).
   *
   * DURABLE FAILURE (mirrors {@link DeployOnMergeWatcher.check}): once a demo is EXPECTED
   * (a verified deploy exists and this run has not yet demoed), ANY throw records a
   * durable `demo.failed` (→ a `warn`) BEFORE re-throwing, never a subscriber-swallowed
   * `log.error` that leaves the timeline looking "deploy verified, everything fine" while
   * the demo actually died. The reason category is derived from the failing phase; the
   * detail is a FIXED non-secret summary (the raw error stays in the run logs via the
   * re-throw).
   */
  async check(runId: string): Promise<void> {
    if (runId === "") return;
    const verified = await runWithSystemScope(this.deps.pool, (client) => loadVerifiedDeploy(client, runId));
    // No verified deploy ⇒ no live surface to exercise ⇒ clean no-op (not an error).
    if (verified === undefined) return;
    // Idempotent on ANY terminal demo outcome — `demo.completed` OR `demo.failed`.
    // BOTH wake the run-activity bus (`eventStore.ts` NOTIFYs `tanren_run` on any
    // event append), so gating only on `demo.completed` self-loops on any real
    // demo failure: the subscriber wakes on the `demo.failed` append, re-enters
    // `check()`, re-throws, re-appends `demo.failed`, and storms `warn`s at the
    // operator per merge. Mirrors `deployOnMerge.ts`'s `alreadyTerminal`
    // discipline (which unifies verified/failed/skipped under one terminal gate).
    if (verified.alreadyTerminalDemo) return;

    let phase: DemoFailPhase = "resolve_surface_failed";
    let surfaceKind: string | undefined;
    try {
      const surface = await this.resolveSurface(verified);
      surfaceKind = surface.kind;
      phase = "load_behaviors_failed";
      const behaviors = await runWithSystemScope(this.deps.pool, (client) =>
        loadSpecBehaviors(client, verified.specId, verified.orgId, verified.projectId),
      );

      phase = "exercise_failed";
      await this.engine.exercise(
        { runId, specId: verified.specId, projectId: verified.projectId, orgId: verified.orgId },
        surface,
        behaviors satisfies ReadonlyArray<DemoBehavior>,
      );
    } catch (error) {
      // The engine's unsupported-surface-kind exhaustive throw fires DURING exercise but
      // is a distinct operator-diagnosis (the surface DID resolve — the kind just has no
      // arm yet). Refine the reason so the operator sees "unsupported_surface_kind" rather
      // than the generic exercise_failed.
      const isUnsupportedKind = phase === "exercise_failed" && isUnsupportedSurfaceKindError(error);
      const reason = isUnsupportedKind ? "unsupported_surface_kind" : phase;
      const detail = isUnsupportedKind ? UNSUPPORTED_SURFACE_DETAIL : DEMO_FAILED_DETAIL[phase];
      await this.appendDemoFailed(runId, verified, { reason, detail, surfaceKind });
      throw error;
    }
  }

  /**
   * Append the DURABLE `demo.failed` under the run's org scope so the operator + run
   * timeline SEE the demo failure instead of a subscriber-swallowed `log.error`. Fixed
   * non-secret reason + detail; the raw error stays in the run logs.
   */
  private async appendDemoFailed(
    runId: string,
    verified: VerifiedDeploy,
    args: {
      reason: "resolve_surface_failed" | "load_behaviors_failed" | "unsupported_surface_kind" | "exercise_failed";
      detail: string;
      surfaceKind: string | undefined;
    },
  ): Promise<void> {
    await runWithJobOrgId(verified.orgId, async () => {
      await this.eventStore.append({
        runId,
        specId: verified.specId,
        projectId: verified.projectId,
        orgId: verified.orgId,
        eventType: "demo.failed",
        payload: {
          reason: args.reason,
          detail: args.detail,
          provider: verified.provider,
          ...(args.surfaceKind !== undefined && { surfaceKind: args.surfaceKind }),
        },
      });
    });
  }

  /**
   * Resolve the deployed EXERCISE SURFACE for the verified deploy via the DeployAdapter
   * — the provider-agnostic seam. The grant must still resolve (it resolved at verify
   * time); its disappearance mid-flight is a LOUD error, never a skipped demo.
   *
   * ADAPTER DISPATCH: the adapter CLASS is derived from the persisted deploy provider
   * kind (via {@link adapterKindForProviderKind}) — a `deploy.vercel` runs the
   * `direct_api` adapter, a `deploy.package_release` runs the `package_release`
   * adapter, a `deploy.manual_external` runs the `manual_external` adapter, etc. The
   * previous hard-wire to `direct_api` was Bug 2 (Codex H3 #24): a project deployed via
   * a `package_release` / `mobile_release` / `manual_external` / `pulumi` deploy would
   * either resolve to the wrong surface (a Vercel/Fly `deploymentStatus` read against
   * a non-Vercel/Fly provider) or throw the wrong error. Now the DISPATCH is data-driven: the recorded
   * provider kind selects the right adapter's `demoSurface`.
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
    const adapterKind = adapterKindForProviderKind(verified.provider);
    const adapter = buildDeployAdapter(adapterKind, {
      provisioner: { transport: this.deps.transport, secrets: this.deps.secrets },
      ...(this.deps.pulumiRunner !== undefined && { pulumiRunner: this.deps.pulumiRunner }),
      ...(this.deps.packageRegistry !== undefined && { packageRegistry: this.deps.packageRegistry }),
      ...(this.deps.mobileDistribution !== undefined && { mobileDistribution: this.deps.mobileDistribution }),
      ...(this.deps.manualAttestations !== undefined && { manualAttestations: this.deps.manualAttestations }),
      // H3 #20/#21: manual_external adapter needs the tenant scope (orgId + projectId)
      // each attestation is recorded under — an unscoped adapter would silently
      // write cross-tenant rows. The verified deploy carries both.
      manualOwnerScope: { orgId: verified.orgId, projectId: verified.projectId },
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

/**
 * Recognize a {@link DemoEngine} unsupported-surface-kind throw so the
 * `demo.failed.reason` refines from the generic `exercise_failed` to the more actionable
 * `unsupported_surface_kind`. Since the engine now implements ALL four surface arms
 * (Bug 1 fix), the only remaining sources are:
 *   • the exhaustive default (a surface kind added to the contract but not to
 *     `exerciseOne`) — the pre-existing "no exercise for surface kind" stem;
 *   • a {@link DemoProbeMissingError} (a surface kind IS implemented but its probe
 *     was not wired into `DemoEngineDeps`) — the new stem "probe for surface kind '…'
 *     is not wired".
 * Both are equally actionable as `unsupported_surface_kind` from the operator's
 * perspective (the surface resolved; the demo could not exercise it), so we map both
 * to the same refined reason.
 */
function isUnsupportedSurfaceKindError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith("demoEngine: no exercise for surface kind '") ||
    error.message.startsWith("demoEngine: probe for surface kind '")
  );
}
