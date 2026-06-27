// PulumiDeployAdapter conformance: provisionOrBind select-or-inits the stack; deploy
// runs `pulumi up` and returns the update id + endpoint; verify POLLS the update to a
// SUCCEEDED terminal + smoke-checks the endpoint (failing LOUD on a FAILED terminal, a
// never-succeeded budget, or an unreachable endpoint); demoSurface resolves a `web_url`
// surface. Plus the loud-fail-on-missing-config behavior (no backend / project / token).
// Driven over the scripted Pulumi runner + a scripted URL probe — NO real Pulumi/cloud.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { OrgGrant, ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import type { DeployRef } from "../../src/engine/contracts/deployAdapter.js";
import { PulumiDeployAdapter, PULUMI_PROVIDER_KIND } from "../../src/engine/deploy/pulumiDeployAdapter.js";
import { scriptedUrlProbe, instantVerifyPollPolicy } from "./fakes/scriptedUrlProbe.js";
import { scriptedPulumiRunner } from "./fakes/scriptedDeployDrivers.js";

const TOKEN_REF = "secret://org/pulumi-token";
const TOKEN_VALUE = "pul-super-secret-access-token";

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: TOKEN_REF, value: TOKEN_VALUE });
  return store;
}

const grant: OrgGrant = {
  providerKind: PULUMI_PROVIDER_KIND,
  credentialRef: TOKEN_REF,
  metadata: { pulumiBackend: "https://api.pulumi.com", pulumiProject: "acme-infra" },
};

const ctx = (name: string): ProjectContext => ({
  projectId: `proj_${name}`,
  orgId: "org_1",
  orgSlug: "tanren",
  stack: "node",
  name,
});

function adapter(runner = scriptedPulumiRunner(), urlStatus = 200) {
  const probe = scriptedUrlProbe(urlStatus);
  const instance = new PulumiDeployAdapter({
    runner,
    secrets: secrets(),
    urlProbe: probe,
    poll: instantVerifyPollPolicy(),
  });
  return { instance, probe, runner };
}

describe("PulumiDeployAdapter — lifecycle", () => {
  it("provisionOrBind(provision) select-or-inits the project-named stack", async () => {
    const { instance } = adapter();
    const artifact = await instance.provisionOrBind(grant, ctx("acme-web"), { mode: "provision" });
    expect(artifact.deployRef?.provider).toBe(PULUMI_PROVIDER_KIND);
    expect(artifact.deployRef?.appId).toBe("acme-web");
    expect(artifact.projectConfig?.["pulumiStackId"]).toBe("acme-infra/acme-web");
    expect(JSON.stringify(artifact)).not.toContain(TOKEN_VALUE);
  });

  it("provisionOrBind(bind) links an already-discovered stack name", async () => {
    const { instance } = adapter();
    const artifact = await instance.provisionOrBind(grant, ctx("whatever"), {
      mode: "bind",
      existingResourceId: "prod-stack",
    });
    expect(artifact.deployRef?.appId).toBe("prod-stack");
  });

  it("deploy runs `pulumi up` and returns the update id + endpoint", async () => {
    const { instance } = adapter();
    const ref: DeployRef = { provider: PULUMI_PROVIDER_KIND, appId: "acme-web" };
    const result = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "deadbeef" });
    expect(result.deploymentId).toMatch(/^update_/u);
    expect(result.url).toMatch(/^https:\/\//u);
    expect(result.state).toBe("in-progress");
  });
});

