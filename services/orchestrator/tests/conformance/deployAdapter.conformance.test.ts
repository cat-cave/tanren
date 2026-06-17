// DeployAdapter conformance (the deployment seam above IntegrationProvisioner): the
// `direct_api` adapter must DELEGATE provisionOrBind/deploy/status to the wrapped
// Vercel/Fly provisioners, and `verify` must POLL the provider to a READY terminal +
// SMOKE-CHECK the resolved URL — failing LOUD on a failure terminal, a never-ready
// budget exhaustion, or an unreachable URL. Driven entirely over the scripted in-
// memory deploy transport + a scripted URL probe — NO live Vercel/Fly/network calls.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { OrgGrant, ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import type { DeployRef } from "../../src/engine/contracts/deployAdapter.js";
import { buildDeployAdapter } from "../../src/engine/deploy/buildDeployAdapter.js";
import { DirectApiDeployAdapter, DIRECT_API_ADAPTER_KIND } from "../../src/engine/deploy/directApiDeployAdapter.js";
import { PULUMI_ADAPTER_KIND } from "../../src/engine/deploy/pulumiDeployAdapter.js";
import { PACKAGE_RELEASE_ADAPTER_KIND } from "../../src/engine/deploy/packageReleaseDeployAdapter.js";
import { MOBILE_RELEASE_ADAPTER_KIND } from "../../src/engine/deploy/mobileReleaseDeployAdapter.js";
import { MANUAL_EXTERNAL_ADAPTER_KIND } from "../../src/engine/deploy/manualExternalDeployAdapter.js";
import { scriptedDeployTransport, type ScriptedDeployTransport } from "./fakes/scriptedDeployTransport.js";
import { scriptedUrlProbe, instantVerifyPollPolicy } from "./fakes/scriptedUrlProbe.js";
import {
  scriptedPulumiRunner,
  scriptedPackageRegistry,
  scriptedMobileDistribution,
} from "./fakes/scriptedDeployDrivers.js";

const TOKEN_REF = "secret://org/deploy-token";
const TOKEN_VALUE = "fly_or_vercel_super_secret_token";

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: TOKEN_REF, value: TOKEN_VALUE });
  return store;
}

const vercelGrant: OrgGrant = {
  providerKind: "deploy.vercel",
  credentialRef: TOKEN_REF,
  metadata: { teamId: "team_abc", slug: "acme" },
};

const flyGrant: OrgGrant = {
  providerKind: "deploy.flyio",
  credentialRef: TOKEN_REF,
  metadata: { orgSlug: "acme", image: "registry.fly.io/acme-web:deployment-1" },
};

const ctx = (name: string): ProjectContext => ({ projectId: `proj_${name}`, orgId: "org_1", stack: "node", name });

// The Fly arm is NOT merge-reflecting and refuses to trigger unless the operator opts
// into the static-image semantics. These conformance tests exercise the adapter wiring
// (not the merge-reflecting property), so opt in via the injected provisioner deps.
function adapter(transport: ScriptedDeployTransport, urlStatus = 200) {
  const probe = scriptedUrlProbe(urlStatus);
  const instance = new DirectApiDeployAdapter({
    provisioner: { transport, secrets: secrets(), allowFlyStaticDeploy: true },
    urlProbe: probe,
    poll: instantVerifyPollPolicy(),
  });
  return { instance, probe };
}

describe("DirectApiDeployAdapter — delegation", () => {
  it("provisionOrBind(provision) delegates to the provisioner's find-or-create", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const artifact = await instance.provisionOrBind(vercelGrant, ctx("acme-web"), { mode: "provision" });
    expect(artifact.deployRef?.provider).toBe("deploy.vercel");
    expect(transport.appNames()).toEqual(["acme-web"]);
    expect(JSON.stringify(artifact)).not.toContain(TOKEN_VALUE);
  });

  it("provisionOrBind(bind) links an already-discovered resource", async () => {
    const transport = scriptedDeployTransport("vercel", ["existing-proj"]);
    const { instance } = adapter(transport);
    const existingId = `vercel_app_1`;
    const artifact = await instance.provisionOrBind(vercelGrant, ctx("whatever"), {
      mode: "bind",
      existingResourceId: existingId,
    });
    expect(artifact.deployRef?.appId).toBe(existingId);
    // bind never creates a second app.
    expect(transport.appNames()).toEqual(["existing-proj"]);
  });

  it("deploy TRIGGERS a build of the merged ref via the wrapped provisioner", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const artifact = await instance.provisionOrBind(vercelGrant, ctx("acme-web"), { mode: "provision" });
    const ref: DeployRef = { provider: "deploy.vercel", appId: artifact.deployRef!.appId };
    const result = await instance.deploy(vercelGrant, ref, { repo: "acme/acme-web", ref: "deadbeef" });
    const triggered = transport.deploysTriggered();
    expect(triggered).toHaveLength(1);
    // The REAL v13 github gitSource shape: org (owner) + bare repo + the commit in sha.
    expect(triggered[0]!.body["gitSource"]).toEqual({
      type: "github",
      org: "acme",
      repo: "acme-web",
      ref: "deadbeef",
      sha: "deadbeef",
    });
    expect(result.url).toMatch(/^https:\/\//u);
  });

  it("status reads a deployment's current provider state without polling", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const artifact = await instance.provisionOrBind(vercelGrant, ctx("acme-web"), { mode: "provision" });
    const appId = artifact.deployRef!.appId;
    const ref: DeployRef = { provider: "deploy.vercel", appId };
    const { deploymentId } = await instance.deploy(vercelGrant, ref, { repo: "acme/acme-web", ref: "main" });
    transport.scriptDeploymentStates(deploymentId, ["BUILDING"]);
    const status = await instance.status(vercelGrant, ref, deploymentId);
    expect(status.state).toBe("BUILDING");
    expect(status.ready).toBe(false);
    expect(status.failed).toBe(false);
    // A single read — not a poll loop.
    expect(transport.statusPolls(deploymentId)).toBe(1);
  });
});

