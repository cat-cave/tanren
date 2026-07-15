// The DeployAdapter port — the deployment seam ABOVE the IntegrationProvisioner
// (docs/roadmap/tanren-direction.md § "Native Deployment And Demos"). Where
// `IntegrationProvisioner` provisions a deploy app and `DeployProvisioner.deploy`
// fires a fire-and-forget trigger, the DeployAdapter raises that to a VERIFIED
// lifecycle: provision-or-bind, deploy (trigger), and — the load-bearing addition —
// `verify`, which POLLS the provider until the deployment is genuinely READY (or
// fails LOUD) and then SMOKE-CHECKS the resolved URL is HTTP-reachable. This makes
// "a deploy happened" PROVEN, not merely triggered.
//
// SCOPE: this port covers the full set of deploy adapter CLASSES — the apex-relevant
// `direct_api` (Vercel/Fly), plus `pulumi` (IaC stack up/refresh), `package_release`
// (publish to a package registry), `mobile_release` (submit to an app-distribution
// channel), and `manual_external` (operator-attested out-of-band delivery). It carries
// the verify capability (poll-to-ready + reachability smoke) AND — the demos-as-evidence
// addition — `demoSurface`, which resolves the EXERCISE SURFACE (a `DemoSurface`) the
// demo engine runs the spec's behavior checks against, so demo evidence is tied to the
// spec's BEHAVIORS and not to the provider: a `direct_api`/`pulumi`/`manual_external`
// (URL) deploy resolves to a `web_url`/`download`, a `package_release` to a `package`,
// a `mobile_release` to an `app_channel`. The rest of the lifecycle the direction doc
// proposes — buildArtifact / plan / applyPreview / promote / rollback / teardownPreview
// / costEstimate — is DEFERRED; each slots in as new methods on this port + new registry
// arms, exactly like the IntegrationProvisioner / Allocator seams grow.
//
// SECRET DISCIPLINE: this port never holds or returns a secret VALUE. The deploy
// token is resolved INSIDE the wrapped `DeployProvisioner` (from the org grant's
// `credentialRef` against the SecretStore) and flows only into the provider bearer.
// Every result type here is non-secret — refs, a URL, ids, a state string.

