// The `package_release` DeployAdapter — "deploy" means PUBLISH a package artifact to
// a registry (npm / PyPI / crates.io / a private registry). Where `direct_api` releases
// a running web app, this class releases an INSTALLABLE package: provisionOrBind binds
// the package coordinate (the registry + the package name the project publishes under);
// `deploy` publishes the built artifact for the merged ref; `verify` polls the registry
// until the published version is RESOLVABLE (the registry indexed it); `status` reads
// whether a version is published; `demoSurface` resolves a `package` surface (registry +
// coordinate) the demo engine installs to exercise.
//
// The registry operations run over an INJECTABLE `PackageRegistryClient` seam (a real
// registry HTTP/CLI client in production; scripted in tests) so the conformance suite
// proves the lifecycle with NO real registry. The publish token never reaches this file
// — it is resolved from the grant's `credentialRef` and flows only into the client.
//
// LOUD-FAIL ON MISSING CONFIG: a package release REQUIRES the registry it publishes to
// (the grant's `packageRegistry`, e.g. "npm") AND the package name (the grant's
// `packageName`). When either is absent we throw a typed {@link DeployAdapterConfigError}
// — which registry/name a project publishes under cannot be inferred from the contract;
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
import type { DeployResult, DeploySource } from "../provisioners/deployProvisioner.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { DeployAdapterConfigError, DeployAdapterOperationError } from "./deployAdapterErrors.js";
import { pollUntilTerminal } from "./pollUntilTerminal.js";

/** The adapter-class kind this impl registers under. */
export const PACKAGE_RELEASE_ADAPTER_KIND = "package_release";

/** The provider kind the adapter stamps onto the deployRef. */
export const PACKAGE_RELEASE_PROVIDER_KIND = "deploy.package_release";

/** The non-secret outcome of a publish: the published version + the resolvable coordinate. */
export interface PackagePublishResult {
  /** The version that was published (e.g. "1.2.3", derived from the merged ref's package). */
  version: string;
  /** The full installable coordinate (e.g. "@acme/web@1.2.3"). */
  coordinate: string;
}

/** The registry-collapsed status of a published version (the verify poll primitive). */
export interface PackageVersionStatus {
  /** Whether the registry has INDEXED the version (it resolves to an installable artifact). */
  resolvable: boolean;
  /** The full installable coordinate the version resolves to (empty until resolvable). */
  coordinate: string;
}

/**
 * The injectable registry driver: the real impl talks the registry's publish/read API
 * (npm `publish` / a registry HTTP API) over the substrate; tests script it. The
 * registry + package name is resolved by the adapter and passed in; the publish token
 * flows in here (never logged).
 */
export interface PackageRegistryClient {
  /**
   * Publish the package built from the merged `source` ref to `registry` under
   * `packageName`. Returns the published version + the resolvable coordinate. A
   * registry rejection throws (the adapter maps it to a loud operation error).
   */
  publish(input: {
    registry: string;
    packageName: string;
    token: string;
    source: DeploySource;
  }): Promise<PackagePublishResult>;
  /**
   * Read whether `version` of `packageName` is RESOLVABLE on `registry` (the registry
   * indexed it) — the verify poll. Returns the resolvability + the coordinate.
   */
  versionStatus(input: {
    registry: string;
    packageName: string;
    token: string;
    version: string;
  }): Promise<PackageVersionStatus>;
  /** Read the registry's canonical sha256 + optional native sha512 for a published version. */
  resolveArtifactIdentity(input: {
    registry: string;
    packageName: string;
    token: string;
    version: string;
  }): Promise<{ artifactDigest: string; providerChecksum: string | null }>;
}

/** Wiring the `package_release` adapter runs over: the registry client + secrets + the poll. */
export interface PackageReleaseDeployAdapterDeps {
  /** The registry driver (publish/read over the substrate; scripted in tests). */
  registry: PackageRegistryClient;
  /** The SecretStore the grant's publish token is resolved from. */
  secrets: SecretStore;
  /** The verify poll CADENCE (the spacing between polls; no count — poll-until-resolvable). */
  poll: VerifyPollPolicy;
}

