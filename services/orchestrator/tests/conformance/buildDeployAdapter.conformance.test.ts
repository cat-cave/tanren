import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import { buildDeployAdapter } from "../../src/engine/deploy/buildDeployAdapter.js";
import { DIRECT_API_ADAPTER_KIND } from "../../src/engine/deploy/directApiDeployAdapter.js";
import { PulumiDeployAdapter, PULUMI_ADAPTER_KIND } from "../../src/engine/deploy/pulumiDeployAdapter.js";
import {
  PackageReleaseDeployAdapter,
  PACKAGE_RELEASE_ADAPTER_KIND,
} from "../../src/engine/deploy/packageReleaseDeployAdapter.js";
import {
  MobileReleaseDeployAdapter,
  MOBILE_RELEASE_ADAPTER_KIND,
} from "../../src/engine/deploy/mobileReleaseDeployAdapter.js";
import {
  InMemoryManualAttestationStore,
  MANUAL_EXTERNAL_ADAPTER_KIND,
} from "../../src/engine/deploy/manualExternalDeployAdapter.js";
import { scriptedDeployTransport } from "./fakes/scriptedDeployTransport.js";
import { scriptedUrlProbe, instantVerifyPollPolicy } from "./fakes/scriptedUrlProbe.js";
import {
  scriptedPulumiRunner,
  scriptedPackageRegistry,
  scriptedMobileDistribution,
} from "./fakes/scriptedDeployDrivers.js";

function secrets(): InMemorySecretStore {
  return new InMemorySecretStore();
}

describe("buildDeployAdapter (registry/factory)", () => {
  it("builds the direct_api adapter", () => {
    const built = buildDeployAdapter(DIRECT_API_ADAPTER_KIND, {
      provisioner: { transport: scriptedDeployTransport("vercel"), secrets: secrets() },
      urlProbe: scriptedUrlProbe(),
      poll: instantVerifyPollPolicy(),
    });
    expect(built.kind).toBe("direct_api");
  });

  it("fails LOUD for an unknown adapter class (never a silent default)", () => {
    expect(() =>
      buildDeployAdapter("does_not_exist", {
        provisioner: { transport: scriptedDeployTransport("vercel"), secrets: secrets() },
      }),
    ).toThrow(/adapter class 'does_not_exist' is not a registered deploy adapter/u);
  });

  it("builds manual_external only when its durable store and owner scope are wired", () => {
    const base = { transport: scriptedDeployTransport("vercel"), secrets: secrets() };
    expect(
      buildDeployAdapter(MANUAL_EXTERNAL_ADAPTER_KIND, {
        provisioner: base,
        urlProbe: scriptedUrlProbe(),
        poll: instantVerifyPollPolicy(),
        manualAttestations: new InMemoryManualAttestationStore(),
        manualOwnerScope: { orgId: "org_test", projectId: "proj_test" },
      }).kind,
    ).toBe(MANUAL_EXTERNAL_ADAPTER_KIND);
  });

  it("fails LOUD when manual_external lacks its durable store or owner scope", () => {
    const base = { transport: scriptedDeployTransport("vercel"), secrets: secrets() };
    expect(() => buildDeployAdapter(MANUAL_EXTERNAL_ADAPTER_KIND, { provisioner: base })).toThrow(
      /required config 'manualAttestations' is not set/u,
    );
    expect(() =>
      buildDeployAdapter(MANUAL_EXTERNAL_ADAPTER_KIND, {
        provisioner: base,
        manualAttestations: new InMemoryManualAttestationStore(),
      }),
    ).toThrow(/required config 'manualOwnerScope' is not set/u);
  });

  it("refuses fixture-only adapter classes with a clear diagnostic", () => {
    const base = { transport: scriptedDeployTransport("vercel"), secrets: secrets() };
    expect(() => buildDeployAdapter(PULUMI_ADAPTER_KIND, { provisioner: base })).toThrow(
      /adapter class 'pulumi' is fixture-only/u,
    );
    expect(() => buildDeployAdapter(PACKAGE_RELEASE_ADAPTER_KIND, { provisioner: base })).toThrow(
      /adapter class 'package_release' is fixture-only/u,
    );
    expect(() => buildDeployAdapter(MOBILE_RELEASE_ADAPTER_KIND, { provisioner: base })).toThrow(
      /adapter class 'mobile_release' is fixture-only/u,
    );
  });

  it("still constructs fixture-only classes directly for conformance", () => {
    const poll = instantVerifyPollPolicy();
    expect(
      new PulumiDeployAdapter({
        runner: scriptedPulumiRunner(),
        secrets: secrets(),
        urlProbe: scriptedUrlProbe(),
        poll,
      }).kind,
    ).toBe(PULUMI_ADAPTER_KIND);
    expect(
      new PackageReleaseDeployAdapter({ registry: scriptedPackageRegistry(), secrets: secrets(), poll }).kind,
    ).toBe(PACKAGE_RELEASE_ADAPTER_KIND);
    expect(
      new MobileReleaseDeployAdapter({ distribution: scriptedMobileDistribution(), secrets: secrets(), poll }).kind,
    ).toBe(MOBILE_RELEASE_ADAPTER_KIND);
  });
});
