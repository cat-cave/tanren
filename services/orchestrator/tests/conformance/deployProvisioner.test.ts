// Deploy-provisioner specifics beyond the shared IntegrationProvisioner
// conformance suite: the captured deployRef + preview-URL pattern, the idempotent
// find-or-create that NEVER creates a second app on re-provision, brownfield
// discover/bind, and — the load-bearing security property — that NO deploy-token
// VALUE ever leaks into the artifact (only a per-app alias ref). Driven over the
// scripted in-memory transport, so there are no live Vercel/Fly calls.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { OrgGrant, ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import { FlyDeployProvisioner } from "../../src/engine/provisioners/flyDeployProvisioner.js";
import { VercelDeployProvisioner } from "../../src/engine/provisioners/vercelDeployProvisioner.js";
import { scriptedDeployTransport } from "./fakes/scriptedDeployTransport.js";

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
  metadata: { orgSlug: "acme" },
};

const ctx = (name: string): ProjectContext => ({ projectId: `proj_${name}`, orgId: "org_1", stack: "node", name });

describe("VercelDeployProvisioner", () => {
  it("provision captures a deployRef + Vercel preview-URL pattern", async () => {
    const store = secrets();
    const transport = scriptedDeployTransport("vercel");
    const prov = new VercelDeployProvisioner({ transport, secrets: store });
    const artifact = await prov.provision(vercelGrant, ctx("acme-web"));

    expect(artifact.deployRef?.provider).toBe("deploy.vercel");
    expect(artifact.deployRef?.appId).toMatch(/^vercel_app_/u);
    expect(artifact.deployRef?.previewUrlPattern).toBe("https://acme-web-git-{branch}-acme.vercel.app");
    expect(artifact.projectConfig?.["previewUrlPattern"]).toBe("https://acme-web-git-{branch}-acme.vercel.app");
    // The env-attach seam is ABSENT until attachRuntimeAppEnv lands it —
    // the provisioner never writes a null placeholder (a config a strict read rejects).
    expect(artifact.projectConfig).not.toHaveProperty("envAttachmentRef");
  });

  it("provision is idempotent: a second run reuses the app, never creating a 2nd", async () => {
    const transport = scriptedDeployTransport("vercel");
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    const first = await prov.provision(vercelGrant, ctx("acme-web"));
    const second = await prov.provision(vercelGrant, ctx("acme-web"));
    expect(transport.appNames()).toEqual(["acme-web"]);
    expect(second.deployRef?.appId).toBe(first.deployRef?.appId);
  });

  it("the artifact carries a token ALIAS ref, never the token value", async () => {
    const store = secrets();
    const prov = new VercelDeployProvisioner({ transport: scriptedDeployTransport("vercel"), secrets: store });
    const artifact = await prov.provision(vercelGrant, ctx("acme-web"));
    const ref = artifact.secretRefs?.["deployToken"];
    expect(ref).toBeDefined();
    expect(ref).not.toContain(TOKEN_VALUE);
    expect(JSON.stringify(artifact)).not.toContain(TOKEN_VALUE);
    // The alias resolves to the org credential ref (a pointer), not the value.
    const alias = await store.get(ref as string);
    expect(alias?.value).toBe(TOKEN_REF);
    expect(alias?.value).not.toBe(TOKEN_VALUE);
  });

  it("the token value is used as a bearer but never echoed back", async () => {
    const transport = scriptedDeployTransport("vercel");
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    await prov.provision(vercelGrant, ctx("acme-web"));
    expect(transport.bearersSeen).toContain(`Bearer ${TOKEN_VALUE}`);
  });

  it("discover lists existing projects; bind links one of them", async () => {
    const transport = scriptedDeployTransport("vercel", ["existing-proj"]);
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    const discovered = await prov.discover(vercelGrant);
    expect(discovered.map((r) => r.label)).toContain("existing-proj");
    const bound = await prov.bind(vercelGrant, discovered[0]!.id, ctx("whatever"));
    expect(bound.deployRef?.appId).toBe(discovered[0]!.id);
  });

  it("provision fails loud when the org credentialRef is absent from the store", async () => {
    const prov = new VercelDeployProvisioner({
      transport: scriptedDeployTransport("vercel"),
      secrets: new InMemorySecretStore(),
    });
    await expect(prov.provision(vercelGrant, ctx("acme-web"))).rejects.toThrow(/credentialRef/u);
  });

  it("attachRuntimeEnv sends each var to the Vercel env endpoint; the value reaches the transport", async () => {
    const transport = scriptedDeployTransport("vercel");
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    await prov.attachRuntimeEnv(vercelGrant, "prj_123", [
      { key: "RESEND_API_KEY", value: "re_live_xyz" },
      { key: "PUBLIC_URL", value: "https://app.example" },
    ]);
    expect(transport.envByApp()).toEqual({
      prj_123: { RESEND_API_KEY: "re_live_xyz", PUBLIC_URL: "https://app.example" },
    });
    // The deploy token is the bearer; the env VALUES are never used as a bearer.
    expect(transport.bearersSeen).toContain(`Bearer ${TOKEN_VALUE}`);
  });

  it("attachRuntimeEnv with no vars makes no provider call", async () => {
    const transport = scriptedDeployTransport("vercel");
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    await prov.attachRuntimeEnv(vercelGrant, "prj_123", []);
    expect(transport.bearersSeen).toEqual([]);
    expect(transport.envByApp()).toEqual({});
  });

  it("deploy TRIGGERS a build of the merged ref + returns a resolved URL", async () => {
    const transport = scriptedDeployTransport("vercel");
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    // The app must exist (provision created it) before a deploy is triggered.
    const artifact = await prov.provision(vercelGrant, ctx("acme-web"));
    const appId = artifact.deployRef!.appId;

    const result = await prov.deploy(vercelGrant, appId, { repo: "acme/acme-web", ref: "deadbeefcafe" });

    // The deployment endpoint was hit with the merged commit in the REAL v13 github
    // gitSource shape: `org` (owner) + a BARE `repo` name + `sha` (the merged commit).
    const triggered = transport.deploysTriggered();
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.appId).toBe(appId);
    expect(triggered[0]!.body["gitSource"]).toEqual({
      type: "github",
      org: "acme",
      repo: "acme-web",
      ref: "deadbeefcafe",
      sha: "deadbeefcafe",
    });
    // A resolved, concrete URL (no placeholder) + a deployment id + state.
    expect(result.url).toMatch(/^https:\/\//u);
    expect(result.url).not.toContain("{branch}");
    expect(result.deploymentId).toMatch(/^vercel_deploy_/u);
    expect(result.state).toBe("QUEUED");
  });

  it("the gitSource body shape matches the live v13 github variant (org + bare repo + sha)", async () => {
    // CONTRACT GUARD: the fake REJECTS a malformed gitSource the way Vercel does, so a
    // regression to the old `{ type:"github", repo:"owner/name", ref }` shape fails
    // here instead of passing falsely. This test pins each gitSource field explicitly.
    const transport = scriptedDeployTransport("vercel");
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    const artifact = await prov.provision(vercelGrant, ctx("acme-web"));
    const appId = artifact.deployRef!.appId;

    await prov.deploy(vercelGrant, appId, { repo: "acme/acme-web", ref: "deadbeefcafe" });

    const gitSource = transport.deploysTriggered()[0]!.body["gitSource"] as Record<string, unknown>;
    expect(gitSource["type"]).toBe("github");
    // `org` is the OWNER and `repo` is the BARE name — NOT a combined `owner/name` slug.
    expect(gitSource["org"]).toBe("acme");
    expect(gitSource["repo"]).toBe("acme-web");
    expect(gitSource["repo"]).not.toContain("/");
    // The merged commit pins the build: it is in `sha` (and `ref` accepts the SHA too).
    expect(gitSource["sha"]).toBe("deadbeefcafe");
    expect(gitSource["ref"]).toBe("deadbeefcafe");
  });

  it("deploy fails loud when the repo slug is not a valid 'owner/name'", async () => {
    const transport = scriptedDeployTransport("vercel");
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    const artifact = await prov.provision(vercelGrant, ctx("acme-web"));
    const appId = artifact.deployRef!.appId;
    await expect(prov.deploy(vercelGrant, appId, { repo: "no-owner", ref: "abc123" })).rejects.toThrow(
      /not a valid 'owner\/name'/u,
    );
  });

  it("deploy fails loud for an unknown app id (never a silent no-op)", async () => {
    const prov = new VercelDeployProvisioner({ transport: scriptedDeployTransport("vercel"), secrets: secrets() });
    await expect(prov.deploy(vercelGrant, "prj_missing", { repo: "a/b", ref: "main" })).rejects.toThrow(
      /cannot deploy unknown app/u,
    );
  });
});

