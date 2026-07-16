import { testOrgGrant } from "../helpers/orgGrant.js";
// MobileReleaseDeployAdapter conformance: provisionOrBind binds the distribution
// identity; deploy submits the build; verify POLLS until the build is AVAILABLE on the
// track (failing LOUD on a REJECTED terminal / a never-available budget); demoSurface
// resolves an `app_channel` surface (platform + track + build ref). Plus the loud-fail-
// on-missing-config behavior. Driven over the scripted distribution channel — NO real channel.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import type { DeployRef } from "../../src/engine/contracts/deployAdapter.js";
import {
  MobileReleaseDeployAdapter,
  MOBILE_RELEASE_PROVIDER_KIND,
} from "../../src/engine/deploy/mobileReleaseDeployAdapter.js";
import { instantVerifyPollPolicy } from "./fakes/scriptedUrlProbe.js";
import { scriptedMobileDistribution } from "./fakes/scriptedDeployDrivers.js";

const TOKEN_REF = "secret://org/appstore-key";
const TOKEN_VALUE = "asc_super_secret_api_key";

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: TOKEN_REF, value: TOKEN_VALUE });
  void store.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  void store.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  return store;
}

const grant = testOrgGrant({
  providerKind: MOBILE_RELEASE_PROVIDER_KIND,
  credentialRef: `${TOKEN_REF}/g/1`,
  metadata: { mobilePlatform: "ios", mobileTrack: "testflight", mobileBundleId: "com.acme.web" },
  capability: "deploy",
});

const ctx = (name: string): ProjectContext => ({
  projectId: `proj_${name}`,
  orgId: "org_1",
  orgSlug: "tanren",
  name,
});

function adapter(distribution = scriptedMobileDistribution()) {
  const instance = new MobileReleaseDeployAdapter({
    distribution,
    secrets: secrets(),
    poll: instantVerifyPollPolicy(),
  });
  return { instance, distribution };
}

describe("MobileReleaseDeployAdapter — lifecycle", () => {
  it("provisionOrBind(provision) binds the grant-declared distribution identity", async () => {
    const { instance } = adapter();
    const artifact = await instance.provisionOrBind(grant, ctx("acme-web"), { mode: "provision" });
    expect(artifact.deployRef?.provider).toBe(MOBILE_RELEASE_PROVIDER_KIND);
    expect(artifact.deployRef?.appId).toBe("com.acme.web");
    expect(artifact.projectConfig?.["mobileTrack"]).toBe("testflight");
    expect(JSON.stringify(artifact)).not.toContain(TOKEN_VALUE);
  });

  it("deploy submits the build and returns the channel-side build reference", async () => {
    const { instance } = adapter();
    const ref: DeployRef = { provider: MOBILE_RELEASE_PROVIDER_KIND, appId: "com.acme.web" };
    const result = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "deadbeef" });
    expect(result.deploymentId).toMatch(/^build_/u);
    expect(result.state).toBe("processing");
  });
});

