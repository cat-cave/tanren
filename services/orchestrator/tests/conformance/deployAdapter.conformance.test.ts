import { testOrgGrant } from "../helpers/orgGrant.js";
// DeployAdapter conformance (the deployment seam above IntegrationProvisioner): the
// `direct_api` adapter must DELEGATE provisionOrBind/deploy/status to the wrapped
// Vercel/Fly provisioners, and `verify` must POLL the provider to a READY terminal +
// SMOKE-CHECK the resolved URL — failing LOUD on a failure terminal, a never-ready
// budget exhaustion, or an unreachable URL. Driven entirely over the scripted in-
// memory deploy transport + a scripted URL probe — NO live Vercel/Fly/network calls.

import { describe, expect, it, vi } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import type { DeployRef } from "../../src/engine/contracts/deployAdapter.js";
import {
  projectIntegrationOperationTarget,
  type IntegrationOperationTarget,
  type IntegrationPrivilegedOperation,
} from "../../src/engine/contracts/integrationAuthority.js";
import { DirectApiDeployAdapter } from "../../src/engine/deploy/directApiDeployAdapter.js";
import { scriptedDeployTransport, type ScriptedDeployTransport } from "./fakes/scriptedDeployTransport.js";
import { scriptedUrlProbe, instantVerifyPollPolicy } from "./fakes/scriptedUrlProbe.js";

const TOKEN_REF = "secret://org/deploy-token";
const TOKEN_VALUE = "fly_or_vercel_super_secret_token";

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: TOKEN_REF, value: TOKEN_VALUE });
  void store.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  void store.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  return store;
}

// task #27: every Tanren-created deploy app is namespaced `<orgSlug>-<projectName>`.
// These adapter tests are about the verify/deploy LIFECYCLE (not the naming), but
// the provisioner now ALWAYS prefixes — so a `ctx("acme-web")` reaches the provider
// as `tanren-acme-web` (and the resolved URLs use that prefixed name).
const ctx = (name: string): ProjectContext => ({
  projectId: `proj_${name}`,
  orgId: "org_1",
  orgSlug: "tanren",
  stack: "node",
  name,
});
type DirectProviderKind = "deploy.vercel" | "deploy.flyio";
const providerMetadata = (kind: DirectProviderKind) =>
  kind === "deploy.vercel"
    ? { teamId: "team_abc", slug: "acme" }
    : { orgSlug: "acme", image: "registry.fly.io/acme-web:deployment-1" };
const authorityCtx = ctx("authority");

const operationGrant = (
  kind: DirectProviderKind,
  operation: IntegrationPrivilegedOperation,
  target: IntegrationOperationTarget,
  owner: ProjectContext = authorityCtx,
) =>
  testOrgGrant({
    providerKind: kind,
    credentialRef: `${TOKEN_REF}/g/1`,
    metadata: providerMetadata(kind),
    capability: "deploy",
    operation,
    target,
    orgId: owner.orgId,
    projectId: owner.projectId,
  });

const provisionGrant = (kind: DirectProviderKind, projectCtx: ProjectContext) =>
  operationGrant(kind, "provision", projectIntegrationOperationTarget(projectCtx), projectCtx);
const deployGrant = (kind: DirectProviderKind, ref: DeployRef, source: { repo: string; ref: string }) =>
  operationGrant(kind, "deploy", { resourceId: ref.appId, sourceRepo: source.repo, sourceRef: source.ref });
