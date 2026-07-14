// FlyImageBuilder seam — the merge-reflecting build path for a Fly release (PR2).
// Split out of `deployProvisioner.test.ts` (which is at the 500-line architecture cap)
// and `flyDeployReleaseConfig.test.ts` (which pins the static-image + IPv4 paths): this
// file pins the BUILDER path exclusively — proving `triggerDeploy` calls the injected
// `FlyImageBuilder` with the merged `{ repo, ref, appName, flyToken }` and releases the
// BUILT `imageRef` (merge-reflecting selection) using the SAME PR1 port-mapped config.
// The fake (`scriptedFlyImageBuilder`) returns a synthetic ref — NO docker, NO network —
// so the seam is EXERCISED (no dead code) before the live builder (PR3) exists.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { OrgGrant, ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import { FlyDeployProvisioner, flyMachineConfig } from "../../src/engine/provisioners/flyDeployProvisioner.js";
import { FlyImageBuildFailedError } from "../../src/engine/provisioners/flyImageBuilder.js";
import { scriptedDeployTransport } from "./fakes/scriptedDeployTransport.js";
import { scriptedFlyImageBuilder } from "./fakes/scriptedFlyImageBuilder.js";

const TOKEN_REF = "secret://org/deploy-token";
const TOKEN_VALUE = "fly_or_vercel_super_secret_token";

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: TOKEN_REF, value: TOKEN_VALUE });
  return store;
}

const flyGrant: OrgGrant = {
  providerKind: "deploy.flyio",
  credentialRef: TOKEN_REF,
  metadata: { orgSlug: "acme" },
};

// `orgSlug: "tanren"` → the deploy-app namespacing rule prefixes the created app, so a
// projectName "acme-web" becomes the real app name "tanren-acme-web".
const ctx = (name: string): ProjectContext => ({
  projectId: `proj_${name}`,
  orgId: "org_1",
  orgSlug: "tanren",
  stack: "node",
  name,
});

describe("FlyDeployProvisioner — merge-reflecting image builder (triggerDeploy)", () => {
  it("calls builder.build with the merged { repo, ref, appName, flyToken } and releases the BUILT imageRef", async () => {
    const transport = scriptedDeployTransport("fly");
    const builder = scriptedFlyImageBuilder();
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets(), flyImageBuilder: builder });
    await prov.provision(flyGrant, ctx("acme-web"));

    const source = { repo: "acme/acme-web", ref: "deadbeefcafe" };
    await prov.deploy(flyGrant, "fly_app_1", source);

    // The builder received the merged source + the namespaced app name + the deploy token.
    expect(builder.buildRequests).toHaveLength(1);
    expect(builder.buildRequests[0]).toEqual({
      repo: "acme/acme-web",
      ref: "deadbeefcafe",
      appName: "tanren-acme-web",
      flyToken: TOKEN_VALUE,
    });
    // The released config.image IS the BUILT ref (the SHA tags it → merge-reflecting).
    const triggered = transport.deploysTriggered();
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.body["config"]).toEqual(flyMachineConfig("registry.fly.io/tanren-acme-web:deadbeefcafe"));
  });

  it("the builder is the DEFAULT path — takes precedence even when allowFlyStaticDeploy is OFF", async () => {
    // No flag needed: a builder present means merge-reflecting. The static-image gate must
    // NOT block the builder path (the flag is only the escape hatch for the no-builder arm).
    const transport = scriptedDeployTransport("fly");
    const builder = scriptedFlyImageBuilder();
    const prov = new FlyDeployProvisioner({
      transport,
      secrets: secrets(),
      flyImageBuilder: builder,
      allowFlyStaticDeploy: false,
    });
    await prov.provision(flyGrant, ctx("acme-web"));

    await expect(prov.deploy(flyGrant, "fly_app_1", { repo: "acme/acme-web", ref: "abc123" })).resolves.toBeDefined();
    expect(builder.buildRequests).toHaveLength(1);
    expect(transport.deploysTriggered()[0]!.body["config"]).toEqual(
      flyMachineConfig("registry.fly.io/tanren-acme-web:abc123"),
    );
  });

  it("a builder failure (FlyImageBuildFailedError) propagates LOUD — never a fallback to a stale image", async () => {
    const transport = scriptedDeployTransport("fly");
    const builder = scriptedFlyImageBuilder();
    builder.scriptFailure("docker buildx exited 1");
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets(), flyImageBuilder: builder });
    await prov.provision(flyGrant, ctx("acme-web"));

    await expect(prov.deploy(flyGrant, "fly_app_1", { repo: "acme/acme-web", ref: "deadbeef" })).rejects.toBeInstanceOf(
      FlyImageBuildFailedError,
    );
    // No release fired — the build aborts BEFORE the Machines POST.
    expect(transport.deploysTriggered()).toHaveLength(0);
  });

  it("the released config carries the PR1 port-mapped services/ports/checks/guest against the BUILT image", async () => {
    const transport = scriptedDeployTransport("fly");
    const builder = scriptedFlyImageBuilder();
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets(), flyImageBuilder: builder });
    await prov.provision(flyGrant, ctx("acme-web"));

    await prov.deploy(flyGrant, "fly_app_1", { repo: "acme/acme-web", ref: "feat-1" });
    const config = transport.deploysTriggered()[0]!.body["config"] as Record<string, unknown>;
    // The full PR1 release shape is asserted by value in flyDeployReleaseConfig.test.ts;
    // here we pin that the builder path produces the SAME port-mapped config (only the image differs).
    expect(config["guest"]).toEqual({ cpu_kind: "shared", cpus: 1, memory_mb: 256 });
    expect(config["services"]).toEqual([
      {
        protocol: "tcp",
        internal_port: 3000,
        ports: [
          { port: 80, handlers: ["http"], force_https: true },
          { port: 443, handlers: ["tls", "http"] },
        ],
      },
    ]);
    expect(config["image"]).toBe("registry.fly.io/tanren-acme-web:feat-1");
  });

  it("the built imageRef / flyToken never leak into the DeployResult (only the app URL + machine id)", async () => {
    const transport = scriptedDeployTransport("fly");
    const builder = scriptedFlyImageBuilder();
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets(), flyImageBuilder: builder });
    await prov.provision(flyGrant, ctx("acme-web"));

    const result = await prov.deploy(flyGrant, "fly_app_1", { repo: "acme/acme-web", ref: "deadbeef" });
    // The result carries the app URL + a machine id + state — NEVER the token or a raw ref dump.
    expect(result.url).toBe("https://tanren-acme-web.fly.dev");
    expect(result.deploymentId).toMatch(/^fly_deploy_/u);
    expect(JSON.stringify(result)).not.toContain(TOKEN_VALUE);
  });
});
