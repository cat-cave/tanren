// The DeployAdapter port — the deployment seam ABOVE the IntegrationProvisioner
// (docs/roadmap/tanren-direction.md § "Native Deployment And Demos"). Where
// `IntegrationProvisioner` provisions a deploy app and `DeployProvisioner.deploy`
// fires a fire-and-forget trigger, the DeployAdapter raises that to a VERIFIED
// lifecycle: provision-or-bind, deploy (trigger), and — the load-bearing addition —
// `verify`, which POLLS the provider until the deployment is genuinely READY (or
// fails LOUD) and then SMOKE-CHECKS the resolved URL is HTTP-reachable. This makes
// "a deploy happened" PROVEN, not merely triggered.
//
// SCOPE: this port covers the apex-relevant `direct_api` adapter class (the
// Vercel/Fly providers). It carries the verify capability (poll-to-ready + URL
// smoke) AND — the demos-as-evidence addition — `demoSurface`, which resolves the
// EXERCISE SURFACE (a `DemoSurface`) the demo engine runs the spec's behavior checks
// against, so demo evidence is tied to the spec's BEHAVIORS and not to the provider.
// The rest of the lifecycle the direction doc proposes — buildArtifact / plan /
// applyPreview / promote / rollback / teardownPreview / costEstimate, and the other
// adapter classes (pulumi / mobile_release / package_release / manual_external) — is
// DEFERRED. Each slots in as new methods on this port + new registry arms, exactly
// like the IntegrationProvisioner / Allocator seams grow.
//
// SECRET DISCIPLINE: this port never holds or returns a secret VALUE. The deploy
// token is resolved INSIDE the wrapped `DeployProvisioner` (from the org grant's
// `credentialRef` against the SecretStore) and flows only into the provider bearer.
// Every result type here is non-secret — refs, a URL, ids, a state string.

import type { OrgGrant, ProjectContext, ProvisionedArtifact } from "./integrationProvisioner.js";
import type { DeploySource, DeployResult } from "../provisioners/deployProvisioner.js";

/**
 * Whether to find-or-create a deploy app (`provision`) or link an already-discovered
 * one (`bind`) — the same greenfield/brownfield split the IntegrationProvisioner
 * draws. `bind` carries the provider-side resource id to link.
 */
export type ProvisionOrBindInput = { mode: "provision" } | { mode: "bind"; existingResourceId: string };

/**
 * The non-secret outcome of `verify`: whether the deployment reached a live, READY
 * state AND its resolved URL answered an HTTP smoke check. `state` is the provider's
 * final reported state; `url` is the concrete resolved live URL (no placeholder);
 * `pollCount` is how many status polls verify took (observability, not a gate);
 * `smokeStatus` is the HTTP status the URL probe saw (undefined when verify failed
 * before the smoke step). A non-ready deployment yields `ready: false` AND throws
 * from `verify` — this struct is the SUCCESS shape; failure is a LOUD throw.
 */
export interface DeployVerification {
  /** The deployment reached READY and its URL passed the HTTP smoke check. */
  ready: boolean;
  /** The provider's final reported state (e.g. "READY" | "started"). */
  state: string;
  /** The resolved live URL the deployment is reachable at (concrete, no placeholder). */
  url: string;
  /** How many status polls verify issued before the terminal (observability). */
  pollCount: number;
  /** The HTTP status the URL smoke probe observed (the deployment answered). */
  smokeStatus: number;
}

/** A previously-triggered deployment's provider-reported status (the `status` read). */
export interface DeployStatus {
  /** The provider's reported state (e.g. "BUILDING" | "READY" | "started"). */
  state: string;
  /** Whether that state is a live/ready terminal. */
  ready: boolean;
  /** Whether that state is a failure terminal. */
  failed: boolean;
  /** The resolved live URL the deployment is reachable at. */
  url: string;
}

/**
 * The deploy reference a verify/status/deploy call targets: the provider kind + the
 * deployed app id (the `deployRef` captured at provision time). Mirrors the shape
 * `attachRuntimeAppEnv` / `deployOnMerge` already pass around. NON-SECRET.
 */
export interface DeployRef {
  /** The deploy provider kind (`deploy.vercel` | `deploy.flyio`). */
  provider: string;
  /** The deployed app/project id (the deployRef's appId). */
  appId: string;
}