function requiredGrantField(grant: OrgGrant, key: string, hint: string): string {
  const value = grant.metadata[key];
  if (typeof value !== "string" || value === "") {
    throw new DeployAdapterConfigError(PACKAGE_RELEASE_ADAPTER_KIND, key, hint);
  }
  return value;
}

/** A version a deploymentId carries (`<packageName>@<version>` is the deployment handle). */
function versionFromDeploymentId(deploymentId: string): string {
  const at = deploymentId.lastIndexOf("@");
  return at === -1 ? deploymentId : deploymentId.slice(at + 1);
}

/**
 * The `package_release` DeployAdapter. `provisionOrBind` binds the package coordinate;
 * `deploy` publishes to the registry; `verify` polls until the version resolves;
 * `demoSurface` resolves a `package` surface. The deployRef `appId` carries the
 * package name; the deploymentId is the full coordinate (`<name>@<version>`).
 */
export class PackageReleaseDeployAdapter implements DeployAdapter {
  readonly kind = PACKAGE_RELEASE_ADAPTER_KIND;

  constructor(private readonly deps: PackageReleaseDeployAdapterDeps) {}

  private registryName(grant: OrgGrant): string {
    return requiredGrantField(
      grant,
      "packageRegistry",
      "set the package registry the project publishes to (e.g. 'npm' | 'pypi' | 'crates.io' | a private registry URL) on the org grant metadata",
    );
  }

  private packageName(grant: OrgGrant): string {
    return requiredGrantField(
      grant,
      "packageName",
      "set the package name the project publishes under (e.g. '@acme/web') on the org grant metadata",
    );
  }

  private async token(grant: OrgGrant): Promise<string> {
    const secret = await this.deps.secrets.get(grant.eligibleOperation.credentialRef);
    if (secret === undefined) {
      throw new DeployAdapterConfigError(
        PACKAGE_RELEASE_ADAPTER_KIND,
        "credentialRef",
        `the org grant credentialRef '${grant.eligibleOperation.credentialRef}' is not present in the secret store (the registry publish token)`,
      );
    }
    return secret.value;
  }

  async provisionOrBind(
    grant: OrgGrant,
    _projectCtx: ProjectContext,
    input: ProvisionOrBindInput,
  ): Promise<ProvisionedArtifact> {
    const registry = this.registryName(grant);
    // bind links an already-discovered package coordinate; provision binds the
    // grant-declared package name. There is no registry-side "create" — a package
    // coordinate is a name reservation the first publish establishes — so both modes
    // resolve to binding the coordinate the project releases under.
    const packageName = input.mode === "bind" ? input.existingResourceId : this.packageName(grant);
    return {
      deployRef: { provider: PACKAGE_RELEASE_PROVIDER_KIND, appId: packageName },
      projectConfig: {
        deployProvider: PACKAGE_RELEASE_PROVIDER_KIND,
        deployAppId: packageName,
        packageRegistry: registry,
        packageName,
      },
    };
  }

  async deploy(grant: OrgGrant, ref: DeployRef, source: DeploySource): Promise<DeployResult> {
    const registry = this.registryName(grant);
    const token = await this.token(grant);
    const result = await this.deps.registry.publish({ registry, packageName: ref.appId, token, source });
    // The "url" of a package deploy is its installable coordinate (the package surface's
    // reach handle); the deploymentId is the coordinate the verify poll keys on.
    return { deploymentId: result.coordinate, url: result.coordinate, state: "published" };
  }

  async buildArtifact(grant: OrgGrant, ref: DeployRef, source: DeploySource): Promise<BuildArtifactResult> {
    const deployed = await this.deploy(grant, ref, source);
    const identity = await this.resolveArtifactDigest(grant, ref, deployed.deploymentId);
    return { ...identity, deploymentId: deployed.deploymentId, state: "built" };
  }

