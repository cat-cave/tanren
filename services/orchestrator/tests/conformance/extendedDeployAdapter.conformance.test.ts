import { testOrgGrant } from "../helpers/orgGrant.js";
import { describe, expect, it } from "vitest";
import { parseDigest } from "../../src/engine/contracts/cas.js";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { DeployRef } from "../../src/engine/contracts/deployAdapter.js";
import type {
  IntegrationOperationTarget,
  IntegrationPrivilegedOperation,
} from "../../src/engine/contracts/integrationAuthority.js";

import { DirectApiDeployAdapter } from "../../src/engine/deploy/directApiDeployAdapter.js";
import {
  InMemoryManualAttestationStore,
  ManualExternalDeployAdapter,
  MANUAL_EXTERNAL_PROVIDER_KIND,
} from "../../src/engine/deploy/manualExternalDeployAdapter.js";
import {
  MobileReleaseDeployAdapter,
  MOBILE_RELEASE_PROVIDER_KIND,
} from "../../src/engine/deploy/mobileReleaseDeployAdapter.js";
import {
  PackageReleaseDeployAdapter,
  PACKAGE_RELEASE_PROVIDER_KIND,
} from "../../src/engine/deploy/packageReleaseDeployAdapter.js";
import { PulumiDeployAdapter, PULUMI_PROVIDER_KIND } from "../../src/engine/deploy/pulumiDeployAdapter.js";
import {
  scriptedMobileDistribution,
  scriptedPackageRegistry,
  scriptedPulumiRunner,
} from "./fakes/scriptedDeployDrivers.js";
import { scriptedDeployTransport } from "./fakes/scriptedDeployTransport.js";
import { instantVerifyPollPolicy, scriptedUrlProbe } from "./fakes/scriptedUrlProbe.js";

const TOKEN_REF = "secret://org/deploy-token";
const TOKEN_VALUE = "never-return-this-token";
const RAW_DIGEST = `sha256:${"e".repeat(64)}`;
const RAW_CHECKSUM = `sha512:${"f".repeat(128)}`;
const ARTIFACT_DIGEST = parseDigest(RAW_DIGEST);
const SOURCE = { repo: "acme/web", ref: "deadbeef" };

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: TOKEN_REF, value: TOKEN_VALUE });
  void store.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  void store.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  return store;
}

const previewInput = {
  source: SOURCE,
  artifactDigest: ARTIFACT_DIGEST,
  integrationNodeId: "node_1",
  behaviorRevisionIds: [],
};

const stageGrant = (
  providerKind: string,
  metadata: Record<string, unknown>,
  operation: IntegrationPrivilegedOperation,
  target: IntegrationOperationTarget,
) =>
  testOrgGrant({
    orgId: "org_1",
    projectId: "project_1",
    providerKind,
    credentialRef: `${TOKEN_REF}/g/1`,
    metadata,
    capability: "deploy",
    operation,
    target,
  });

async function buildAuthority(
  providerKind: string,
  metadata: Record<string, unknown>,
  ref: DeployRef,
  source: typeof SOURCE,
) {
  return {
    deploy: await stageGrant(providerKind, metadata, "deploy", {
      resourceId: ref.appId,
      sourceRepo: source.repo,
      sourceRef: source.ref,
    }),
    resolveArtifactIdentity: (deploymentId: string) =>
      stageGrant(providerKind, metadata, "resolve_artifact_identity", {
        resourceId: ref.appId,
        deploymentId,
      }),
  };
}

