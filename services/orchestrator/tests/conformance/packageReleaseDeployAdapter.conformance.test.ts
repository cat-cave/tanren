import { testOrgGrant } from "../helpers/orgGrant.js";
// PackageReleaseDeployAdapter conformance: provisionOrBind binds the package coordinate;
// deploy publishes to the registry; verify POLLS until the version is RESOLVABLE (failing
// LOUD on a never-resolvable budget); demoSurface resolves a `package` surface (registry +
// coordinate). Plus the loud-fail-on-missing-config behavior. Driven over the scripted
// registry client — NO real registry.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import type { DeployRef } from "../../src/engine/contracts/deployAdapter.js";
import {
  projectIntegrationOperationTarget,
  type IntegrationOperationTarget,
  type IntegrationPrivilegedOperation,
} from "../../src/engine/contracts/integrationAuthority.js";
import {
  PackageReleaseDeployAdapter,
  PACKAGE_RELEASE_PROVIDER_KIND,
} from "../../src/engine/deploy/packageReleaseDeployAdapter.js";
import { instantVerifyPollPolicy } from "./fakes/scriptedUrlProbe.js";
import { scriptedPackageRegistry } from "./fakes/scriptedDeployDrivers.js";

const TOKEN_REF = "secret://org/npm-token";
const TOKEN_VALUE = "npm_super_secret_publish_token";

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: TOKEN_REF, value: TOKEN_VALUE });
  void store.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  void store.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  return store;
}

const METADATA = { packageRegistry: "npm", packageName: "@acme/web" };

const ctx = (name: string): ProjectContext => ({
  projectId: `proj_${name}`,
  orgId: "org_1",
  orgSlug: "tanren",
  name,
});
const authorityCtx = ctx("authority");

const operationGrant = (
  operation: IntegrationPrivilegedOperation,
  target: IntegrationOperationTarget,
  metadata: Record<string, unknown> = METADATA,
  owner: ProjectContext = authorityCtx,
) =>
  testOrgGrant({
    providerKind: PACKAGE_RELEASE_PROVIDER_KIND,
    credentialRef: `${TOKEN_REF}/g/1`,
    metadata,
    capability: "deploy",
    operation,
    target,
    orgId: owner.orgId,
    projectId: owner.projectId,
  });

function adapter(registry = scriptedPackageRegistry()) {
  const instance = new PackageReleaseDeployAdapter({
    registry,
    secrets: secrets(),
    poll: instantVerifyPollPolicy(),
  });
  return { instance, registry };
}

describe("PackageReleaseDeployAdapter — lifecycle", () => {
  it("provisionOrBind(provision) binds the grant-declared package coordinate", async () => {
    const { instance } = adapter();
    const projectCtx = ctx("acme-web");
    const artifact = await instance.provisionOrBind(
      await operationGrant("provision", projectIntegrationOperationTarget(projectCtx), METADATA, projectCtx),
      projectCtx,
      { mode: "provision" },
    );
    expect(artifact.deployRef?.provider).toBe(PACKAGE_RELEASE_PROVIDER_KIND);
    expect(artifact.deployRef?.appId).toBe("@acme/web");
    expect(artifact.projectConfig?.["packageRegistry"]).toBe("npm");
    expect(JSON.stringify(artifact)).not.toContain(TOKEN_VALUE);
  });

  it("provisionOrBind(bind) links an already-discovered package name", async () => {
    const { instance } = adapter();
    const projectCtx = ctx("x");
    const artifact = await instance.provisionOrBind(
      await operationGrant("bind", projectIntegrationOperationTarget(projectCtx, "@acme/cli"), METADATA, projectCtx),
      projectCtx,
      { mode: "bind", existingResourceId: "@acme/cli" },
    );
    expect(artifact.deployRef?.appId).toBe("@acme/cli");
  });

  it("deploy publishes to the registry and returns the installable coordinate", async () => {
    const { instance } = adapter();
    const ref: DeployRef = { provider: PACKAGE_RELEASE_PROVIDER_KIND, appId: "@acme/web" };
    const source = { repo: "acme/acme-web", ref: "deadbeef0000" };
    const result = await instance.deploy(
      await operationGrant("deploy", { resourceId: ref.appId, sourceRepo: source.repo, sourceRef: source.ref }),
      ref,
      source,
    );
    expect(result.deploymentId).toBe("@acme/web@0.0.0-deadbee");
    expect(result.url).toBe("@acme/web@0.0.0-deadbee");
    expect(result.state).toBe("published");
  });
});