const deploymentGrant = (
  kind: DirectProviderKind,
  operation: "verify" | "resolve_demo_surface",
  ref: DeployRef,
  deploymentId: string,
) => operationGrant(kind, operation, { resourceId: ref.appId, deploymentId });

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
    const projectCtx = ctx("acme-web");
    const artifact = await instance.provisionOrBind(await provisionGrant("deploy.vercel", projectCtx), projectCtx, {
      mode: "provision",
    });
    expect(artifact.deployRef?.provider).toBe("deploy.vercel");
    // task #27: every deploy app is namespaced with the tanren org slug.
    expect(transport.appNames()).toEqual(["tanren-acme-web"]);
    expect(JSON.stringify(artifact)).not.toContain(TOKEN_VALUE);
  });

  it("provisionOrBind(bind) links an already-discovered resource", async () => {
    const transport = scriptedDeployTransport("vercel", ["existing-proj"]);
    const { instance } = adapter(transport);
    const existingId = `vercel_app_1`;
    const projectCtx = ctx("whatever");
    const artifact = await instance.provisionOrBind(
      await operationGrant(
        "deploy.vercel",
        "bind",
        projectIntegrationOperationTarget(projectCtx, existingId),
        projectCtx,
      ),
      projectCtx,
      { mode: "bind", existingResourceId: existingId },
    );
    expect(artifact.deployRef?.appId).toBe(existingId);
    // bind never creates a second app.
    expect(transport.appNames()).toEqual(["existing-proj"]);
  });

  it("deploy TRIGGERS a build of the merged ref via the wrapped provisioner", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const projectCtx = ctx("acme-web");
    const artifact = await instance.provisionOrBind(await provisionGrant("deploy.vercel", projectCtx), projectCtx, {
      mode: "provision",
    });
    const ref: DeployRef = { provider: "deploy.vercel", appId: artifact.deployRef!.appId };
    const source = { repo: "acme/acme-web", ref: "deadbeef" };
    const result = await instance.deploy(await deployGrant("deploy.vercel", ref, source), ref, source);
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
    const projectCtx = ctx("acme-web");
    const artifact = await instance.provisionOrBind(await provisionGrant("deploy.vercel", projectCtx), projectCtx, {
      mode: "provision",
    });
    const appId = artifact.deployRef!.appId;
    const ref: DeployRef = { provider: "deploy.vercel", appId };
    const source = { repo: "acme/acme-web", ref: "main" };
    const { deploymentId } = await instance.deploy(await deployGrant("deploy.vercel", ref, source), ref, source);
    transport.scriptDeploymentStates(deploymentId, ["BUILDING"]);
    const status = await instance.status(
      await deploymentGrant("deploy.vercel", "verify", ref, deploymentId),
      ref,
      deploymentId,
    );
    expect(status.state).toBe("BUILDING");
    expect(status.ready).toBe(false);
    expect(status.failed).toBe(false);
    // A single read — not a poll loop.
    expect(transport.statusPolls(deploymentId)).toBe(1);
  });
});

