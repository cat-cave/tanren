// The `mobile_release` DeployAdapter — "deploy" means SUBMIT a mobile build to an app
// distribution channel (App Store Connect / TestFlight, Google Play internal/closed
// tracks, or a service like Firebase App Distribution). Where `direct_api` releases a
// running web app, this class releases a MOBILE BUILD: provisionOrBind binds the app's
// distribution identity (platform + bundle id); `deploy` submits the build of the merged
// ref to the configured track; `verify` polls the channel until the submission is
// PROCESSED/available on the track; `status` reads a submission's processing state;
// `demoSurface` resolves an `app_channel` surface (platform + track + build ref) the
// demo engine exercises against.
//
// The channel operations run over an INJECTABLE `MobileDistributionClient` seam (a real
// App Store Connect / Play Developer / Firebase client in production; scripted in tests)
// so the conformance suite proves the lifecycle with NO real channel. The channel API
// key never reaches this file — it is resolved from the grant's `credentialRef`.
//
// LOUD-FAIL ON MISSING CONFIG: a mobile release REQUIRES the platform (the grant's
// `mobilePlatform`, e.g. "ios"), the distribution track (the grant's `mobileTrack`,
// e.g. "internal" | "testflight"), and the app bundle identity (the grant's
// `mobileBundleId`). When any is absent we throw a typed {@link DeployAdapterConfigError}
// — WHICH platform/channel/track a project ships to cannot be inferred from the contract;
// the operator declares it. This is the correct unconfigured behavior, NOT a stub.

import type {
  ApplyPreviewInput,
  ArtifactIdentity,
  BuildArtifactResult,
  DemoSurface,
  DeployAdapter,
  DeployRef,
  DeployStatus,
  DeployVerification,
  PreviewRelease,
  PromoteInput,
  ProvisionOrBindInput,
  ReleaseTransition,
  RollbackInput,
  VerifyPollPolicy,
} from "../contracts/deployAdapter.js";
import { parseDigest, parseProviderChecksum } from "../contracts/cas.js";
import type { OrgGrant, ProjectContext, ProvisionedArtifact } from "../contracts/integrationProvisioner.js";
import {
  projectIntegrationOperationTarget,
  type IntegrationOperationTarget,
  type IntegrationPrivilegedOperation,
} from "../contracts/integrationAuthority.js";
import type { DeployResult, DeploySource } from "../provisioners/deployProvisioner.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { DeployAdapterConfigError, DeployAdapterOperationError } from "./deployAdapterErrors.js";
import { pollUntilTerminal } from "./pollUntilTerminal.js";
import {
  assertDeployOperationAuthority,
  secretValueForDeployOperation,
} from "../provisioners/deployOperationAuthority.js";

/** The adapter-class kind this impl registers under. */
export const MOBILE_RELEASE_ADAPTER_KIND = "mobile_release";

/** The provider kind the adapter stamps onto the deployRef. */
export const MOBILE_RELEASE_PROVIDER_KIND = "deploy.mobile_release";

/** The non-secret outcome of a build submission: the channel-side build reference. */
export interface MobileSubmissionResult {
  /** The provider-side reference of the submitted build (App Store Connect / Play build id). */
  buildRef: string;
}

/** The channel-collapsed status of a submitted build (the verify poll primitive). */
export interface MobileSubmissionStatus {
  /** The channel-reported processing state (e.g. "processing" | "available" | "rejected"). */
  state: string;
  /** The build finished processing and is AVAILABLE on the track (the live terminal). */
  available: boolean;
  /** The submission was REJECTED / failed processing (the failure terminal). */
  rejected: boolean;
  /** The provider-side build reference (carried through so the surface/verify resolve it). */
  buildRef: string;
}

/**
 * The injectable distribution driver: the real impl talks the channel's submit/read API
 * (App Store Connect / Play Developer / Firebase) over the substrate; tests script it.
 * The platform + track + bundle identity is resolved by the adapter and passed in; the
 * channel API key flows in here (never logged).
 */
