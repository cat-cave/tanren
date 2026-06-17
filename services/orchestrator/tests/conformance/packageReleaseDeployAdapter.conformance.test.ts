// PackageReleaseDeployAdapter conformance: provisionOrBind binds the package coordinate;
// deploy publishes to the registry; verify POLLS until the version is RESOLVABLE (failing
// LOUD on a never-resolvable budget); demoSurface resolves a `package` surface (registry +
// coordinate). Plus the loud-fail-on-missing-config behavior. Driven over the scripted
// registry client — NO real registry.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { OrgGrant, ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import type { DeployRef } from "../../src/engine/contracts/deployAdapter.js";
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
  return store;
}

const grant: OrgGrant = {
  providerKind: PACKAGE_RELEASE_PROVIDER_KIND,
  credentialRef: TOKEN_REF,
  metadata: { packageRegistry: "npm", packageName: "@acme/web" },
};

const ctx = (name: string): ProjectContext => ({ projectId: `proj_${name}`, orgId: "org_1", name });

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
    const artifact = await instance.provisionOrBind(grant, ctx("acme-web"), { mode: "provision" });
    expect(artifact.deployRef?.provider).toBe(PACKAGE_RELEASE_PROVIDER_KIND);
    expect(artifact.deployRef?.appId).toBe("@acme/web");
    expect(artifact.projectConfig?.["packageRegistry"]).toBe("npm");
    expect(JSON.stringify(artifact)).not.toContain(TOKEN_VALUE);
  });

  it("provisionOrBind(bind) links an already-discovered package name", async () => {
    const { instance } = adapter();
    const artifact = await instance.provisionOrBind(grant, ctx("x"), { mode: "bind", existingResourceId: "@acme/cli" });
    expect(artifact.deployRef?.appId).toBe("@acme/cli");
  });

  it("deploy publishes to the registry and returns the installable coordinate", async () => {
    const { instance } = adapter();
    const ref: DeployRef = { provider: PACKAGE_RELEASE_PROVIDER_KIND, appId: "@acme/web" };
    const result = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "deadbeef0000" });
    expect(result.deploymentId).toBe("@acme/web@0.0.0-deadbee");
    expect(result.url).toBe("@acme/web@0.0.0-deadbee");
    expect(result.state).toBe("published");
  });
});

describe("PackageReleaseDeployAdapter — verify + surface", () => {
  const ref: DeployRef = { provider: PACKAGE_RELEASE_PROVIDER_KIND, appId: "@acme/web" };

  it("polls until the registry resolves the version then proves the release", async () => {
    const registry = scriptedPackageRegistry();
    const { instance } = adapter(registry);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "deadbeef0000" });
    registry.scriptResolvable("0.0.0-deadbee", [false, false, true]);
    const verification = await instance.verify(grant, ref, deploymentId);
    expect(verification.ready).toBe(true);
    expect(verification.state).toBe("resolvable");
    expect(verification.url).toBe("@acme/web@0.0.0-deadbee");
    expect(verification.pollCount).toBe(3);
  });

  it("escalates LOUD as STUCK (not on a count) when the version never resolves", async () => {
    const registry = scriptedPackageRegistry();
    const { instance } = adapter(registry);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "deadbeef0000" });
    registry.scriptResolvable("0.0.0-deadbee", [false]);
    await expect(instance.verify(grant, ref, deploymentId)).rejects.toThrow(/is STUCK unresolvable on the registry/u);
  });

  it("resolves a package demo surface (registry + coordinate)", async () => {
    const registry = scriptedPackageRegistry();
    const { instance } = adapter(registry);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "deadbeef0000" });
    registry.scriptResolvable("0.0.0-deadbee", [true]);
    const surface = await instance.demoSurface(grant, ref, deploymentId);
    expect(surface).toEqual({ kind: "package", registry: "npm", coordinate: "@acme/web@0.0.0-deadbee" });
  });
});

describe("PackageReleaseDeployAdapter — loud fail on missing config", () => {
  const ref: DeployRef = { provider: PACKAGE_RELEASE_PROVIDER_KIND, appId: "@acme/web" };
  const source = { repo: "acme/acme-web", ref: "main" };

  it("throws when the registry is absent", async () => {
    const { instance } = adapter();
    const noRegistry: OrgGrant = { ...grant, metadata: { packageName: "@acme/web" } };
    await expect(instance.deploy(noRegistry, ref, source)).rejects.toThrow(
      /required config 'packageRegistry' is not set/u,
    );
  });

  it("throws when the package name is absent (on provision)", async () => {
    const { instance } = adapter();
    const noName: OrgGrant = { ...grant, metadata: { packageRegistry: "npm" } };
    await expect(instance.provisionOrBind(noName, ctx("x"), { mode: "provision" })).rejects.toThrow(
      /required config 'packageName' is not set/u,
    );
  });

  it("throws when the publish token ref is missing from the store", async () => {
    const instance = new PackageReleaseDeployAdapter({
      registry: scriptedPackageRegistry(),
      secrets: new InMemorySecretStore(),
      poll: instantVerifyPollPolicy(),
    });
    await expect(instance.deploy(grant, ref, source)).rejects.toThrow(/required config 'credentialRef' is not set/u);
  });
});
