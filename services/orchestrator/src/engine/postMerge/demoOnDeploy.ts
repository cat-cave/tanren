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
import { IntegrationConnectionsStore, PgReleaseInstancesRepository } from "../repositories/index.js";
import { systemActor } from "../state/actor.js";
import { adapterKindForProviderKind, buildDeployAdapter } from "../deploy/buildDeployAdapter.js";
import type { ManualAttestationStore } from "../deploy/manualExternalDeployAdapter.js";
import { DemoEngine, type DemoBehavior } from "../demo/demoEngine.js";
import { type DemoPackageProbe, fetchDemoPackageProbe } from "../demo/demoPackageArm.js";
import { type DemoDownloadProbe, fetchDemoDownloadProbe } from "../demo/demoDownloadArm.js";
import { type DemoAppChannelProbe, surfaceDescriptorAppChannelProbe } from "../demo/demoAppChannelArm.js";
import {
  buildProofBackedWebDemo,
  isProofBackedLoadFailure,
  type ProofBackedWebDemo,
} from "../demo/proofBackedWebDemo.js";
import {
  loadRunReleaseInstance,
  loadVerifiedDeploy,
  loadSpecBehaviors,
  type VerifiedDeploy,
} from "./demoOnDeployReads.js";

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
   * rv-18: the PROOF-BACKED web demo a `web_url` surface is exercised through — it DRIVES
   * the rv-11 acceptance orchestrator (rv-6 HTTP driver against the run's real release URL)
   * to execute the product's declared behaviors and derive a REAL per-behavior verdict,
   * replacing the naive `/`-reachability probe. Injectable for tests; defaults to a real
   * acceptance-driven demo over `pool` when absent.
   */
  proofBackedWebDemo?: ProofBackedWebDemo;
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
   * The durable manual-attestation store the `manual_external` adapter class reads
   * back its recorded rows from. Injected for a project on the `deploy.manual_external`
   * provider; absent for `direct_api` (Vercel/Fly) — those adapters use the deploy
   * transport, not this store. Codex H3 #22: the pulumi / package_release /
   * mobile_release drivers are NOT accepted here anymore (their adapter classes are
   * fixture-only and cannot be built via `buildDeployAdapter`), so a persisted
   * `deploy.pulumi` / `deploy.package_release` / `deploy.mobile_release` provider
   * fails LOUD at surface-resolve time (`resolve_surface_failed`).
   */
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
  private readonly proofBackedWebDemo: ProofBackedWebDemo;

  constructor(private readonly deps: DemoOnDeployWatcherDeps) {
    this.eventStore = deps.eventStore ?? deps.runStateWriter ?? new PgEventStore(deps.pool);
    // rv-18: the NON-WEB arms (package / download / app_channel) keep their real per-behavior
    // exercises; the `web_url` arm is SUPERSEDED by the proof-backed demo below (no `/`-probe).
    this.engine = new DemoEngine({
      events: this.eventStore,
      packageProbe: deps.packageProbe ?? fetchDemoPackageProbe(),
      downloadProbe: deps.downloadProbe ?? fetchDemoDownloadProbe(),
      appChannelProbe: deps.appChannelProbe ?? surfaceDescriptorAppChannelProbe(),
    });
    // rv-18: the `web_url` arm drives the real rv-11 acceptance orchestrator over the run's
    // real release URL (built by the factory; the verdict lands as append-only `demo.*`
    // evidence, not the pre-merge `behavior_verdicts` ledger — see proofBackedWebDemo.ts).
    this.proofBackedWebDemo = deps.proofBackedWebDemo ?? buildProofBackedWebDemo(deps.pool, this.eventStore);
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
      const target = { runId, specId: verified.specId, projectId: verified.projectId, orgId: verified.orgId };

      // rv-18: a deployed WEB product is demoed PROOF-BACKED — the acceptance orchestrator
      // executes its declared behaviors against the REAL release URL and the demo verdict is
      // the real per-behavior verdict, NOT a `/`-reachability check. The non-web arms keep
      // their existing real per-behavior exercises.
      if (surface.kind === "web_url") {
        phase = "exercise_failed";
        const release = await loadRunReleaseInstance(this.deps.pool, verified.orgId, verified.projectId, runId);
        if (release === undefined) {
          throw new Error(
            `demoOnDeploy: run '${runId}' has a verified web deploy but no probeable release instance to demo`,
          );
        }
        await this.proofBackedWebDemo.demo(target, release);
      } else {
        phase = "load_behaviors_failed";
        const behaviors = await runWithSystemScope(this.deps.pool, (client) =>
          loadSpecBehaviors(client, verified.specId, verified.orgId, verified.projectId),
        );
        phase = "exercise_failed";
        await this.engine.exercise(target, surface, behaviors satisfies ReadonlyArray<DemoBehavior>);
      }
    } catch (error) {
      const refined = refineDemoFailure(error, phase);
      await this.appendDemoFailed(runId, verified, { reason: refined.reason, detail: refined.detail, surfaceKind });
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
   * kind (via {@link adapterKindForProviderKind}) — a `deploy.vercel` / `deploy.flyio`
   * runs the `direct_api` adapter, a `deploy.manual_external` runs the `manual_external`
   * adapter. The previous hard-wire to `direct_api` was Bug 2 (Codex H3 #24): a project
   * deployed via a non-Vercel/Fly provider would resolve to the wrong surface or throw
   * the wrong error. Now the DISPATCH is data-driven.
   *
   * Codex H3 #22: `deploy.pulumi` / `deploy.package_release` / `deploy.mobile_release`
   * are fixture-only (no concrete production driver on `main`), so a persisted deploy
   * on one of those provider kinds throws LOUD here — the try/catch in `check` records
   * the failure as `resolve_surface_failed` on the run's `demo.failed` event, which is
   * exactly the operator-facing surface for "this adapter is not available in
   * production yet".
   */
  private async resolveSurface(verified: VerifiedDeploy): Promise<DemoSurface> {
    const grant = await runWithSystemScope(this.deps.pool, async (client) => {
      const authority = new (await import("../integrations/integrationAuthorityImpl.js")).PgIntegrationAuthority();
      const resolution = await authority.authorizeOperation(client, {
        orgId: verified.orgId,
        projectId: verified.projectId,
        providerKind: verified.provider,
        capability: "deploy",
        operation: "resolve_demo_surface",
        target: { resourceId: verified.appId, deploymentId: verified.deploymentId },
        actor: systemActor,
      });
      if (resolution.status === "not_linked") {
        throw new Error(
          `demoOnDeploy: run '${verified.runId}' has a verified deploy on '${verified.provider}' but org ` +
            `'${verified.orgId}' has no matching grant — cannot resolve the demo surface`,
        );
      }
      if (resolution.status === "selection_required") {
        throw new Error(
          `demoOnDeploy: project '${verified.projectId}' requires an explicit active '${verified.provider}' account selection (${resolution.reason})`,
        );
      }
      if (resolution.status === "ineligible") {
        throw new Error(
          `demoOnDeploy: project '${verified.projectId}' deploy grant ineligible (${resolution.reasons.join(",")})`,
        );
      }
      return IntegrationConnectionsStore.orgGrantFromLease(resolution.lease);
    });
    const adapterKind = adapterKindForProviderKind(verified.provider);
    const adapter = buildDeployAdapter(adapterKind, {
      provisioner: { transport: this.deps.transport, secrets: this.deps.secrets },
      releaseInstances: new PgReleaseInstancesRepository(this.deps.pool),
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
/**
 * Refine the durable `demo.failed` reason + detail from the caught error + the coarse phase.
 * An unsupported non-web surface kind (rv nothing to exercise), a proof-backed web demo with
 * no declared behaviors, or an unreadable/malformed stored acceptance spec map to the precise
 * operator-facing reason; everything else falls back to the phase. All detail strings are
 * FIXED + non-secret (the raw error stays in the run logs via the re-throw).
 */
function refineDemoFailure(
  error: unknown,
  phase: DemoFailPhase,
): {
  reason: "resolve_surface_failed" | "load_behaviors_failed" | "unsupported_surface_kind" | "exercise_failed";
  detail: string;
} {
  if (phase === "exercise_failed" && isUnsupportedSurfaceKindError(error)) {
    return { reason: "unsupported_surface_kind", detail: UNSUPPORTED_SURFACE_DETAIL };
  }
  // rv-18 proof-backed web demo: a release with no declared behaviors OR an unreadable /
  // malformed stored acceptance spec is a LOAD failure (nothing to prove), regardless of
  // the coarse phase.
  if (isProofBackedLoadFailure(error)) {
    return { reason: "load_behaviors_failed", detail: DEMO_FAILED_DETAIL.load_behaviors_failed };
  }
  return { reason: phase, detail: DEMO_FAILED_DETAIL[phase] };
}

function isUnsupportedSurfaceKindError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith("demoEngine: no exercise for surface kind '") ||
    error.message.startsWith("demoEngine: probe for surface kind '")
  );
}