describe("DirectApiDeployAdapter — verify (proven deploy)", () => {
  async function provisionAndDeploy(
    transport: ScriptedDeployTransport,
    instance: DirectApiDeployAdapter,
    grant: OrgGrant,
    name: string,
  ) {
    const artifact = await instance.provisionOrBind(grant, ctx(name), { mode: "provision" });
    const ref: DeployRef = { provider: grant.providerKind, appId: artifact.deployRef!.appId };
    const { deploymentId } = await instance.deploy(grant, ref, { repo: `acme/${name}`, ref: "main" });
    return { ref, deploymentId };
  }

  it("polls the provider through BUILDING→READY then smoke-checks the resolved URL", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance, probe } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(transport, instance, vercelGrant, "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["QUEUED", "BUILDING", "BUILDING", "READY"]);

    const verification = await instance.verify(vercelGrant, ref, deploymentId);

    expect(verification.ready).toBe(true);
    expect(verification.state).toBe("READY");
    expect(verification.pollCount).toBe(4);
    expect(verification.smokeStatus).toBe(200);
    expect(transport.statusPolls(deploymentId)).toBe(4);
    // The smoke probe was run against the RESOLVED deploy URL (no placeholder).
    expect(probe.probed).toHaveLength(1);
    expect(probe.probed[0]).toMatch(/^https:\/\//u);
    expect(probe.probed[0]).not.toContain("{branch}");
  });

  it("fails LOUD when the deployment reaches a FAILURE terminal", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance, probe } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(transport, instance, vercelGrant, "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["BUILDING", "ERROR"]);
    await expect(instance.verify(vercelGrant, ref, deploymentId)).rejects.toThrow(/FAILURE state 'ERROR'/u);
    // A failed deploy is never smoke-checked.
    expect(probe.probed).toEqual([]);
  });

  it("keeps polling UNBOUNDED while the state advances — succeeds well past the old poll cap", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(transport, instance, vercelGrant, "acme-web");
    // A genuinely SLOW deploy: BUILDING for 20 polls (well past the old maxPolls=10 cap),
    // each poll a fresh advancing state so the convergence loop reads PROGRESS, then READY.
    const slowButProgressing = Array.from({ length: 20 }, (_v, i) => `BUILDING-${String(i)}`);
    transport.scriptDeploymentStates(deploymentId, [...slowButProgressing, "READY"]);
    const verification = await instance.verify(vercelGrant, ref, deploymentId);
    expect(verification.ready).toBe(true);
    expect(verification.state).toBe("READY");
    // 21 polls — a count that would have FAILED under the old maxPolls=10/3 budget.
    expect(verification.pollCount).toBe(21);
    expect(transport.statusPolls(deploymentId)).toBe(21);
  });

  it("escalates LOUD as STUCK (not on a count) when the state never advances", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(transport, instance, vercelGrant, "acme-web");
    // The deployment never advances past BUILDING — a PROVEN fixed point (same state, no
    // advancement), escalated as a stuck-deploy via intelligent non-convergence, NOT a cap.
    transport.scriptDeploymentStates(deploymentId, ["BUILDING"]);
    await expect(instance.verify(vercelGrant, ref, deploymentId)).rejects.toThrow(
      /is STUCK in non-terminal state 'BUILDING'/u,
    );
  });

  it("fails LOUD when READY but the URL smoke check is unreachable", async () => {
    const transport = scriptedDeployTransport("vercel");
    // The deployed URL answers 503 (not reachable).
    const { instance } = adapter(transport, 503);
    const { ref, deploymentId } = await provisionAndDeploy(transport, instance, vercelGrant, "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["READY"]);
    await expect(instance.verify(vercelGrant, ref, deploymentId)).rejects.toThrow(
      /not reachable \(smoke check returned HTTP 503\)/u,
    );
  });

  it("Fly: polls machine state to 'started' then smoke-checks the app URL", async () => {
    const transport = scriptedDeployTransport("fly");
    const { instance, probe } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(transport, instance, flyGrant, "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["created", "starting", "started"]);
    const verification = await instance.verify(flyGrant, ref, deploymentId);
    expect(verification.ready).toBe(true);
    expect(verification.state).toBe("started");
    expect(verification.url).toBe("https://acme-web.fly.dev");
    expect(probe.probed).toEqual(["https://acme-web.fly.dev"]);
  });

  it("treats a 401 (deployment protection) as REACHABLE, not an unhealthy deploy", async () => {
    // Vercel Deployment Protection fronts a HEALTHY, running deployment with an auth
    // gate — the 401 PROVES the server is up. Verify must NOT fail-verify on it.
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport, 401);
    const { ref, deploymentId } = await provisionAndDeploy(transport, instance, vercelGrant, "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["READY"]);
    const verification = await instance.verify(vercelGrant, ref, deploymentId);
    expect(verification.ready).toBe(true);
    expect(verification.smokeStatus).toBe(401);
  });

  it("still fails LOUD on a non-protection error status (e.g. 500)", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport, 500);
    const { ref, deploymentId } = await provisionAndDeploy(transport, instance, vercelGrant, "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["READY"]);
    await expect(instance.verify(vercelGrant, ref, deploymentId)).rejects.toThrow(/not reachable .*HTTP 500/u);
  });

  it("the deploy token VALUE is never returned in a verification result", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(transport, instance, vercelGrant, "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["READY"]);
    const verification = await instance.verify(vercelGrant, ref, deploymentId);
    expect(JSON.stringify(verification)).not.toContain(TOKEN_VALUE);
  });
});