/**
 * The EXERCISE SURFACE a demo runs its behavior checks against — the design doc's
 * "demos are first-class behavior evidence tied to the spec's behaviors, NOT to the
 * provider" made concrete. The surface is how the demo engine REACHES the deployed
 * product to prove a behavior; it is deliberately a tagged union so the demo engine
 * stays provider-AGNOSTIC: a `direct_api` (Vercel/Fly) deploy resolves to a live
 * `web_url`, but a `package_release` would resolve to an installable package, a
 * `mobile_release` to an app-store channel, a `manual_external` to a download — and
 * the demo engine exercises whatever surface it is handed. New surface kinds slot in
 * as new arms here (never a refactor), exactly like the DeployAdapter classes grow.
 *
 * NON-SECRET: a surface only ever carries a public reach handle (a URL, a package
 * coordinate) — never a token, never a credential ref.
 */
export type DemoSurface = {
  /** A live web endpoint the demo exercises over HTTP (the `direct_api` deploy URL). */
  kind: "web_url";
  /** The resolved live URL the deployed app serves at (concrete, no placeholder). */
  url: string;
};
// FUTURE surface arms (deferred, NOT a refactor when they land — a new union member +
// a new `demoSurface` arm on the owning adapter class):
//   | { kind: "package"; registry: string; coordinate: string }
//   | { kind: "app_channel"; platform: string; track: string }
//   | { kind: "download"; artifactUrl: string }

/**
 * The HTTP-reachability probe `verify`'s smoke step runs against the resolved URL —
 * an injectable seam (scripted in tests; a real `fetch` HEAD/GET in production) so
 * the conformance suite proves the smoke check WITHOUT a live network call. Returns
 * the observed HTTP status; a transport-level failure (DNS/connection) throws.
 */
export interface UrlReachabilityProbe {
  /** Probe `url` for reachability; resolve to the HTTP status code the server returned. */
  probe(url: string): Promise<number>;
}

/**
 * The verify poll cadence: how many times to poll the provider for a terminal state
 * and how long to wait between polls. Bounded so a deployment that never becomes
 * ready fails LOUD after `maxPolls` rather than hanging forever. `sleep` is injected
 * so tests advance instantly (no real timers).
 */
export interface VerifyPollPolicy {
  /** The maximum status polls before verify gives up and throws (never-ready guard). */
  maxPolls: number;
  /** Milliseconds to wait between polls (production cadence; tests inject a no-op sleep). */
  intervalMs: number;
  /** The wait primitive between polls (injected; a real `setTimeout` in production). */
  sleep(ms: number): Promise<void>;
}

/**
 * The DeployAdapter port. `provisionOrBind` yields the project deploy artifact (the
 * deployRef + config + token alias ref); `deploy` triggers a build+release of the
 * merged source; `verify` POLLS to READY + SMOKE-CHECKS the URL (the proven-deploy
 * capability); `status` reads a deployment's current state without polling. A new
 * adapter CLASS (pulumi / mobile_release / …) implements this port and registers as
 * a new `buildDeployAdapter` arm — never a refactor of this contract.
 */
export interface DeployAdapter {
  /** The adapter class kind this impl speaks for (e.g. "direct_api"). */
  readonly kind: string;
  /** Find-or-create (or bind) the project's deploy app; yields the deploy artifact. */
  provisionOrBind(
    grant: OrgGrant,
    projectCtx: ProjectContext,
    input: ProvisionOrBindInput,
  ): Promise<ProvisionedArtifact>;
  /** Trigger a build + release of `source` onto the app `ref` points at (fire — verify proves it). */
  deploy(grant: OrgGrant, ref: DeployRef, source: DeploySource): Promise<DeployResult>;
  /**
   * Poll the provider until the deployment is READY (then smoke-check the URL), or
   * throw LOUD when it reaches a failure terminal / never becomes ready within the
   * poll budget / the URL smoke check fails. The success shape proves the deploy.
   */
  verify(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployVerification>;
  /** Read a triggered deployment's current provider status (one read, no polling). */
  status(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployStatus>;
  /**
   * Resolve the EXERCISE SURFACE the demo engine runs behavior checks against — the
   * seam that decouples "demo evidence" from the provider. For a `direct_api` deploy
   * this is the resolved live `web_url` (read from the deployment's status, so it is
   * the same concrete URL `verify` proved); other adapter classes resolve other
   * surface kinds. THROWS LOUD when no surface can be resolved (e.g. the provider
   * reports no URL) — a demo with no surface to exercise is never a silent skip.
   */
  demoSurface(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DemoSurface>;
}