describe("PackageReleaseDeployAdapter — verify + surface", () => {
  const ref: DeployRef = { provider: PACKAGE_RELEASE_PROVIDER_KIND, appId: "@acme/web" };
  const source = { repo: "acme/acme-web", ref: "deadbeef0000" };

  it("polls until the registry resolves the version then proves the release", async () => {
    const registry = scriptedPackageRegistry();
    const { instance } = adapter(registry);
    const { deploymentId } = await instance.deploy(
      await operationGrant("deploy", { resourceId: ref.appId, sourceRepo: source.repo, sourceRef: source.ref }),
      ref,
      source,
    );
    registry.scriptResolvable("0.0.0-deadbee", [false, false, true]);
    const verification = await instance.verify(
      () => operationGrant("verify", { resourceId: ref.appId, deploymentId }),
      ref,
      deploymentId,
    );
    expect(verification.ready).toBe(true);
    expect(verification.state).toBe("resolvable");
    expect(verification.url).toBe("@acme/web@0.0.0-deadbee");
    expect(verification.pollCount).toBe(3);
  });

  it("escalates LOUD as STUCK (not on a count) when the version never resolves", async () => {
    const registry = scriptedPackageRegistry();
    const { instance } = adapter(registry);
    const { deploymentId } = await instance.deploy(
      await operationGrant("deploy", { resourceId: ref.appId, sourceRepo: source.repo, sourceRef: source.ref }),
      ref,
      source,
    );
    registry.scriptResolvable("0.0.0-deadbee", [false]);
    await expect(
      instance.verify(() => operationGrant("verify", { resourceId: ref.appId, deploymentId }), ref, deploymentId),
    ).rejects.toThrow(/is STUCK unresolvable on the registry/u);
  });

  it("resolves a package demo surface (registry + coordinate)", async () => {
    const registry = scriptedPackageRegistry();
    const { instance } = adapter(registry);
    const { deploymentId } = await instance.deploy(
      await operationGrant("deploy", { resourceId: ref.appId, sourceRepo: source.repo, sourceRef: source.ref }),
      ref,
      source,
    );
    registry.scriptResolvable("0.0.0-deadbee", [true]);
    const surface = await instance.demoSurface(
      await operationGrant("resolve_demo_surface", { resourceId: ref.appId, deploymentId }),
      ref,
      deploymentId,
    );
    expect(surface).toEqual({ kind: "package", registry: "npm", coordinate: "@acme/web@0.0.0-deadbee" });
  });
});

describe("PackageReleaseDeployAdapter — loud fail on missing config", () => {
  const ref: DeployRef = { provider: PACKAGE_RELEASE_PROVIDER_KIND, appId: "@acme/web" };
  const source = { repo: "acme/acme-web", ref: "main" };

  it("throws when the registry is absent", async () => {
    const { instance } = adapter();
    const noRegistry = await operationGrant(
      "deploy",
      { resourceId: ref.appId, sourceRepo: source.repo, sourceRef: source.ref },
      { packageName: "@acme/web" },
    );
    await expect(instance.deploy(noRegistry, ref, source)).rejects.toThrow(
      /required config 'packageRegistry' is not set/u,
    );
  });

  it("throws when the package name is absent (on provision)", async () => {
    const { instance } = adapter();
    const projectCtx = ctx("x");
    const noName = await operationGrant(
      "provision",
      projectIntegrationOperationTarget(projectCtx),
      { packageRegistry: "npm" },
      projectCtx,
    );
    await expect(instance.provisionOrBind(noName, projectCtx, { mode: "provision" })).rejects.toThrow(
      /required config 'packageName' is not set/u,
    );
  });

  it("throws when the publish token ref is missing from the store", async () => {
    const instance = new PackageReleaseDeployAdapter({
      registry: scriptedPackageRegistry(),
      secrets: new InMemorySecretStore(),
      poll: instantVerifyPollPolicy(),
    });
    await expect(
      instance.deploy(
        await operationGrant("deploy", { resourceId: ref.appId, sourceRepo: source.repo, sourceRef: source.ref }),
        ref,
        source,
      ),
    ).rejects.toThrow(/missing integration secret for generation/u);
  });
});
