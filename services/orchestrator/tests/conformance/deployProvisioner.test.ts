import { testOrgGrant } from "../helpers/orgGrant.js";
// Deploy-provisioner specifics beyond the shared IntegrationProvisioner
// conformance suite: the captured deployRef + preview-URL pattern, the idempotent
// find-or-create that NEVER creates a second app on re-provision, brownfield
// discover/bind, and — the load-bearing security property — that NO deploy-token
// VALUE ever leaks into the artifact (only a per-app alias ref). Driven over the
// scripted in-memory transport, so there are no live Vercel/Fly calls.
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import { FlyDeployProvisioner, flyMachineConfig } from "../../src/engine/provisioners/flyDeployProvisioner.js";
import { VercelDeployProvisioner } from "../../src/engine/provisioners/vercelDeployProvisioner.js";
import {
  projectIntegrationOperationTarget,
  type IntegrationOperationTarget,
} from "../../src/engine/contracts/integrationAuthority.js";
import { scriptedDeployTransport } from "./fakes/scriptedDeployTransport.js";
const TOKEN_REF = "secret://org/deploy-token";
const TOKEN_VALUE = "fly_or_vercel_super_secret_token";
function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: TOKEN_REF, value: TOKEN_VALUE });
  void store.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  void store.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  return store;
}
// `orgSlug: "tanren"` is the test-org slug; the deploy-app namespacing rule
// (task #27) always prefixes the created app with it, so the projectName
// "acme-web" becomes the real app name "tanren-acme-web". Distinct from the Fly
// grant's `orgSlug: "acme"` (which is the Fly-side org — a different namespace
// surface) on purpose, so the prefix is observably the TANREN org's slug and
// not an accidental match.
const ORG_SLUG = "tanren";
const ctx = (name: string): ProjectContext => ({
  projectId: `proj_${name}`,
  orgId: "org_1",
  orgSlug: ORG_SLUG,
  stack: "node",
  name,
});
const providerMetadata = (kind: "deploy.vercel" | "deploy.flyio") =>
  kind === "deploy.vercel" ? { teamId: "team_abc", slug: "acme" } : { orgSlug: "acme" };