import type { OrgGrant, ProjectContext, ProvisionedArtifact } from "./integrationProvisioner.js";
import type { DeploySource, DeployResult } from "../provisioners/deployProvisioner.js";
// SP-6 binds to the frozen spine identities: the canonical artifact identity is the
// SP-3 `Digest` (sha256:<hex>); a provider-native checksum is the separately-named
// SP-3 `ProviderChecksum` (sha512) — NEVER a CAS/proof identity. A release binds the
// exact behavior revisions it delivers via SP-1's branded `BehaviorRevisionId`. These
// import from the SOLE spine modules (no re-path, no redeclaration).
import type { Digest, ProviderChecksum } from "./cas.js";
import type { BehaviorRevisionId } from "./behaviorRevision.js";

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
export type DemoSurface =
  | {
      /** A live web endpoint the demo exercises over HTTP (the `direct_api` / `pulumi` / `manual_external` URL). */
      kind: "web_url";
      /** The resolved live URL the deployed app serves at (concrete, no placeholder). */
      url: string;
    }
  | {
      /** A published package the demo installs to exercise (the `package_release` artifact). */
      kind: "package";
      /** The registry the package was published to (e.g. "npm" | "pypi" | "crates.io"). */
      registry: string;
      /** The installable coordinate within that registry (e.g. "@acme/web@1.2.3"). */
      coordinate: string;
    }
  | {
      /** An app-distribution channel the demo exercises (the `mobile_release` artifact). */
      kind: "app_channel";
      /** The mobile platform the build targets (e.g. "ios" | "android"). */
      platform: string;
      /** The distribution track the build was submitted to (e.g. "internal" | "testflight"). */
      track: string;
      /** The provider-side reference of the submitted build (e.g. the App Store Connect / Play build id). */
      buildRef: string;
    }
  | {
      /** A downloadable artifact the demo fetches (the `manual_external` out-of-band deliverable). */
      kind: "download";
      /** The resolved URL the artifact is downloadable at (concrete, no placeholder). */
      artifactUrl: string;
    };

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
 * The verify poll CADENCE: how long to wait between status polls. There is NO poll COUNT
 * and NO deadline (feedback_no_timeouts_progress_based, BINDING) — `verify` polls the
 * provider UNBOUNDED while its state ADVANCES, succeeds on a READY terminal, and fails
 * LOUD on a provider ERROR terminal or a PROVEN stuck (non-advancing) state. `intervalMs`
 * is the legitimate spacing between polls (the convergence loop's backoff), never a budget
 * that ends the loop; tests pass `0` for an instant loop with no real timers.
 */
export interface VerifyPollPolicy {
  /** Milliseconds to wait between polls (the poll cadence; tests pass 0 for an instant loop). */
  intervalMs: number;
}

// ===========================================================================
// SP-6 — the EXTENDED release lifecycle (digest / preview / promote / rollback).
// These are NOT a V2 port: they extend the SINGLE DeployAdapter contract in place
// (no V1/V2 split). Every adapter arm implements the full set. The canonical
// artifact identity is the SP-3 `Digest`; the provider-native checksum is the
// separately-named SP-3 `ProviderChecksum` (sha512), never a CAS/proof identity.
// ===========================================================================

/**
 * The lifecycle state of a persisted release instance (the `release_instances`
 * table's `state`). A release is BUILT (an artifact exists with a known digest),
 * applied to a PREVIEW/canary env, PROMOTED to production (LIVE), SUPERSEDED by a
 * newer live release, ROLLED_BACK to a prior verified artifact, or TORN_DOWN
 * (a preview reaped). FAILED is a hard terminal (the build/apply/promote errored).
 */
export type ReleaseState =
  | "built"
  | "preview"
  | "promoting"
  | "live"
  | "superseded"
  | "rolled_back"
  | "torn_down"
  | "failed";

/**
 * Which environment a release instance targets. `preview` is the pre-merge
 * preview/canary the symptom contract runs against; `production` is the promoted,
 * user-facing release. The SAME contract runs against both (pitch §"Preview and
 * production use the same contract").
 */
export type ReleaseEnvironment = "preview" | "production";

/**
 * A persisted release instance — one row of `release_instances` (migration 0036).
 * Captures the provider/app/environment, the deployment handle, the IMMUTABLE
 * source SHA, the canonical SP-3 artifact `Digest`, the separately-named provider
 * sha512 `ProviderChecksum` (nullable — not every provider reports one), the SCALAR
 * integration-node identity that produced it (no forward FK — the run model is a
 * feature bucket that shifts to 0040+), the exact behavior revisions it delivers,
 * the live URL/channel, the region, the previous verified release it supersedes
 * (self-ref), and the lifecycle `state`. NON-SECRET — refs, digests, ids, a URL.
 */
export interface ReleaseInstanceRecord {
  /** The release-instance row id (the stable handle promote/rollback/teardown key on). */
  readonly releaseInstanceId: string;
  /** The owning org (tenant scope; every query is org-scoped). */
  readonly orgId: string;
  /** The owning project. */
  readonly projectId: string;
  /** The deploy provider kind (`deploy.vercel` | `deploy.flyio` | `deploy.pulumi` | …). */
  readonly provider: string;
  /** The deployed app/project/stack/package id (the deployRef `appId`). */
  readonly appId: string;
  /** Which environment this release targets. */
  readonly environment: ReleaseEnvironment;
  /** The provider-side deployment handle (the verify/status/promote key). */
  readonly deploymentId: string;
  /** The IMMUTABLE source commit SHA the artifact was built from. */
  readonly sourceRef: string;
  /** The canonical SP-3 artifact identity (sha256:<hex>) — the release/artifact identity. */
  readonly artifactDigest: Digest;
  /** The provider-native sha512 checksum (a SEPARATE identity; NEVER a CAS/proof key), or null. */
  readonly providerChecksum: ProviderChecksum | null;
  /** The integration node that produced this release (SCALAR — no forward FK to the run model). */
  readonly integrationNodeId: string;
  /** The exact behavior revisions this release delivers (junction rows). */
  readonly behaviorRevisionIds: readonly BehaviorRevisionId[];
  /** The resolved live URL/channel the release is reachable at (concrete, no placeholder). */
  readonly url: string;
  /** The provider region the release runs in, or null when the provider is regionless. */
  readonly region: string | null;
  /** The previously-verified release this one supersedes (self-ref), or null for the first. */
  readonly previousReleaseInstanceId: string | null;
  /** The lifecycle state. */
  readonly state: ReleaseState;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/**
 * The exact artifact identity of a built/deployed release: the canonical SP-3
 * `Digest` (sha256) plus the optional provider-native sha512 `ProviderChecksum`.
 * `resolveArtifactDigest` returns this for an existing deployment; `buildArtifact`
 * embeds it in its result.
 */
export interface ArtifactIdentity {
  /** The canonical SP-3 artifact identity (sha256:<hex>). */
  readonly artifactDigest: Digest;
  /** The provider-native sha512 checksum (a separate identity), or null when unreported. */
  readonly providerChecksum: ProviderChecksum | null;
}

/**
 * The outcome of `buildArtifact`: the exact artifact identity produced from the
 * merged source, plus the provider build handle + state. This is the "return
 * artifact digest" step — the release's canonical identity is minted here and
 * flows onto `release_instances.artifact_digest`.
 */
export interface BuildArtifactResult extends ArtifactIdentity {
  /** The provider-side build/deployment handle the artifact was produced under. */
  readonly deploymentId: string;
  /** The provider's reported build state at return (e.g. "built" | "READY"). */
  readonly state: string;
}

/** The input to `applyPreview`: the merged source + the artifact + release bindings. */
export interface ApplyPreviewInput {
  /** The merged source (repo + ref) the preview deploys. */
  readonly source: DeploySource;
  /** The canonical SP-3 artifact identity the preview must run (the exact built artifact). */
  readonly artifactDigest: Digest;
  /** The integration node this preview verifies (SCALAR identity carried onto the row). */
  readonly integrationNodeId: string;
  /** The exact behavior revisions the preview delivers (bound onto the release instance). */
  readonly behaviorRevisionIds: readonly BehaviorRevisionId[];
}

/** A live preview/canary release: the handle the symptom contract runs against, then promotes/teardown. */
export interface PreviewRelease {
  /** The provider-side preview deployment handle. */
  readonly deploymentId: string;
  /** The resolved live preview URL/channel (concrete, no placeholder). */
  readonly url: string;
  /** Always `preview` — the environment this release targets. */
  readonly environment: ReleaseEnvironment;
  /** The canonical SP-3 artifact identity the preview is running. */
  readonly artifactDigest: Digest;
  /** The lifecycle state at return (`preview`). */
  readonly state: ReleaseState;
}

/** The input to `promote`: the verified artifact + the previous live release it supersedes. */
export interface PromoteInput {
  /** The provider-side deployment handle of the verified (preview) release to promote. */
  readonly deploymentId: string;
  /** The canonical SP-3 artifact identity being promoted (the exact verified artifact). */
  readonly artifactDigest: Digest;
  /** The previous live release-instance id this promotion supersedes (self-ref), or null. */
  readonly previousReleaseInstanceId: string | null;
}

/** The input to `rollback`: the previously-verified artifact + its release-instance id to restore. */
export interface RollbackInput {
  /** The canonical SP-3 artifact identity of the known-good release to restore. */
  readonly targetArtifactDigest: Digest;
  /** The release-instance id of the known-good release being restored. */
  readonly targetReleaseInstanceId: string;
}

/**
 * The outcome of `promote` / `rollback`: the now-live production deployment handle +
 * resolved URL + the artifact it is serving + the lifecycle state (`live` after a
 * promote, `rolled_back` after a rollback). A TRAFFIC transition only — a code
 * revert is ordinary P0 work through the full merge path (pitch §"Safe rollback").
 */
export interface ReleaseTransition {
  /** The now-live production deployment handle. */
  readonly deploymentId: string;
  /** The resolved live production URL/channel (concrete, no placeholder). */
  readonly url: string;
  /** Always `production` — promote/rollback land traffic on production. */
  readonly environment: ReleaseEnvironment;
  /** The canonical SP-3 artifact identity now serving traffic. */
  readonly artifactDigest: Digest;
  /** The lifecycle state at return (`live` for promote, `rolled_back` for rollback). */
  readonly state: ReleaseState;
}

/**
 * The DeployAdapter port. `provisionOrBind` yields the project deploy artifact (the
 * deployRef + config + token alias ref); `deploy` triggers a build+release of the
 * merged source; `verify` POLLS to READY + SMOKE-CHECKS the URL (the proven-deploy
 * capability); `status` reads a deployment's current state without polling. A new
 * adapter CLASS (pulumi / mobile_release / …) implements this port and registers as
 * a new `buildDeployAdapter` arm — never a refactor of this contract.
 *
 * SP-6 EXTENDS the SAME port (no V1/V2 split) with the release lifecycle:
 * `buildArtifact` builds the exact source + mints the canonical SP-3 artifact digest;
 * `resolveArtifactDigest` reads an existing deployment's exact artifact identity;
 * `applyPreview` deploys the artifact to a preview/canary env; `promote` lands it on
 * production; `rollback` restores a previously-verified artifact; `teardownPreview`
 * reaps a preview env. Every arm implements the FULL set; an arm whose provider has
 * no preview/promote/rollback concept (a package/mobile/manual release) fails LOUD
 * with a typed capability-boundary error (the codebase's blessed "correct behavior,
 * NOT a stub" pattern) rather than silently succeeding.
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
  /**
   * BUILD the exact merged `source` into a releasable artifact and return its
   * canonical SP-3 identity (the sha256 `Digest`) + the optional provider-native
   * sha512 `ProviderChecksum`. This is the "deploy exact source, return artifact
   * digest" primitive — the minted digest is the release/artifact identity that
   * lands on `release_instances.artifact_digest`. A build failure throws LOUD.
   */
  buildArtifact(grant: OrgGrant, ref: DeployRef, source: DeploySource): Promise<BuildArtifactResult>;
  /**
   * Read the EXACT artifact identity of an existing deployment (the canonical SP-3
   * `Digest` + optional provider `ProviderChecksum`) — used to re-bind a running
   * release to its artifact for verification/promotion. Throws LOUD when the
   * provider reports no resolvable artifact identity.
   */
  resolveArtifactDigest(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<ArtifactIdentity>;
  /**
   * Deploy the exact artifact to a PREVIEW/canary environment and return the live
   * preview handle the symptom contract runs against before merge. Throws LOUD when
   * the provider has no preview/canary concept (a package/mobile/manual release).
   */
  applyPreview(grant: OrgGrant, ref: DeployRef, input: ApplyPreviewInput): Promise<PreviewRelease>;
  /**
   * PROMOTE a verified (preview) artifact to production — a TRAFFIC transition to
   * the exact verified artifact. Returns the now-live production release. Throws
   * LOUD when the provider has no promote concept.
   */
  promote(grant: OrgGrant, ref: DeployRef, input: PromoteInput): Promise<ReleaseTransition>;
  /**
   * ROLL traffic back to a previously-verified artifact — a TRAFFIC rollback only
   * (a code revert is ordinary P0 work through the merge path). Returns the restored
   * production release. Throws LOUD when the provider has no rollback concept.
   */
  rollback(grant: OrgGrant, ref: DeployRef, input: RollbackInput): Promise<ReleaseTransition>;
  /**
   * TEAR DOWN a preview/canary environment (reap its resources) once its contract
   * has run. Idempotent — a preview already gone is a successful no-op. Throws LOUD
   * when the provider has no preview concept.
   */
  teardownPreview(grant: OrgGrant, ref: DeployRef, previewId: string): Promise<void>;
}
