import { describe, expect, it } from "vitest";
import { testOrgGrant } from "../helpers/orgGrant.js";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import { projectIntegrationOperationTarget } from "../../src/engine/contracts/integrationAuthority.js";
import { FlyDeployProvisioner } from "../../src/engine/provisioners/flyDeployProvisioner.js";
import { VercelDeployProvisioner } from "../../src/engine/provisioners/vercelDeployProvisioner.js";
import { DEPLOY_APP_NAME_MAX_LEN, deployAppName } from "../../src/engine/provisioners/deployProvisioner.js";
import { scriptedDeployTransport } from "./fakes/scriptedDeployTransport.js";

const TOKEN_REF = "secret://org/deploy-token";
const TOKEN_VALUE = "fly_or_vercel_super_secret_token";

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  return store;
}

const ctx = (name: string): ProjectContext => ({
  projectId: `proj_${name}`,
  orgId: "org_1",
  orgSlug: "tanren",
  stack: "node",
  name,
});

const providerMetadata = (kind: "deploy.vercel" | "deploy.flyio") =>
  kind === "deploy.vercel" ? { teamId: "team_abc", slug: "acme" } : { orgSlug: "acme" };

const provisionGrant = (kind: "deploy.vercel" | "deploy.flyio", projectCtx: ProjectContext) =>
  testOrgGrant({
    providerKind: kind,
    credentialRef: `${TOKEN_REF}/g/1`,
    metadata: providerMetadata(kind),
    capability: "deploy",
    operation: "provision",
    target: projectIntegrationOperationTarget(projectCtx),
    orgId: projectCtx.orgId,
    projectId: projectCtx.projectId,
  });

const nameForOrg =
  (orgSlug: string) =>
  (name: string): string =>
    deployAppName({ projectId: `proj_${name}`, orgId: "org_1", orgSlug, name });