async function operationGrant(
  kind: "deploy.vercel" | "deploy.flyio",
  operation: "discover" | "provision" | "bind" | "attach_runtime_env" | "deploy",
  target: IntegrationOperationTarget,
  projectCtx: ProjectContext = ctx("authority"),
  metadata: Record<string, unknown> = providerMetadata(kind),
) {
  return testOrgGrant({
    providerKind: kind,
    credentialRef: `${TOKEN_REF}/g/1`,
    metadata,
    capability: "deploy",
    operation,
    target,
    orgId: projectCtx.orgId,
    projectId: projectCtx.projectId,
  });
}
const provisionGrant = (
  kind: "deploy.vercel" | "deploy.flyio",
  projectCtx: ProjectContext,
  metadata?: Record<string, unknown>,
) => operationGrant(kind, "provision", projectIntegrationOperationTarget(projectCtx), projectCtx, metadata);
describe("VercelDeployProvisioner", () => {
  it("provision captures a deployRef + Vercel preview-URL pattern", async () => {
    const store = secrets();
    const transport = scriptedDeployTransport("vercel");
    const prov = new VercelDeployProvisioner({ transport, secrets: store });
    const projectCtx = ctx("acme-web");
    const artifact = await prov.provision(await provisionGrant("deploy.vercel", projectCtx), projectCtx);
    expect(artifact.deployRef?.provider).toBe("deploy.vercel");
    expect(artifact.deployRef?.appId).toMatch(/^vercel_app_/u);
    // task #27: the deploy app is namespaced `<tanrenOrgSlug>-<projectName>` —
    // the previewUrlPattern uses that prefixed name (not the bare projectName).
    expect(artifact.deployRef?.previewUrlPattern).toBe("https://tanren-acme-web-git-{branch}-acme.vercel.app");
    expect(artifact.projectConfig?.["previewUrlPattern"]).toBe("https://tanren-acme-web-git-{branch}-acme.vercel.app");
    // The env-attach seam is ABSENT until attachRuntimeAppEnv lands it —
    // the provisioner never writes a null placeholder (a config a strict read rejects).
    expect(artifact.projectConfig).not.toHaveProperty("envAttachmentRef");
  });
  it("provision is idempotent: a second run reuses the app, never creating a 2nd", async () => {
    const transport = scriptedDeployTransport("vercel");
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    const projectCtx = ctx("acme-web");
    const first = await prov.provision(await provisionGrant("deploy.vercel", projectCtx), projectCtx);
    const second = await prov.provision(await provisionGrant("deploy.vercel", projectCtx), projectCtx);
    // task #27: every Tanren-created deploy app is prefixed with the org slug.
    expect(transport.appNames()).toEqual(["tanren-acme-web"]);
    expect(second.deployRef?.appId).toBe(first.deployRef?.appId);
  });
  it("the artifact carries a token ALIAS ref, never the token value", async () => {
    const store = secrets();
    const prov = new VercelDeployProvisioner({ transport: scriptedDeployTransport("vercel"), secrets: store });
    const projectCtx = ctx("acme-web");
    const artifact = await prov.provision(await provisionGrant("deploy.vercel", projectCtx), projectCtx);
    const ref = artifact.secretRefs?.["deployToken"];
    expect(ref).toBeDefined();
    expect(ref).not.toContain(TOKEN_VALUE);
    expect(JSON.stringify(artifact)).not.toContain(TOKEN_VALUE);
    // The alias resolves to the org credential ref (a pointer), not the value.
    const alias = await store.get(ref as string);
    expect(alias?.value).toBe(`${TOKEN_REF}/g/1`);
    expect(alias?.value).not.toBe(TOKEN_VALUE);
  });
  it("the token value is used as a bearer but never echoed back", async () => {
    const transport = scriptedDeployTransport("vercel");
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    const projectCtx = ctx("acme-web");
    await prov.provision(await provisionGrant("deploy.vercel", projectCtx), projectCtx);
    expect(transport.bearersSeen).toContain(`Bearer ${TOKEN_VALUE}`);
  });
  it("discover lists existing projects; bind links one of them", async () => {
    const transport = scriptedDeployTransport("vercel", ["existing-proj"]);
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    const projectCtx = ctx("whatever");
    const discovered = await prov.discover(
      await operationGrant("deploy.vercel", "discover", {}, projectCtx),
      projectCtx,
    );
    expect(discovered.map((r) => r.label)).toContain("existing-proj");
    const bound = await prov.bind(
      await operationGrant(
        "deploy.vercel",
        "bind",
        projectIntegrationOperationTarget(projectCtx, discovered[0]!.id),
        projectCtx,
      ),
      discovered[0]!.id,
      projectCtx,
    );
    expect(bound.deployRef?.appId).toBe(discovered[0]!.id);
  });
  it("provision fails loud when the org credentialRef is absent from the store", async () => {
    const prov = new VercelDeployProvisioner({
      transport: scriptedDeployTransport("vercel"),
      secrets: new InMemorySecretStore(),
    });
    const projectCtx = ctx("acme-web");
    await expect(prov.provision(await provisionGrant("deploy.vercel", projectCtx), projectCtx)).rejects.toThrow(
      /missing integration secret for generation/u,
    );
  });
  it("attachRuntimeEnv sends each var to the Vercel env endpoint; the value reaches the transport", async () => {
    const transport = scriptedDeployTransport("vercel");
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    await prov.attachRuntimeEnv(
      await operationGrant("deploy.vercel", "attach_runtime_env", {
        resourceId: "prj_123",
        environment: "production",
      }),
      "prj_123",
      [
        { key: "RESEND_API_KEY", value: "re_live_xyz" },
        { key: "PUBLIC_URL", value: "https://app.example" },
      ],
    );
    expect(transport.envByApp()).toEqual({
      prj_123: { RESEND_API_KEY: "re_live_xyz", PUBLIC_URL: "https://app.example" },
    });
    // The deploy token is the bearer; the env VALUES are never used as a bearer.
    expect(transport.bearersSeen).toContain(`Bearer ${TOKEN_VALUE}`);
  });
  it("attachRuntimeEnv with no vars makes no provider call", async () => {
    const transport = scriptedDeployTransport("vercel");
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    await prov.attachRuntimeEnv(
      await operationGrant("deploy.vercel", "attach_runtime_env", {
        resourceId: "prj_123",
        environment: "production",
      }),
      "prj_123",
      [],
    );
    expect(transport.bearersSeen).toEqual([]);
    expect(transport.envByApp()).toEqual({});
  });
  it("deploy TRIGGERS a build of the merged ref + returns a resolved URL", async () => {
    const transport = scriptedDeployTransport("vercel");
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    // The app must exist (provision created it) before a deploy is triggered.
    const projectCtx = ctx("acme-web");
    const artifact = await prov.provision(await provisionGrant("deploy.vercel", projectCtx), projectCtx);
    const appId = artifact.deployRef!.appId;
    const source = { repo: "acme/acme-web", ref: "deadbeefcafe" };
    const result = await prov.deploy(
      await operationGrant("deploy.vercel", "deploy", {
        resourceId: appId,
        sourceRepo: source.repo,
        sourceRef: source.ref,
      }),
      appId,
      source,
    );
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
    const projectCtx = ctx("acme-web");
    const artifact = await prov.provision(await provisionGrant("deploy.vercel", projectCtx), projectCtx);
    const appId = artifact.deployRef!.appId;
    const source = { repo: "acme/acme-web", ref: "deadbeefcafe" };
    await prov.deploy(
      await operationGrant("deploy.vercel", "deploy", {
        resourceId: appId,
        sourceRepo: source.repo,
        sourceRef: source.ref,
      }),
      appId,
      source,
    );
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
    const projectCtx = ctx("acme-web");
    const artifact = await prov.provision(await provisionGrant("deploy.vercel", projectCtx), projectCtx);
    const appId = artifact.deployRef!.appId;
    const source = { repo: "no-owner", ref: "abc123" };
    await expect(
      prov.deploy(
        await operationGrant("deploy.vercel", "deploy", {
          resourceId: appId,
          sourceRepo: source.repo,
          sourceRef: source.ref,
        }),
        appId,
        source,
      ),
    ).rejects.toThrow(/not a valid 'owner\/name'/u);
  });
  it("deploy fails loud for an unknown app id (never a silent no-op)", async () => {
    const prov = new VercelDeployProvisioner({ transport: scriptedDeployTransport("vercel"), secrets: secrets() });
    const source = { repo: "a/b", ref: "main" };
    await expect(
      prov.deploy(
        await operationGrant("deploy.vercel", "deploy", {
          resourceId: "prj_missing",
          sourceRepo: source.repo,
          sourceRef: source.ref,
        }),
        "prj_missing",
        source,
      ),
    ).rejects.toThrow(/cannot deploy unknown app/u);
  });
});
describe("FlyDeployProvisioner", () => {
  it("provision captures a deployRef + Fly preview-URL pattern", async () => {
    const prov = new FlyDeployProvisioner({ transport: scriptedDeployTransport("fly"), secrets: secrets() });
    const projectCtx = ctx("acme-web");
    const artifact = await prov.provision(await provisionGrant("deploy.flyio", projectCtx), projectCtx);
    expect(artifact.deployRef?.provider).toBe("deploy.flyio");
    // task #27: the Fly app + preview URL are namespaced with the tanren org slug.
    expect(artifact.deployRef?.previewUrlPattern).toBe("https://tanren-acme-web.fly.dev");
    expect(artifact.projectConfig?.["deployProvider"]).toBe("deploy.flyio");
    expect(artifact.projectConfig?.["deployAppName"]).toBe("tanren-acme-web");
  });
  it("provision is idempotent: a second run reuses the app, never creating a 2nd", async () => {
    const transport = scriptedDeployTransport("fly");
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets() });
    const projectCtx = ctx("acme-web");
    await prov.provision(await provisionGrant("deploy.flyio", projectCtx), projectCtx);
    await prov.provision(await provisionGrant("deploy.flyio", projectCtx), projectCtx);
    // task #27: the namespaced name is the idempotency key.
    expect(transport.appNames()).toEqual(["tanren-acme-web"]);
  });
  it("the artifact carries a token alias ref, never the token value", async () => {
    const prov = new FlyDeployProvisioner({ transport: scriptedDeployTransport("fly"), secrets: secrets() });
    const projectCtx = ctx("acme-web");
    const artifact = await prov.provision(await provisionGrant("deploy.flyio", projectCtx), projectCtx);
    expect(JSON.stringify(artifact)).not.toContain(TOKEN_VALUE);
    expect(artifact.secretRefs?.["deployToken"]).toMatch(/^secret:\/\/deploy\/deploy\.flyio\//u);
  });
  it("requires orgSlug in the grant metadata (fails loud)", async () => {
    const prov = new FlyDeployProvisioner({ transport: scriptedDeployTransport("fly"), secrets: secrets() });
    const projectCtx = ctx("acme-web");
    const noOrg = await provisionGrant("deploy.flyio", projectCtx, {});
    await expect(prov.provision(noOrg, projectCtx)).rejects.toThrow(/orgSlug/u);
  });
  it("discover lists existing apps; bind links one of them", async () => {
    const transport = scriptedDeployTransport("fly", ["existing-app"]);
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets() });
    const projectCtx = ctx("whatever");
    const discovered = await prov.discover(
      await operationGrant("deploy.flyio", "discover", {}, projectCtx),
      projectCtx,
    );
    expect(discovered.map((r) => r.label)).toContain("existing-app");
    const bound = await prov.bind(
      await operationGrant(
        "deploy.flyio",
        "bind",
        projectIntegrationOperationTarget(projectCtx, discovered[0]!.id),
        projectCtx,
      ),
      discovered[0]!.id,
      projectCtx,
    );
    expect(bound.deployRef?.appId).toBe(discovered[0]!.id);
  });
  it("attachRuntimeEnv sets the app's Fly secrets in one call; the values reach the transport", async () => {
    const transport = scriptedDeployTransport("fly");
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets() });
    await prov.attachRuntimeEnv(
      await operationGrant("deploy.flyio", "attach_runtime_env", {
        resourceId: "acme-web",
        environment: "production",
      }),
      "acme-web",
      [
        { key: "RESEND_API_KEY", value: "re_live_xyz" },
        { key: "DATABASE_URL", value: "postgres://secret" },
      ],
    );
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
    await expect(
      prov.attachRuntimeEnv(
        await operationGrant("deploy.flyio", "attach_runtime_env", {
          resourceId: "acme-web",
          environment: "production",
        }),
        "acme-web",
        [{ key: "K", value: "v" }],
      ),
    ).rejects.toThrow(/missing integration secret for generation/u);
  });
  it("deploy is NOT merge-reflecting: fails loud without the explicit static-deploy opt-in", async () => {
    // The Fly arm releases a static image + ignores the merged source, so it cannot
    // prove "the live product reflects this merge" — it MUST refuse unless the operator
    // explicitly accepts the static-image semantics (so apex never proves deploy on Fly).
    const transport = scriptedDeployTransport("fly");
    // Static-deploy opt-in OFF (the default) → the Fly arm must refuse.
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets(), allowFlyStaticDeploy: false });
    const projectCtx = ctx("acme-web");
    const metadata = { ...providerMetadata("deploy.flyio"), image: "registry.fly.io/acme-web:deployment-1" };
    await prov.provision(await provisionGrant("deploy.flyio", projectCtx, metadata), projectCtx);
    const source = { repo: "acme/acme-web", ref: "main" };
    await expect(
      prov.deploy(
        await operationGrant(
          "deploy.flyio",
          "deploy",
          { resourceId: "fly_app_1", sourceRepo: source.repo, sourceRef: source.ref },
          projectCtx,
          metadata,
        ),
        "fly_app_1",
        source,
      ),
    ).rejects.toThrow(/NOT merge-reflecting/u);
  });
  it("deploy TRIGGERS a Machines release of the app's image + returns the app URL (static-deploy opt-in)", async () => {
    const transport = scriptedDeployTransport("fly");
    // Static-deploy opt-in ON → the Fly arm releases the image.
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets(), allowFlyStaticDeploy: true });
    const projectCtx = ctx("acme-web");
    const metadata = { ...providerMetadata("deploy.flyio"), image: "registry.fly.io/acme-web:deployment-1" };
    await prov.provision(await provisionGrant("deploy.flyio", projectCtx, metadata), projectCtx);
    const source = { repo: "acme/acme-web", ref: "main" };
    const result = await prov.deploy(
      await operationGrant(
        "deploy.flyio",
        "deploy",
        { resourceId: "fly_app_1", sourceRepo: source.repo, sourceRef: source.ref },
        projectCtx,
        metadata,
      ),
      "fly_app_1",
      source,
    );
    const triggered = transport.deploysTriggered();
    expect(triggered).toHaveLength(1);
    // task #27: the Fly app's name in the path is the namespaced slug.
    expect(triggered[0]!.appId).toBe("tanren-acme-web");
    // The release body now carries the full Machines config (services/ports/checks/guest); the explicit shape is pinned in flyDeployReleaseConfig.test.ts.
    expect(triggered[0]!.body["config"]).toEqual(flyMachineConfig("registry.fly.io/acme-web:deployment-1"));
    expect(result.url).toBe("https://tanren-acme-web.fly.dev");
    expect(result.deploymentId).toMatch(/^fly_deploy_/u);
  });
  it("deploy fails loud when no release image is configured", async () => {
    const transport = scriptedDeployTransport("fly");
    // Static-deploy opt-in ON so the failure under test is the missing image, not the gate.
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets(), allowFlyStaticDeploy: true });
    const projectCtx = ctx("acme-web");
    await prov.provision(await provisionGrant("deploy.flyio", projectCtx), projectCtx);
    const source = { repo: "a/b", ref: "main" };
    // The operation lease carries no `image`, so the release has nothing to deploy.
    await expect(
      prov.deploy(
        await operationGrant(
          "deploy.flyio",
          "deploy",
          { resourceId: "fly_app_1", sourceRepo: source.repo, sourceRef: source.ref },
          projectCtx,
        ),
        "fly_app_1",
        source,
      ),
    ).rejects.toThrow(/image/u);
  });
});