describe("DirectApiDeployAdapter — demoSurface (the demo exercise surface)", () => {
  async function provisionAndDeploy(transport: ScriptedDeployTransport, instance: DirectApiDeployAdapter) {
    const artifact = await instance.provisionOrBind(vercelGrant, ctx("acme-web"), { mode: "provision" });
    const ref: DeployRef = { provider: "deploy.vercel", appId: artifact.deployRef!.appId };
    const { deploymentId } = await instance.deploy(vercelGrant, ref, { repo: "acme/acme-web", ref: "main" });
    return { ref, deploymentId };
  }

  it("resolves the live web_url surface from the deployment status (the same resolved URL)", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(transport, instance);
    transport.scriptDeploymentStates(deploymentId, ["READY"]);
    const surface = await instance.demoSurface(vercelGrant, ref, deploymentId);
    expect(surface.kind).toBe("web_url");
    expect(surface.url).toMatch(/^https:\/\//u);
    // demoSurface is a READ — no second deploy was triggered.
    expect(transport.deploysTriggered()).toHaveLength(1);
  });

  it("never returns the deploy token VALUE in a surface", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(transport, instance);
    transport.scriptDeploymentStates(deploymentId, ["READY"]);
    const surface = await instance.demoSurface(vercelGrant, ref, deploymentId);
    expect(JSON.stringify(surface)).not.toContain(TOKEN_VALUE);
  });
});

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

  it("builds the pulumi / package_release / mobile_release / manual_external classes when wired", () => {
    const base = { transport: scriptedDeployTransport("vercel"), secrets: secrets() };
    const probe = scriptedUrlProbe();
    const poll = instantVerifyPollPolicy();
    expect(
      buildDeployAdapter(PULUMI_ADAPTER_KIND, {
        provisioner: base,
        pulumiRunner: scriptedPulumiRunner(),
        urlProbe: probe,
        poll,
      }).kind,
    ).toBe(PULUMI_ADAPTER_KIND);
    expect(
      buildDeployAdapter(PACKAGE_RELEASE_ADAPTER_KIND, {
        provisioner: base,
        packageRegistry: scriptedPackageRegistry(),
        poll,
      }).kind,
    ).toBe(PACKAGE_RELEASE_ADAPTER_KIND);
    expect(
      buildDeployAdapter(MOBILE_RELEASE_ADAPTER_KIND, {
        provisioner: base,
        mobileDistribution: scriptedMobileDistribution(),
        poll,
      }).kind,
    ).toBe(MOBILE_RELEASE_ADAPTER_KIND);
    expect(buildDeployAdapter(MANUAL_EXTERNAL_ADAPTER_KIND, { provisioner: base, urlProbe: probe, poll }).kind).toBe(
      MANUAL_EXTERNAL_ADAPTER_KIND,
    );
  });

  it("fails LOUD when a non-direct_api class is selected without its external driver wired", () => {
    const base = { transport: scriptedDeployTransport("vercel"), secrets: secrets() };
    expect(() => buildDeployAdapter(PULUMI_ADAPTER_KIND, { provisioner: base })).toThrow(
      /required config 'pulumiRunner' is not set/u,
    );
    expect(() => buildDeployAdapter(PACKAGE_RELEASE_ADAPTER_KIND, { provisioner: base })).toThrow(
      /required config 'packageRegistry' is not set/u,
    );
    expect(() => buildDeployAdapter(MOBILE_RELEASE_ADAPTER_KIND, { provisioner: base })).toThrow(
      /required config 'mobileDistribution' is not set/u,
    );
  });
});