describe("MobileReleaseDeployAdapter — verify + surface", () => {
  const ref: DeployRef = { provider: MOBILE_RELEASE_PROVIDER_KIND, appId: "com.acme.web" };

  it("polls through processing→available then proves the release", async () => {
    const distribution = scriptedMobileDistribution();
    const { instance } = adapter(distribution);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "main" });
    distribution.scriptStates(deploymentId, ["processing", "processing", "available"]);
    const verification = await instance.verify(grant, ref, deploymentId);
    expect(verification.ready).toBe(true);
    expect(verification.state).toBe("available");
    expect(verification.url).toBe(deploymentId);
    expect(verification.pollCount).toBe(3);
  });

  it("fails LOUD when the submission is REJECTED", async () => {
    const distribution = scriptedMobileDistribution();
    const { instance } = adapter(distribution);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "main" });
    distribution.scriptStates(deploymentId, ["processing", "rejected"]);
    await expect(instance.verify(grant, ref, deploymentId)).rejects.toThrow(/was REJECTED by the channel/u);
  });

  it("keeps polling UNBOUNDED while the state advances — becomes AVAILABLE past the old cap", async () => {
    const distribution = scriptedMobileDistribution();
    const { instance } = adapter(distribution);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "main" });
    // A slow review: 20 distinct advancing states (past the old maxPolls=10), then available.
    const advancing = Array.from({ length: 20 }, (_v, i) => `in_review_${String(i)}`);
    distribution.scriptStates(deploymentId, [...advancing, "available"]);
    const verification = await instance.verify(grant, ref, deploymentId);
    expect(verification.ready).toBe(true);
    expect(verification.state).toBe("available");
    expect(verification.pollCount).toBe(21);
  });

  it("escalates LOUD as STUCK (not on a count) when the state never advances", async () => {
    const distribution = scriptedMobileDistribution();
    const { instance } = adapter(distribution);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "main" });
    distribution.scriptStates(deploymentId, ["processing"]);
    await expect(instance.verify(grant, ref, deploymentId)).rejects.toThrow(
      /is STUCK in non-terminal state 'processing'/u,
    );
  });

  it("resolves an app_channel demo surface (platform + track + build ref)", async () => {
    const distribution = scriptedMobileDistribution();
    const { instance } = adapter(distribution);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "main" });
    distribution.scriptStates(deploymentId, ["available"]);
    const surface = await instance.demoSurface(grant, ref, deploymentId);
    expect(surface).toEqual({ kind: "app_channel", platform: "ios", track: "testflight", buildRef: deploymentId });
  });
});

describe("MobileReleaseDeployAdapter — loud fail on missing config", () => {
  const ref: DeployRef = { provider: MOBILE_RELEASE_PROVIDER_KIND, appId: "com.acme.web" };
  const source = { repo: "acme/acme-web", ref: "main" };

  it("throws when the platform is absent", async () => {
    const { instance } = adapter();
    const grantNoPlatform = testOrgGrant({
      providerKind: grant.providerKind,
      credentialRef: grant.eligibleOperation.credentialRef,
      metadata: { mobileTrack: "testflight", mobileBundleId: "com.acme.web" },
      capability: "deploy",
    });
    await expect(instance.deploy(grantNoPlatform, ref, source)).rejects.toThrow(
      /required config 'mobilePlatform' is not set/u,
    );
  });

  it("throws when the track is absent", async () => {
    const { instance } = adapter();
    const grantNoTrack = testOrgGrant({
      providerKind: grant.providerKind,
      credentialRef: grant.eligibleOperation.credentialRef,
      metadata: { mobilePlatform: "ios", mobileBundleId: "com.acme.web" },
      capability: "deploy",
    });
    await expect(instance.deploy(grantNoTrack, ref, source)).rejects.toThrow(
      /required config 'mobileTrack' is not set/u,
    );
  });

  it("throws when the bundle id is absent (on provision)", async () => {
    const { instance } = adapter();
    const grantNoBundle = testOrgGrant({
      providerKind: grant.providerKind,
      credentialRef: grant.eligibleOperation.credentialRef,
      metadata: { mobilePlatform: "ios", mobileTrack: "testflight" },
      capability: "deploy",
    });
    await expect(instance.provisionOrBind(grantNoBundle, ctx("x"), { mode: "provision" })).rejects.toThrow(
      /required config 'mobileBundleId' is not set/u,
    );
  });

  it("throws when the channel API key ref is missing from the store", async () => {
    const instance = new MobileReleaseDeployAdapter({
      distribution: scriptedMobileDistribution(),
      secrets: new InMemorySecretStore(),
      poll: instantVerifyPollPolicy(),
    });
    await expect(instance.deploy(grant, ref, source)).rejects.toThrow(/missing integration secret for generation/u);
  });
});