describe("PulumiDeployAdapter — verify (proven deploy)", () => {
  const ref: DeployRef = { provider: PULUMI_PROVIDER_KIND, appId: "acme-web" };

  it("polls through in-progress→succeeded then smoke-checks the endpoint", async () => {
    const runner = scriptedPulumiRunner();
    const { instance, probe } = adapter(runner);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "main" });
    runner.scriptUpdateResults(deploymentId, ["in-progress", "in-progress", "succeeded"]);
    const verification = await instance.verify(grant, ref, deploymentId);
    expect(verification.ready).toBe(true);
    expect(verification.state).toBe("succeeded");
    expect(verification.pollCount).toBe(3);
    expect(verification.smokeStatus).toBe(200);
    expect(probe.probed[0]).toMatch(/^https:\/\//u);
  });

  it("fails LOUD when the update reaches a FAILED terminal", async () => {
    const runner = scriptedPulumiRunner();
    const { instance, probe } = adapter(runner);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "main" });
    runner.scriptUpdateResults(deploymentId, ["in-progress", "failed"]);
    await expect(instance.verify(grant, ref, deploymentId)).rejects.toThrow(/reached a FAILURE result 'failed'/u);
    expect(probe.probed).toEqual([]);
  });

  it("keeps polling UNBOUNDED while the result advances — succeeds past the old poll cap", async () => {
    const runner = scriptedPulumiRunner();
    const { instance } = adapter(runner);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "main" });
    // A slow stack update: 20 distinct advancing results (past the old maxPolls=10), then succeeded.
    const advancing = Array.from({ length: 20 }, (_v, i) => `in-progress-${String(i)}`);
    runner.scriptUpdateResults(deploymentId, [...advancing, "succeeded"]);
    const verification = await instance.verify(grant, ref, deploymentId);
    expect(verification.ready).toBe(true);
    expect(verification.pollCount).toBe(21);
  });

  it("escalates LOUD as STUCK (not on a count) when the result never advances", async () => {
    const runner = scriptedPulumiRunner();
    const { instance } = adapter(runner);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "main" });
    runner.scriptUpdateResults(deploymentId, ["in-progress"]);
    await expect(instance.verify(grant, ref, deploymentId)).rejects.toThrow(
      /is STUCK in non-terminal result 'in-progress'/u,
    );
  });

  it("fails LOUD when SUCCEEDED but the endpoint is unreachable", async () => {
    const runner = scriptedPulumiRunner();
    const { instance } = adapter(runner, 503);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "main" });
    runner.scriptUpdateResults(deploymentId, ["succeeded"]);
    await expect(instance.verify(grant, ref, deploymentId)).rejects.toThrow(/not reachable .*HTTP 503/u);
  });

  it("resolves a web_url demo surface from the succeeded update", async () => {
    const runner = scriptedPulumiRunner();
    const { instance } = adapter(runner);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "main" });
    runner.scriptUpdateResults(deploymentId, ["succeeded"]);
    const surface = await instance.demoSurface(grant, ref, deploymentId);
    expect(surface).toEqual({ kind: "web_url", url: expect.stringMatching(/^https:\/\//u) });
  });

  it("never returns the access token VALUE in a verification result", async () => {
    const runner = scriptedPulumiRunner();
    const { instance } = adapter(runner);
    const { deploymentId } = await instance.deploy(grant, ref, { repo: "acme/acme-web", ref: "main" });
    runner.scriptUpdateResults(deploymentId, ["succeeded"]);
    const verification = await instance.verify(grant, ref, deploymentId);
    expect(JSON.stringify(verification)).not.toContain(TOKEN_VALUE);
  });
});

describe("PulumiDeployAdapter — loud fail on missing config", () => {
  const ref: DeployRef = { provider: PULUMI_PROVIDER_KIND, appId: "acme-web" };
  const source = { repo: "acme/acme-web", ref: "main" };

  it("throws a typed config error when the backend is absent", async () => {
    const { instance } = adapter();
    const noBackend: OrgGrant = { ...grant, metadata: { pulumiProject: "acme-infra" } };
    await expect(instance.deploy(noBackend, ref, source)).rejects.toThrow(
      /required config 'pulumiBackend' is not set/u,
    );
  });

  it("throws a typed config error when the project is absent", async () => {
    const { instance } = adapter();
    const noProject: OrgGrant = { ...grant, metadata: { pulumiBackend: "https://api.pulumi.com" } };
    await expect(instance.deploy(noProject, ref, source)).rejects.toThrow(
      /required config 'pulumiProject' is not set/u,
    );
  });

  it("throws a typed config error when the access token ref is missing from the store", async () => {
    const runner = scriptedPulumiRunner();
    const instance = new PulumiDeployAdapter({
      runner,
      secrets: new InMemorySecretStore(),
      urlProbe: scriptedUrlProbe(),
      poll: instantVerifyPollPolicy(),
    });
    await expect(instance.deploy(grant, ref, source)).rejects.toThrow(/required config 'credentialRef' is not set/u);
  });
});