describe("deploy-app namespacing (task #27 — global-collision fix)", () => {
  describe("deployAppName helper", () => {
    it("always prefixes with the org slug, regardless of projectName shape", () => {
      const base = nameForOrg("cat-cave");
      expect(base("linkly")).toBe("cat-cave-linkly");
      expect(base("My App!")).toBe("cat-cave-my-app");
      expect(base("ALREADY-LOWER")).toBe("cat-cave-already-lower");
    });

    it("different orgs yield different namespaced names", () => {
      const first = { projectId: "p1", orgId: "o1", orgSlug: "cat-cave", name: "linkly" };
      const second = { projectId: "p2", orgId: "o2", orgSlug: "trevor-wieland", name: "linkly" };
      expect(deployAppName(first)).toBe("cat-cave-linkly");
      expect(deployAppName(second)).toBe("trevor-wieland-linkly");
      expect(deployAppName(first)).not.toBe(deployAppName(second));
    });

    it("fails loud when orgSlug is missing or empty", () => {
      expect(() => deployAppName({ projectId: "p1", orgId: "o1", orgSlug: "", name: "linkly" })).toThrow(
        /ProjectContext\.orgSlug is required/u,
      );
      expect(() => deployAppName({ projectId: "p1", orgId: "o1", orgSlug: "   ", name: "linkly" })).toThrow(
        /ProjectContext\.orgSlug is required/u,
      );
    });

    it("truncates the project component, never the org prefix, at Fly's cap", () => {
      const shortOrg = "cat-cave";
      const longName = "this-is-an-extremely-long-project-name";
      const namespaced = deployAppName({ projectId: "p1", orgId: "o1", orgSlug: shortOrg, name: longName });
      expect(namespaced.length).toBeLessThanOrEqual(DEPLOY_APP_NAME_MAX_LEN);
      expect(namespaced.startsWith(`${shortOrg}-`)).toBe(true);
      const second = deployAppName({
        projectId: "p2",
        orgId: "o1",
        orgSlug: shortOrg,
        name: `${longName}-other`,
      });
      expect(second.length).toBeLessThanOrEqual(DEPLOY_APP_NAME_MAX_LEN);
      expect(second.startsWith(`${shortOrg}-`)).toBe(true);
      expect(namespaced).not.toBe(second);
    });

    it("truncation is deterministic", () => {
      const input = { projectId: "p1", orgId: "o1", orgSlug: "cat-cave", name: "an-extremely-long-project-name-here" };
      expect(deployAppName(input)).toBe(deployAppName(input));
    });

    it("produces a hostname-safe slug", () => {
      const shapes = [
        deployAppName({ projectId: "p1", orgId: "o1", orgSlug: "cat-cave", name: "linkly" }),
        deployAppName({ projectId: "p2", orgId: "o2", orgSlug: "tanren", name: "My_Cool App!" }),
        deployAppName({
          projectId: "p3",
          orgId: "o3",
          orgSlug: "cat-cave",
          name: "this-is-an-extremely-long-project-name",
        }),
      ];
      for (const slug of shapes) {
        expect(slug).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u);
        expect(slug.length).toBeLessThanOrEqual(DEPLOY_APP_NAME_MAX_LEN);
      }
    });

    it("fails loud when the org slug leaves no project/hash budget", () => {
      expect(() =>
        deployAppName({
          projectId: "p1",
          orgId: "o1",
          orgSlug: "this-is-way-too-long-an-org-slug-name",
          name: "x",
        }),
      ).toThrow(/org slug .* is too long/u);
    });
  });

  describe("provider create calls", () => {
    it("Fly receives the prefixed name", async () => {
      const transport = scriptedDeployTransport("fly");
      const prov = new FlyDeployProvisioner({ transport, secrets: secrets() });
      const projectCtx = ctx("linkly");
      await prov.provision(await provisionGrant("deploy.flyio", projectCtx), projectCtx);
      expect(transport.appNames()).toEqual(["tanren-linkly"]);
    });

    it("Vercel receives the prefixed name", async () => {
      const transport = scriptedDeployTransport("vercel");
      const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
      const projectCtx = ctx("linkly");
      await prov.provision(await provisionGrant("deploy.vercel", projectCtx), projectCtx);
      expect(transport.appNames()).toEqual(["tanren-linkly"]);
    });

    it("persists deployAppName for both providers", async () => {
      const projectCtx = ctx("linkly");
      const fly = new FlyDeployProvisioner({ transport: scriptedDeployTransport("fly"), secrets: secrets() });
      const flyArtifact = await fly.provision(await provisionGrant("deploy.flyio", projectCtx), projectCtx);
      expect(flyArtifact.projectConfig?.["deployAppName"]).toBe("tanren-linkly");
      const vercel = new VercelDeployProvisioner({
        transport: scriptedDeployTransport("vercel"),
        secrets: secrets(),
      });
      const vercelArtifact = await vercel.provision(await provisionGrant("deploy.vercel", projectCtx), projectCtx);
      expect(vercelArtifact.projectConfig?.["deployAppName"]).toBe("tanren-linkly");
    });

    it("uses the prefixed Fly preview URL", async () => {
      const prov = new FlyDeployProvisioner({ transport: scriptedDeployTransport("fly"), secrets: secrets() });
      const projectCtx = ctx("linkly");
      const artifact = await prov.provision(await provisionGrant("deploy.flyio", projectCtx), projectCtx);
      expect(artifact.deployRef?.previewUrlPattern).toBe("https://tanren-linkly.fly.dev");
    });

    it("uses the prefixed Vercel preview URL", async () => {
      const prov = new VercelDeployProvisioner({ transport: scriptedDeployTransport("vercel"), secrets: secrets() });
      const projectCtx = ctx("linkly");
      const artifact = await prov.provision(await provisionGrant("deploy.vercel", projectCtx), projectCtx);
      expect(artifact.deployRef?.previewUrlPattern).toBe("https://tanren-linkly-git-{branch}-acme.vercel.app");
    });

    it("reuses a discovered namespaced Fly app without suffix retry", async () => {
      const transport = scriptedDeployTransport("fly", ["tanren-linkly"]);
      const prov = new FlyDeployProvisioner({ transport, secrets: secrets() });
      const projectCtx = ctx("linkly");
      await prov.provision(await provisionGrant("deploy.flyio", projectCtx), projectCtx);
      expect(transport.appNames()).toEqual(["tanren-linkly"]);
    });

    it("a direct Fly duplicate-name reject stays loud", async () => {
      const transport = scriptedDeployTransport("fly", ["tanren-linkly"]);
      const result = await transport.request({
        method: "POST",
        url: "https://api.machines.dev/v1/apps",
        headers: { authorization: "Bearer t" },
        body: { app_name: "tanren-linkly", org_slug: "acme" },
      });
      expect(result.ok).toBe(false);
      expect([409, 422]).toContain(result.status);
    });
  });
});