describe("Extended DeployAdapter lifecycle", () => {
  it("builds, previews, promotes, rolls back, and idempotently tears down a direct_api release", async () => {
    const transport = scriptedDeployTransport("vercel", ["acme-web"]);
    const adapter = new DirectApiDeployAdapter({
      provisioner: { transport, secrets: secrets() },
      urlProbe: scriptedUrlProbe(),
      poll: instantVerifyPollPolicy(),
    });
    const metadata = { teamId: "team_1" };
    const ref: DeployRef = { provider: "deploy.vercel", appId: "vercel_app_1" };

    const built = await adapter.buildArtifact(
      await buildAuthority("deploy.vercel", metadata, ref, SOURCE),
      ref,
      SOURCE,
    );
    expect(built).toMatchObject({ state: "built", artifactDigest: expect.stringMatching(/^sha256:/u) });
    expect(built.providerChecksum).toMatch(/^sha512:/u);

    const preview = await adapter.applyPreview(
      await stageGrant("deploy.vercel", metadata, "deploy", {
        resourceId: ref.appId,
        sourceRepo: previewInput.source.repo,
        sourceRef: previewInput.source.ref,
      }),
      ref,
      previewInput,
    );
    expect(preview).toMatchObject({ environment: "preview", state: "preview", artifactDigest: ARTIFACT_DIGEST });
    const promoted = await adapter.promote(
      await stageGrant("deploy.vercel", metadata, "promote", {
        resourceId: ref.appId,
        deploymentId: preview.deploymentId,
      }),
      ref,
      {
        deploymentId: preview.deploymentId,
        artifactDigest: ARTIFACT_DIGEST,
        previousReleaseInstanceId: null,
      },
    );
    expect(promoted).toMatchObject({ environment: "production", state: "live" });
    const rolledBack = await adapter.rollback(
      await stageGrant("deploy.vercel", metadata, "rollback", {
        resourceId: ref.appId,
        deploymentId: built.deploymentId,
      }),
      ref,
      {
        targetArtifactDigest: built.artifactDigest,
        targetReleaseInstanceId: built.deploymentId,
      },
    );
    expect(rolledBack).toMatchObject({ environment: "production", state: "rolled_back" });
    await adapter.teardownPreview(
      await stageGrant("deploy.vercel", metadata, "teardown_deployment", {
        resourceId: ref.appId,
        deploymentId: preview.deploymentId,
      }),
      ref,
      preview.deploymentId,
    );
    await adapter.teardownPreview(
      await stageGrant("deploy.vercel", metadata, "teardown_deployment", {
        resourceId: ref.appId,
        deploymentId: preview.deploymentId,
      }),
      ref,
      preview.deploymentId,
    );
    expect(JSON.stringify({ built, preview, promoted, rolledBack })).not.toContain(TOKEN_VALUE);
  });

  it("requires distinct resolve-artifact authority after deploy and blocks identity provider I/O otherwise", async () => {
    const transport = scriptedDeployTransport("vercel", ["acme-web"]);
    const adapter = new DirectApiDeployAdapter({
      provisioner: { transport, secrets: secrets() },
      urlProbe: scriptedUrlProbe(),
      poll: instantVerifyPollPolicy(),
    });
    const ref: DeployRef = { provider: "deploy.vercel", appId: "vercel_app_1" };
    const deploy = await stageGrant("deploy.vercel", { teamId: "team_1" }, "deploy", {
      resourceId: ref.appId,
      sourceRepo: SOURCE.repo,
      sourceRef: SOURCE.ref,
    });

    await expect(
      adapter.buildArtifact({ deploy, resolveArtifactIdentity: async () => deploy }, ref, SOURCE),
    ).rejects.toThrow(/binding mismatch/u);
    expect(transport.statusPolls("vercel_deploy_1")).toBe(0);
  });

  it("reads Fly's immutable image digest and transitions traffic by releasing that image", async () => {
    const transport = scriptedDeployTransport("fly", ["acme-fly"]);
    const adapter = new DirectApiDeployAdapter({
      provisioner: { transport, secrets: secrets(), allowFlyStaticDeploy: true },
      urlProbe: scriptedUrlProbe(),
      poll: instantVerifyPollPolicy(),
    });
    const metadata = { orgSlug: "acme", image: "registry.fly.io/acme-fly:latest" };
    const ref: DeployRef = { provider: "deploy.flyio", appId: "fly_app_1" };

    const built = await adapter.buildArtifact(await buildAuthority("deploy.flyio", metadata, ref, SOURCE), ref, SOURCE);
    expect(built).toMatchObject({ state: "built", providerChecksum: null });
    expect(built.artifactDigest).toMatch(/^sha256:/u);
    const preview = await adapter.applyPreview(
      await stageGrant("deploy.flyio", metadata, "deploy", {
        resourceId: ref.appId,
        sourceRepo: previewInput.source.repo,
        sourceRef: previewInput.source.ref,
      }),
      ref,
      previewInput,
    );
    const promoted = await adapter.promote(
      await stageGrant("deploy.flyio", metadata, "promote", {
        resourceId: ref.appId,
        deploymentId: preview.deploymentId,
      }),
      ref,
      {
        deploymentId: preview.deploymentId,
        artifactDigest: built.artifactDigest,
        previousReleaseInstanceId: null,
      },
    );
    const rolledBack = await adapter.rollback(
      await stageGrant("deploy.flyio", metadata, "rollback", {
        resourceId: ref.appId,
        deploymentId: built.deploymentId,
      }),
      ref,
      {
        targetArtifactDigest: built.artifactDigest,
        targetReleaseInstanceId: built.deploymentId,
      },
    );
    await adapter.teardownPreview(
      await stageGrant("deploy.flyio", metadata, "teardown_deployment", {
        resourceId: ref.appId,
        deploymentId: preview.deploymentId,
      }),
      ref,
      preview.deploymentId,
    );

    expect(promoted).toMatchObject({ state: "live", url: "https://acme-fly.fly.dev" });
    expect(rolledBack).toMatchObject({ state: "rolled_back", artifactDigest: built.artifactDigest });
  });

  it("wires the complete Pulumi release lifecycle through its existing runner seam", async () => {
    const adapter = new PulumiDeployAdapter({
      runner: scriptedPulumiRunner(),
      secrets: secrets(),
      urlProbe: scriptedUrlProbe(),
      poll: instantVerifyPollPolicy(),
    });
    const metadata = { pulumiBackend: "https://api.pulumi.com", pulumiProject: "acme" };
    const ref: DeployRef = { provider: PULUMI_PROVIDER_KIND, appId: "web" };

    const built = await adapter.buildArtifact(
      await buildAuthority(PULUMI_PROVIDER_KIND, metadata, ref, SOURCE),
      ref,
      SOURCE,
    );
    const preview = await adapter.applyPreview(
      await stageGrant(PULUMI_PROVIDER_KIND, metadata, "deploy", {
        resourceId: ref.appId,
        sourceRepo: previewInput.source.repo,
        sourceRef: previewInput.source.ref,
      }),
      ref,
      previewInput,
    );
    const promoted = await adapter.promote(
      await stageGrant(PULUMI_PROVIDER_KIND, metadata, "promote", {
        resourceId: ref.appId,
        deploymentId: preview.deploymentId,
      }),
      ref,
      {
        deploymentId: preview.deploymentId,
        artifactDigest: built.artifactDigest,
        previousReleaseInstanceId: null,
      },
    );
    const rolledBack = await adapter.rollback(
      await stageGrant(PULUMI_PROVIDER_KIND, metadata, "rollback", {
        resourceId: ref.appId,
        deploymentId: "release_1",
      }),
      ref,
      {
        targetArtifactDigest: built.artifactDigest,
        targetReleaseInstanceId: "release_1",
      },
    );
    await adapter.teardownPreview(
      await stageGrant(PULUMI_PROVIDER_KIND, metadata, "teardown_deployment", {
        resourceId: ref.appId,
        deploymentId: preview.deploymentId,
      }),
      ref,
      preview.deploymentId,
    );

    expect(built.state).toBe("built");
    expect(preview.state).toBe("preview");
    expect(promoted.state).toBe("live");
    expect(rolledBack.state).toBe("rolled_back");
  });

  it("builds package and mobile artifacts but rejects environment traffic operations", async () => {
    const packageAdapter = new PackageReleaseDeployAdapter({
      registry: scriptedPackageRegistry(),
      secrets: secrets(),
      poll: instantVerifyPollPolicy(),
    });
    const packageMetadata = { packageRegistry: "npm", packageName: "@acme/web" };
    const packageRef: DeployRef = { provider: PACKAGE_RELEASE_PROVIDER_KIND, appId: "@acme/web" };
    const packageBuild = await packageAdapter.buildArtifact(
      await buildAuthority(PACKAGE_RELEASE_PROVIDER_KIND, packageMetadata, packageRef, SOURCE),
      packageRef,
      SOURCE,
    );
    expect(packageBuild.providerChecksum).toMatch(/^sha512:/u);
    await expect(
      packageAdapter.applyPreview(
        await stageGrant(PACKAGE_RELEASE_PROVIDER_KIND, packageMetadata, "deploy", {
          resourceId: packageRef.appId,
          sourceRepo: previewInput.source.repo,
          sourceRef: previewInput.source.ref,
        }),
        packageRef,
        previewInput,
      ),
    ).rejects.toMatchObject({ name: "DeployAdapterOperationError", kind: "package_release" });

    const mobileAdapter = new MobileReleaseDeployAdapter({
      distribution: scriptedMobileDistribution(),
      secrets: secrets(),
      poll: instantVerifyPollPolicy(),
    });
    const mobileMetadata = {
      mobilePlatform: "ios",
      mobileTrack: "testflight",
      mobileBundleId: "com.acme.web",
    };
    const mobileRef: DeployRef = { provider: MOBILE_RELEASE_PROVIDER_KIND, appId: "com.acme.web" };
    const mobileBuild = await mobileAdapter.buildArtifact(
      await buildAuthority(MOBILE_RELEASE_PROVIDER_KIND, mobileMetadata, mobileRef, SOURCE),
      mobileRef,
      SOURCE,
    );
    expect(mobileBuild.artifactDigest).toMatch(/^sha256:/u);
    await expect(
      mobileAdapter.teardownPreview(
        await stageGrant(MOBILE_RELEASE_PROVIDER_KIND, mobileMetadata, "teardown_deployment", {
          resourceId: mobileRef.appId,
          deploymentId: "build_1",
        }),
        mobileRef,
        "build_1",
      ),
    ).rejects.toMatchObject({ name: "DeployAdapterOperationError", kind: "mobile_release" });
  });

  it("validates the operator-declared manual artifact identity, and fails loudly when it is absent", async () => {
    const store = new InMemoryManualAttestationStore();
    const adapter = new ManualExternalDeployAdapter({
      attestations: store,
      urlProbe: scriptedUrlProbe(),
      poll: instantVerifyPollPolicy(),
      ownerScope: { orgId: "org_1", projectId: "project_1" },
    });
    const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "manual-app" };
    const metadata = {
      manualExternalUrl: "https://example.com/download",
      manualExternalArtifactDigest: RAW_DIGEST,
      manualExternalProviderChecksum: RAW_CHECKSUM,
    };

    const built = await adapter.buildArtifact(
      await buildAuthority(MANUAL_EXTERNAL_PROVIDER_KIND, metadata, ref, SOURCE),
      ref,
      SOURCE,
    );
    expect(
      await adapter.resolveArtifactDigest(
        await stageGrant(MANUAL_EXTERNAL_PROVIDER_KIND, metadata, "resolve_artifact_identity", {
          resourceId: ref.appId,
          deploymentId: built.deploymentId,
        }),
        ref,
        built.deploymentId,
      ),
    ).toEqual({ artifactDigest: RAW_DIGEST, providerChecksum: RAW_CHECKSUM });
    // The artifact identity is OPERATOR-DECLARED on the grant metadata (not persisted on
    // the attestation row) — the durable manual_deploy_attestations table (migration 0031)
    // is unchanged, keeping SP-6's sole schema owner as migration 0036.

    const missingSource = { ...SOURCE, ref: "missing" };
    const missing = await buildAuthority(
      MANUAL_EXTERNAL_PROVIDER_KIND,
      { manualExternalUrl: "https://example.com/download" },
      ref,
      missingSource,
    );
    await expect(adapter.buildArtifact(missing, ref, missingSource)).rejects.toMatchObject({
      name: "DeployAdapterOperationError",
      kind: "manual_external",
    });
    await expect(
      adapter.promote(
        await stageGrant(MANUAL_EXTERNAL_PROVIDER_KIND, metadata, "promote", {
          resourceId: ref.appId,
          deploymentId: built.deploymentId,
        }),
        ref,
        {
          deploymentId: built.deploymentId,
          artifactDigest: built.artifactDigest,
          previousReleaseInstanceId: null,
        },
      ),
    ).rejects.toMatchObject({ name: "DeployAdapterOperationError", kind: "manual_external" });
  });
});