describe("DirectApiDeployAdapter — verify (proven deploy)", () => {
  async function provisionAndDeploy(instance: DirectApiDeployAdapter, kind: DirectProviderKind, name: string) {
    const projectCtx = ctx(name);
    const artifact = await instance.provisionOrBind(await provisionGrant(kind, projectCtx), projectCtx, {
      mode: "provision",
    });
    const ref: DeployRef = { provider: kind, appId: artifact.deployRef!.appId };
    const source = { repo: `acme/${name}`, ref: "main" };
    const { deploymentId } = await instance.deploy(await deployGrant(kind, ref, source), ref, source);
    return { ref, deploymentId };
  }

  it("polls the provider through BUILDING→READY then smoke-checks the resolved URL", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance, probe } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(instance, "deploy.vercel", "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["QUEUED", "BUILDING", "BUILDING", "READY"]);

    const verification = await instance.verify(
      () => deploymentGrant("deploy.vercel", "verify", ref, deploymentId),
      ref,
      deploymentId,
    );

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

  it("performs no next status read when reauthorization reports revocation between polls", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(instance, "deploy.vercel", "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["BUILDING", "READY"]);
    const grant = await deploymentGrant("deploy.vercel", "verify", ref, deploymentId);
    let authorityAttempts = 0;

    await expect(
      instance.verify(
        async () => {
          authorityAttempts += 1;
          if (authorityAttempts > 1) throw new Error("selected grant revoked");
          return grant;
        },
        ref,
        deploymentId,
      ),
    ).rejects.toThrow(/revoked/u);
    expect(authorityAttempts).toBe(2);
    expect(transport.statusPolls(deploymentId)).toBe(1);
  });

  it("performs no next status read when a fixed lease expires between polls", async () => {
    vi.useFakeTimers();
    try {
      const issuedAt = new Date("2030-01-01T00:00:00.000Z");
      vi.setSystemTime(issuedAt);
      const transport = scriptedDeployTransport("vercel");
      const { instance } = adapter(transport);
      const { ref, deploymentId } = await provisionAndDeploy(instance, "deploy.vercel", "acme-web");
      transport.scriptDeploymentStates(deploymentId, ["BUILDING", "READY"]);
      const grant = await deploymentGrant("deploy.vercel", "verify", ref, deploymentId);
      let authorityAttempts = 0;

      await expect(
        instance.verify(
          async () => {
            authorityAttempts += 1;
            if (authorityAttempts > 1) vi.setSystemTime(new Date(issuedAt.getTime() + 31_000));
            return grant;
          },
          ref,
          deploymentId,
        ),
      ).rejects.toThrow(/expired/u);
      expect(authorityAttempts).toBe(2);
      expect(transport.statusPolls(deploymentId)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails LOUD when the deployment reaches a FAILURE terminal", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance, probe } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(instance, "deploy.vercel", "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["BUILDING", "ERROR"]);
    await expect(
      instance.verify(() => deploymentGrant("deploy.vercel", "verify", ref, deploymentId), ref, deploymentId),
    ).rejects.toThrow(/FAILURE state 'ERROR'/u);
    // A failed deploy is never smoke-checked.
    expect(probe.probed).toEqual([]);
  });

  it("keeps polling UNBOUNDED while the state advances — succeeds well past the old poll cap", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(instance, "deploy.vercel", "acme-web");
    // A genuinely SLOW deploy: BUILDING for 20 polls (well past the old maxPolls=10 cap),
    // each poll a fresh advancing state so the convergence loop reads PROGRESS, then READY.
    const slowButProgressing = Array.from({ length: 20 }, (_v, i) => `BUILDING-${String(i)}`);
    transport.scriptDeploymentStates(deploymentId, [...slowButProgressing, "READY"]);
    const verification = await instance.verify(
      () => deploymentGrant("deploy.vercel", "verify", ref, deploymentId),
      ref,
      deploymentId,
    );
    expect(verification.ready).toBe(true);
    expect(verification.state).toBe("READY");
    // 21 polls — a count that would have FAILED under the old maxPolls=10/3 budget.
    expect(verification.pollCount).toBe(21);
    expect(transport.statusPolls(deploymentId)).toBe(21);
  });

  it("escalates LOUD as STUCK (not on a count) when the state never advances", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(instance, "deploy.vercel", "acme-web");
    // The deployment never advances past BUILDING — a PROVEN fixed point (same state, no
    // advancement), escalated as a stuck-deploy via intelligent non-convergence, NOT a cap.
    transport.scriptDeploymentStates(deploymentId, ["BUILDING"]);
    await expect(
      instance.verify(() => deploymentGrant("deploy.vercel", "verify", ref, deploymentId), ref, deploymentId),
    ).rejects.toThrow(/is STUCK in non-terminal state 'BUILDING'/u);
  });

  it("fails LOUD when READY but the URL smoke check is unreachable", async () => {
    const transport = scriptedDeployTransport("vercel");
    // The deployed URL answers 503 (not reachable).
    const { instance } = adapter(transport, 503);
    const { ref, deploymentId } = await provisionAndDeploy(instance, "deploy.vercel", "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["READY"]);
    await expect(
      instance.verify(() => deploymentGrant("deploy.vercel", "verify", ref, deploymentId), ref, deploymentId),
    ).rejects.toThrow(/not reachable \(smoke check returned HTTP 503\)/u);
  });

  it("Fly: polls machine state to 'started' then smoke-checks the app URL", async () => {
    const transport = scriptedDeployTransport("fly");
    const { instance, probe } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(instance, "deploy.flyio", "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["created", "starting", "started"]);
    const verification = await instance.verify(
      () => deploymentGrant("deploy.flyio", "verify", ref, deploymentId),
      ref,
      deploymentId,
    );
    expect(verification.ready).toBe(true);
    expect(verification.state).toBe("started");
    // task #27: the Fly URL uses the namespaced app name (`tanren-acme-web`).
    expect(verification.url).toBe("https://tanren-acme-web.fly.dev");
    expect(probe.probed).toEqual(["https://tanren-acme-web.fly.dev"]);
  });

  it("treats a 401 (deployment protection) as REACHABLE, not an unhealthy deploy", async () => {
    // Vercel Deployment Protection fronts a HEALTHY, running deployment with an auth
    // gate — the 401 PROVES the server is up. Verify must NOT fail-verify on it.
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport, 401);
    const { ref, deploymentId } = await provisionAndDeploy(instance, "deploy.vercel", "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["READY"]);
    const verification = await instance.verify(
      () => deploymentGrant("deploy.vercel", "verify", ref, deploymentId),
      ref,
      deploymentId,
    );
    expect(verification.ready).toBe(true);
    expect(verification.smokeStatus).toBe(401);
  });

  it("still fails LOUD on a non-protection error status (e.g. 500)", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport, 500);
    const { ref, deploymentId } = await provisionAndDeploy(instance, "deploy.vercel", "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["READY"]);
    await expect(
      instance.verify(() => deploymentGrant("deploy.vercel", "verify", ref, deploymentId), ref, deploymentId),
    ).rejects.toThrow(/not reachable .*HTTP 500/u);
  });

  it("the deploy token VALUE is never returned in a verification result", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(instance, "deploy.vercel", "acme-web");
    transport.scriptDeploymentStates(deploymentId, ["READY"]);
    const verification = await instance.verify(
      () => deploymentGrant("deploy.vercel", "verify", ref, deploymentId),
      ref,
      deploymentId,
    );
    expect(JSON.stringify(verification)).not.toContain(TOKEN_VALUE);
  });
});