describe("FlyDeployProvisioner", () => {
  it("provision captures a deployRef + Fly preview-URL pattern", async () => {
    const prov = new FlyDeployProvisioner({ transport: scriptedDeployTransport("fly"), secrets: secrets() });
    const artifact = await prov.provision(flyGrant, ctx("acme-web"));
    expect(artifact.deployRef?.provider).toBe("deploy.flyio");
    expect(artifact.deployRef?.previewUrlPattern).toBe("https://acme-web.fly.dev");
    expect(artifact.projectConfig?.["deployProvider"]).toBe("deploy.flyio");
  });

  it("provision is idempotent: a second run reuses the app, never creating a 2nd", async () => {
    const transport = scriptedDeployTransport("fly");
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets() });
    await prov.provision(flyGrant, ctx("acme-web"));
    await prov.provision(flyGrant, ctx("acme-web"));
    expect(transport.appNames()).toEqual(["acme-web"]);
  });

  it("the artifact carries a token alias ref, never the token value", async () => {
    const prov = new FlyDeployProvisioner({ transport: scriptedDeployTransport("fly"), secrets: secrets() });
    const artifact = await prov.provision(flyGrant, ctx("acme-web"));
    expect(JSON.stringify(artifact)).not.toContain(TOKEN_VALUE);
    expect(artifact.secretRefs?.["deployToken"]).toMatch(/^secret:\/\/deploy\/deploy\.flyio\//u);
  });

  it("requires orgSlug in the grant metadata (fails loud)", async () => {
    const prov = new FlyDeployProvisioner({ transport: scriptedDeployTransport("fly"), secrets: secrets() });
    const noOrg: OrgGrant = { providerKind: "deploy.flyio", credentialRef: TOKEN_REF, metadata: {} };
    await expect(prov.provision(noOrg, ctx("acme-web"))).rejects.toThrow(/orgSlug/u);
  });

  it("discover lists existing apps; bind links one of them", async () => {
    const transport = scriptedDeployTransport("fly", ["existing-app"]);
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets() });
    const discovered = await prov.discover(flyGrant);
    expect(discovered.map((r) => r.label)).toContain("existing-app");
    const bound = await prov.bind(flyGrant, discovered[0]!.id, ctx("whatever"));
    expect(bound.deployRef?.appId).toBe(discovered[0]!.id);
  });

  it("attachRuntimeEnv sets the app's Fly secrets in one call; the values reach the transport", async () => {
    const transport = scriptedDeployTransport("fly");
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets() });
    await prov.attachRuntimeEnv(flyGrant, "acme-web", [
      { key: "RESEND_API_KEY", value: "re_live_xyz" },
      { key: "DATABASE_URL", value: "postgres://secret" },
    ]);
    expect(transport.envByApp()).toEqual({
      "acme-web": { RESEND_API_KEY: "re_live_xyz", DATABASE_URL: "postgres://secret" },
    });
    // Fly batches all secrets into ONE POST → exactly one bearer observed.
    expect(transport.bearersSeen).toEqual([`Bearer ${TOKEN_VALUE}`]);
  });

  it("attachRuntimeEnv fails loud when the org deploy token is absent", async () => {
    const prov = new FlyDeployProvisioner({
      transport: scriptedDeployTransport("fly"),
      secrets: new InMemorySecretStore(),
    });
    await expect(prov.attachRuntimeEnv(flyGrant, "acme-web", [{ key: "K", value: "v" }])).rejects.toThrow(
      /credentialRef/u,
    );
  });

  it("deploy is NOT merge-reflecting: fails loud without the explicit static-deploy opt-in", async () => {
    // The Fly arm releases a static image + ignores the merged source, so it cannot
    // prove "the live product reflects this merge" — it MUST refuse unless the operator
    // explicitly accepts the static-image semantics (so apex never proves deploy on Fly).
    const transport = scriptedDeployTransport("fly");
    // Static-deploy opt-in OFF (the default) → the Fly arm must refuse.
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets(), allowFlyStaticDeploy: false });
    const grantWithImage: OrgGrant = {
      ...flyGrant,
      metadata: { ...flyGrant.metadata, image: "registry.fly.io/acme-web:deployment-1" },
    };
    await prov.provision(grantWithImage, ctx("acme-web"));
    await expect(prov.deploy(grantWithImage, "fly_app_1", { repo: "acme/acme-web", ref: "main" })).rejects.toThrow(
      /NOT merge-reflecting/u,
    );
  });

  it("deploy TRIGGERS a Machines release of the app's image + returns the app URL (static-deploy opt-in)", async () => {
    const transport = scriptedDeployTransport("fly");
    // Static-deploy opt-in ON → the Fly arm releases the image.
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets(), allowFlyStaticDeploy: true });
    const grantWithImage: OrgGrant = {
      ...flyGrant,
      metadata: { ...flyGrant.metadata, image: "registry.fly.io/acme-web:deployment-1" },
    };
    await prov.provision(grantWithImage, ctx("acme-web"));

    const result = await prov.deploy(grantWithImage, "fly_app_1", { repo: "acme/acme-web", ref: "main" });
    const triggered = transport.deploysTriggered();
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.appId).toBe("acme-web");
    expect(triggered[0]!.body["config"]).toEqual({ image: "registry.fly.io/acme-web:deployment-1" });
    expect(result.url).toBe("https://acme-web.fly.dev");
    expect(result.deploymentId).toMatch(/^fly_deploy_/u);
  });

  it("deploy fails loud when no release image is configured", async () => {
    const transport = scriptedDeployTransport("fly");
    // Static-deploy opt-in ON so the failure under test is the missing image, not the gate.
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets(), allowFlyStaticDeploy: true });
    await prov.provision(flyGrant, ctx("acme-web"));
    // flyGrant carries no `image`, so the release has nothing to deploy.
    await expect(prov.deploy(flyGrant, "fly_app_1", { repo: "a/b", ref: "main" })).rejects.toThrow(/image/u);
  });
});