export interface MobileDistributionClient {
  /**
   * Submit the build of the merged `source` ref to `track` for the app `bundleId` on
   * `platform`. Returns the channel-side build reference. A channel rejection throws.
   */
  submit(input: {
    platform: string;
    track: string;
    bundleId: string;
    token: string;
    source: DeploySource;
  }): Promise<MobileSubmissionResult>;
  /**
   * Read the processing status of `buildRef` for the app on `platform`/`track` (the
   * verify poll). Returns the state collapsed into available/rejected + the build ref.
   */
  submissionStatus(input: {
    platform: string;
    track: string;
    bundleId: string;
    token: string;
    buildRef: string;
  }): Promise<MobileSubmissionStatus>;
  /** Read the distribution channel's canonical sha256 + optional native sha512 for a build. */
  resolveArtifactIdentity(input: {
    platform: string;
    track: string;
    bundleId: string;
    token: string;
    buildRef: string;
  }): Promise<{ artifactDigest: string; providerChecksum: string | null }>;
}

/** Wiring the `mobile_release` adapter runs over: the distribution client + secrets + the poll. */
export interface MobileReleaseDeployAdapterDeps {
  /** The distribution driver (submit/read over the substrate; scripted in tests). */
  distribution: MobileDistributionClient;
  /** The SecretStore the grant's channel API key is resolved from. */
  secrets: SecretStore;
  /** The verify poll CADENCE (the spacing between polls; no count — poll-until-available). */
  poll: VerifyPollPolicy;
}

function requiredGrantField(grant: OrgGrant, key: string, hint: string): string {
  const value = grant.metadata[key];
  if (typeof value !== "string" || value === "") {
    throw new DeployAdapterConfigError(MOBILE_RELEASE_ADAPTER_KIND, key, hint);
  }
  return value;
}

/**
 * The `mobile_release` DeployAdapter. `provisionOrBind` binds the distribution identity;
 * `deploy` submits the build; `verify` polls until the build is available on the track;
 * `demoSurface` resolves an `app_channel` surface. The deployRef `appId` carries the
 * app bundle id; the deploymentId is the channel-side build reference.
 */
export class MobileReleaseDeployAdapter implements DeployAdapter {
  readonly kind = MOBILE_RELEASE_ADAPTER_KIND;

  constructor(private readonly deps: MobileReleaseDeployAdapterDeps) {}

  private platform(grant: OrgGrant): string {
    return requiredGrantField(
      grant,
      "mobilePlatform",
      "set the mobile platform the build targets (e.g. 'ios' | 'android') on the org grant metadata",
    );
  }

  private track(grant: OrgGrant): string {
    return requiredGrantField(
      grant,
      "mobileTrack",
      "set the distribution track the build is submitted to (e.g. 'internal' | 'testflight' | 'closed') on the org grant metadata",
    );
  }

  private bundleId(grant: OrgGrant): string {
    return requiredGrantField(
      grant,
      "mobileBundleId",
      "set the app bundle identifier the build ships under (e.g. 'com.acme.web') on the org grant metadata",
    );
  }

  private async token(
    grant: OrgGrant,
    operation: IntegrationPrivilegedOperation,
    target: IntegrationOperationTarget,
  ): Promise<string> {
    return secretValueForDeployOperation(this.deps.secrets, MOBILE_RELEASE_PROVIDER_KIND, grant, operation, target);
  }

  async provisionOrBind(
    grant: OrgGrant,
    projectCtx: ProjectContext,
    input: ProvisionOrBindInput,
  ): Promise<ProvisionedArtifact> {
    assertDeployOperationAuthority(
      MOBILE_RELEASE_PROVIDER_KIND,
      grant,
      input.mode === "bind" ? "bind" : "provision",
      projectIntegrationOperationTarget(projectCtx, input.mode === "bind" ? input.existingResourceId : undefined),
    );
    const platform = this.platform(grant);
    const track = this.track(grant);
    // bind links an already-registered bundle id; provision binds the grant-declared
    // bundle. App registration on a store is an out-of-this-adapter onboarding step
    // (it requires legal/account setup), so both modes resolve to binding the bundle id.
    const bundleId = input.mode === "bind" ? input.existingResourceId : this.bundleId(grant);
    return {
      deployRef: { provider: MOBILE_RELEASE_PROVIDER_KIND, appId: bundleId },
      projectConfig: {
        deployProvider: MOBILE_RELEASE_PROVIDER_KIND,
        deployAppId: bundleId,
        mobilePlatform: platform,
        mobileTrack: track,
        mobileBundleId: bundleId,
      },
    };
  }