  async resolveArtifactDigest(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<ArtifactIdentity> {
    const registry = this.registryName(grant);
    const token = await this.token(grant);
    const identity = await this.deps.registry.resolveArtifactIdentity({
      registry,
      packageName: ref.appId,
      token,
      version: versionFromDeploymentId(deploymentId),
    });
    return {
      artifactDigest: parseDigest(identity.artifactDigest),
      providerChecksum: identity.providerChecksum === null ? null : parseProviderChecksum(identity.providerChecksum),
    };
  }

  async applyPreview(_grant: OrgGrant, _ref: DeployRef, _input: ApplyPreviewInput): Promise<PreviewRelease> {
    // A package registry has no environment or traffic surface to preview.
    throw new DeployAdapterOperationError(
      PACKAGE_RELEASE_ADAPTER_KIND,
      "applyPreview is not a capability of the package_release adapter class — a package release has no preview/promote/rollback/teardown surface",
    );
  }

  async promote(_grant: OrgGrant, _ref: DeployRef, _input: PromoteInput): Promise<ReleaseTransition> {
    // A package registry has no environment or traffic surface to promote.
    throw new DeployAdapterOperationError(
      PACKAGE_RELEASE_ADAPTER_KIND,
      "promote is not a capability of the package_release adapter class — a package release has no preview/promote/rollback/teardown surface",
    );
  }

  async rollback(_grant: OrgGrant, _ref: DeployRef, _input: RollbackInput): Promise<ReleaseTransition> {
    // A package registry has no environment or traffic surface to roll back.
    throw new DeployAdapterOperationError(
      PACKAGE_RELEASE_ADAPTER_KIND,
      "rollback is not a capability of the package_release adapter class — a package release has no preview/promote/rollback/teardown surface",
    );
  }

  async teardownPreview(_grant: OrgGrant, _ref: DeployRef, _previewId: string): Promise<void> {
    // A package registry has no environment or traffic surface to tear down.
    throw new DeployAdapterOperationError(
      PACKAGE_RELEASE_ADAPTER_KIND,
      "teardownPreview is not a capability of the package_release adapter class — a package release has no preview/promote/rollback/teardown surface",
    );
  }

  async status(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployStatus> {
    const read = await this.read(grant, ref, deploymentId);
    return {
      state: read.resolvable ? "resolvable" : "pending",
      ready: read.resolvable,
      failed: false,
      url: read.coordinate,
    };
  }

  async demoSurface(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DemoSurface> {
    const registry = this.registryName(grant);
    const read = await this.read(grant, ref, deploymentId);
    if (read.coordinate === "") {
      throw new DeployAdapterOperationError(
        PACKAGE_RELEASE_ADAPTER_KIND,
        `package '${ref.appId}' deployment '${deploymentId}' is not resolvable on '${registry}' — no package surface to exercise`,
      );
    }
    return { kind: "package", registry, coordinate: read.coordinate };
  }

  async verify(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployVerification> {
    // A registry has no FAILURE terminal — a version is either RESOLVABLE (the registry
    // indexed it) or simply not-yet-resolvable (pending). So the poll succeeds on resolvable
    // and escalates LOUD only when the version is a PROVEN stuck non-terminal (never indexed,
    // no advancement) — never "failed after N polls".
    const { poll, pollCount } = await pollUntilTerminal({
      readState: async () => {
        const read = await this.read(grant, ref, deploymentId);
        return {
          state: read.resolvable ? "resolvable" : "pending",
          ready: read.resolvable,
          failed: false,
          coordinate: read.coordinate,
        };
      },
      onFailureTerminal: (state) =>
        new DeployAdapterOperationError(
          PACKAGE_RELEASE_ADAPTER_KIND,
          `package '${ref.appId}' version '${versionFromDeploymentId(deploymentId)}' reached a FAILURE state '${state}'`,
        ),
      onStuck: (_stuckState, polls) =>
        new DeployAdapterOperationError(
          PACKAGE_RELEASE_ADAPTER_KIND,
          `package '${ref.appId}' version '${versionFromDeploymentId(deploymentId)}' is STUCK unresolvable on the ` +
            `registry with no advancement after ${String(polls)} polls`,
        ),
      intervalMs: this.deps.poll.intervalMs,
    });
    // A package release is PROVEN once the registry resolves the version (the "smoke check"
    // is registry-resolution, not an HTTP probe — there is no live URL to GET). The
    // coordinate is the surface's reach handle.
    return { ready: true, state: "resolvable", url: poll.coordinate, pollCount, smokeStatus: 200 };
  }

  private async read(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<PackageVersionStatus> {
    const registry = this.registryName(grant);
    const token = await this.token(grant);
    return this.deps.registry.versionStatus({
      registry,
      packageName: ref.appId,
      token,
      version: versionFromDeploymentId(deploymentId),
    });
  }
}