describe("DirectApiDeployAdapter — demoSurface (the demo exercise surface)", () => {
  async function provisionAndDeploy(instance: DirectApiDeployAdapter) {
    const projectCtx = ctx("acme-web");
    const artifact = await instance.provisionOrBind(await provisionGrant("deploy.vercel", projectCtx), projectCtx, {
      mode: "provision",
    });
    const ref: DeployRef = { provider: "deploy.vercel", appId: artifact.deployRef!.appId };
    const source = { repo: "acme/acme-web", ref: "main" };
    const { deploymentId } = await instance.deploy(await deployGrant("deploy.vercel", ref, source), ref, source);
    return { ref, deploymentId };
  }

  it("resolves the live web_url surface from the deployment status (the same resolved URL)", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(instance);
    transport.scriptDeploymentStates(deploymentId, ["READY"]);
    const surface = await instance.demoSurface(
      await deploymentGrant("deploy.vercel", "resolve_demo_surface", ref, deploymentId),
      ref,
      deploymentId,
    );
    expect(surface.kind).toBe("web_url");
    expect(surface.url).toMatch(/^https:\/\//u);
    // demoSurface is a READ — no second deploy was triggered.
    expect(transport.deploysTriggered()).toHaveLength(1);
  });

  it("never returns the deploy token VALUE in a surface", async () => {
    const transport = scriptedDeployTransport("vercel");
    const { instance } = adapter(transport);
    const { ref, deploymentId } = await provisionAndDeploy(instance);
    transport.scriptDeploymentStates(deploymentId, ["READY"]);
    const surface = await instance.demoSurface(
      await deploymentGrant("deploy.vercel", "resolve_demo_surface", ref, deploymentId),
      ref,
      deploymentId,
    );
    expect(JSON.stringify(surface)).not.toContain(TOKEN_VALUE);
  });
});