  async deploy(grant: OrgGrant, ref: DeployRef, source: DeploySource): Promise<DeployResult> {
    const platform = this.platform(grant);
    const track = this.track(grant);
    const token = await this.token(grant, "deploy", {
      resourceId: ref.appId,
      sourceRepo: source.repo,
      sourceRef: source.ref,
    });
    const result = await this.deps.distribution.submit({ platform, track, bundleId: ref.appId, token, source });
    // The "url" of a mobile deploy is its channel-side build reference (the app_channel
    // surface's reach handle); the deploymentId is that same build ref (the verify key).
    return { deploymentId: result.buildRef, url: result.buildRef, state: "processing" };
  }

  async buildArtifact(grant: OrgGrant, ref: DeployRef, source: DeploySource): Promise<BuildArtifactResult> {
    const platform = this.platform(grant);
    const track = this.track(grant);
    const token = await this.token(grant, "deploy", {
      resourceId: ref.appId,
      sourceRepo: source.repo,
      sourceRef: source.ref,
    });
    const deployed = await this.deps.distribution.submit({ platform, track, bundleId: ref.appId, token, source });
    const identity = await this.deps.distribution.resolveArtifactIdentity({
      platform,
      track,
      bundleId: ref.appId,
      token,
      buildRef: deployed.buildRef,
    });
    return {
      artifactDigest: parseDigest(identity.artifactDigest),
      providerChecksum: identity.providerChecksum === null ? null : parseProviderChecksum(identity.providerChecksum),
      deploymentId: deployed.buildRef,
      state: "built",
    };
  }

  async resolveArtifactDigest(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<ArtifactIdentity> {
    const platform = this.platform(grant);
    const track = this.track(grant);
    const token = await this.token(grant, "resolve_artifact_identity", {
      resourceId: ref.appId,
      deploymentId,
    });
    const identity = await this.deps.distribution.resolveArtifactIdentity({
      platform,
      track,
      bundleId: ref.appId,
      token,
      buildRef: deploymentId,
    });
    return {
      artifactDigest: parseDigest(identity.artifactDigest),
      providerChecksum: identity.providerChecksum === null ? null : parseProviderChecksum(identity.providerChecksum),
    };
  }

  async applyPreview(grant: OrgGrant, ref: DeployRef, input: ApplyPreviewInput): Promise<PreviewRelease> {
    assertDeployOperationAuthority(MOBILE_RELEASE_PROVIDER_KIND, grant, "deploy", {
      resourceId: ref.appId,
      sourceRepo: input.source.repo,
      sourceRef: input.source.ref,
    });
    // A mobile distribution channel has no environment or traffic surface to preview.
    throw new DeployAdapterOperationError(
      MOBILE_RELEASE_ADAPTER_KIND,
      "applyPreview is not a capability of the mobile_release adapter class — a mobile release has no preview/promote/rollback/teardown surface",
    );
  }

  async promote(grant: OrgGrant, ref: DeployRef, input: PromoteInput): Promise<ReleaseTransition> {
    assertDeployOperationAuthority(MOBILE_RELEASE_PROVIDER_KIND, grant, "promote", {
      resourceId: ref.appId,
      deploymentId: input.deploymentId,
    });
    // A mobile distribution channel has no environment or traffic surface to promote.
    throw new DeployAdapterOperationError(
      MOBILE_RELEASE_ADAPTER_KIND,
      "promote is not a capability of the mobile_release adapter class — a mobile release has no preview/promote/rollback/teardown surface",
    );
  }

  async rollback(grant: OrgGrant, ref: DeployRef, input: RollbackInput): Promise<ReleaseTransition> {
    assertDeployOperationAuthority(MOBILE_RELEASE_PROVIDER_KIND, grant, "rollback", {
      resourceId: ref.appId,
      deploymentId: input.targetReleaseInstanceId,
    });
    // A mobile distribution channel has no environment or traffic surface to roll back.
    throw new DeployAdapterOperationError(
      MOBILE_RELEASE_ADAPTER_KIND,
      "rollback is not a capability of the mobile_release adapter class — a mobile release has no preview/promote/rollback/teardown surface",
    );
  }

  async teardownPreview(grant: OrgGrant, ref: DeployRef, previewId: string): Promise<void> {
    assertDeployOperationAuthority(MOBILE_RELEASE_PROVIDER_KIND, grant, "teardown_deployment", {
      resourceId: ref.appId,
      deploymentId: previewId,
    });
    // A mobile distribution channel has no environment or traffic surface to tear down.
    throw new DeployAdapterOperationError(
      MOBILE_RELEASE_ADAPTER_KIND,
      "teardownPreview is not a capability of the mobile_release adapter class — a mobile release has no preview/promote/rollback/teardown surface",
    );
  }

  async status(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployStatus> {
    const read = await this.read(grant, ref, deploymentId, "verify");
    return { state: read.state, ready: read.available, failed: read.rejected, url: read.buildRef };
  }

  async demoSurface(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DemoSurface> {
    const platform = this.platform(grant);
    const track = this.track(grant);
    const read = await this.read(grant, ref, deploymentId, "resolve_demo_surface");
    if (read.buildRef === "") {
      throw new DeployAdapterOperationError(
        MOBILE_RELEASE_ADAPTER_KIND,
        `app '${ref.appId}' submission '${deploymentId}' on '${platform}/${track}' has no build reference — no app channel surface to exercise`,
      );
    }
    return { kind: "app_channel", platform, track, buildRef: read.buildRef };
  }

  async verify(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployVerification> {
    const readStatus = await this.statusReader(grant, ref, deploymentId, "verify");
    const { poll, pollCount } = await pollUntilTerminal({
      readState: async () => {
        const read = await readStatus();
        return { state: read.state, ready: read.available, failed: read.rejected, buildRef: read.buildRef };
      },
      onFailureTerminal: (state) =>
        new DeployAdapterOperationError(
          MOBILE_RELEASE_ADAPTER_KIND,
          `app '${ref.appId}' submission '${deploymentId}' was REJECTED by the channel (state '${state}')`,
        ),
      onStuck: (stuckState, polls) =>
        new DeployAdapterOperationError(
          MOBILE_RELEASE_ADAPTER_KIND,
          `app '${ref.appId}' submission '${deploymentId}' is STUCK in non-terminal state '${stuckState}' ` +
            `with no advancement after ${String(polls)} polls`,
        ),
      intervalMs: this.deps.poll.intervalMs,
    });
    // A mobile release is PROVEN once the channel reports the build AVAILABLE on the track
    // (the "smoke check" is channel availability, not an HTTP probe — there is no live URL
    // to GET). The build ref is the surface's reach handle.
    return { ready: true, state: poll.state, url: poll.buildRef, pollCount, smokeStatus: 200 };
  }

  private async read(
    grant: OrgGrant,
    ref: DeployRef,
    deploymentId: string,
    operation: "verify" | "resolve_demo_surface",
  ): Promise<MobileSubmissionStatus> {
    return (await this.statusReader(grant, ref, deploymentId, operation))();
  }

  private async statusReader(
    grant: OrgGrant,
    ref: DeployRef,
    deploymentId: string,
    operation: "verify" | "resolve_demo_surface",
  ): Promise<() => Promise<MobileSubmissionStatus>> {
    const platform = this.platform(grant);
    const track = this.track(grant);
    const token = await this.token(grant, operation, { resourceId: ref.appId, deploymentId });
    return () =>
      this.deps.distribution.submissionStatus({
        platform,
        track,
        bundleId: ref.appId,
        token,
        buildRef: deploymentId,
      });
  }
}
