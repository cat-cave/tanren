// Fly Machines RELEASE CONFIG + shared-IPv4 allocation specifics, split out of
// deployProvisioner.test.ts to keep that file under the 500-line architecture cap (same
// pattern as deployProvisionerDestroyApp.test.ts). Two load-bearing changes for a Fly
// release to be REACHABLE at `https://<app>.fly.dev`:
//  1. The machine config carries `services` (edge ports 80/443 → internal_port 3000) +
//     `guest` + an HTTP `checks` entry — pinned here by value via `flyMachineConfig`.
//  2. `triggerDeploy` (NOT createApp) allocates a shared IPv4 via the Fly GraphQL API
//     (`allocateIpAddress`, type `shared_v4`) — on EVERY deploy path (greenfield,
//     brownfield-reuse, `bind()`), idempotently. Pinned here: the request reaches
//     `https://api.fly.io/graphql` with the right mutation + variables; a duplicate
//     "already has a shared IPv4" error is swallowed ONLY when EVERY error is a duplicate;
//     a mixed batch, a malformed 2xx, any other GraphQL error, or a non-2xx throws LOUD.
// Driven over the scripted in-memory transport — NO live Fly calls or credentials in CI.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { OrgGrant, ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import { FlyDeployProvisioner, flyMachineConfig } from "../../src/engine/provisioners/flyDeployProvisioner.js";
import { scriptedDeployTransport } from "./fakes/scriptedDeployTransport.js";

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

// `orgSlug: "tanren"` is the test-org slug; task #27 prefixes the created app with it, so
// projectName "acme-web" becomes the real app name "tanren-acme-web".
const ctx = (name: string): ProjectContext => ({
  projectId: `proj_${name}`,
  orgId: "org_1",
  orgSlug: "tanren",
  stack: "node",
  name,
});

describe("flyMachineConfig (release config shape)", () => {
  it("carries the image + guest + port-mapped services (80/443 → 3000) + an HTTP check", () => {
    const config = flyMachineConfig("registry.fly.io/acme-web:deployment-1");
    expect(config["image"]).toBe("registry.fly.io/acme-web:deployment-1");
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
    expect(config["checks"]).toEqual({
      httpget: {
        type: "http",
        port: 3000,
        method: "get",
        path: "/",
        interval: "15s",
        timeout: "10s",
        grace_period: "10s",
      },
    });
  });
});

// grant carrying a release image + a provisioner with the static-deploy opt-in ON, so the
// deploy path reaches `triggerDeploy` (where allocation now lives).
const flyGrantWithImage: OrgGrant = {
  ...flyGrant,
  metadata: { ...flyGrant.metadata, image: "registry.fly.io/acme-web:deployment-1" },
};
function staticProv(transport: ReturnType<typeof scriptedDeployTransport>): FlyDeployProvisioner {
  return new FlyDeployProvisioner({ transport, secrets: secrets(), allowFlyStaticDeploy: true });
}
const source = { repo: "acme/acme-web", ref: "main" };

describe("FlyDeployProvisioner — shared-IPv4 allocation (triggerDeploy)", () => {
  it("allocates a shared IPv4 on the DEPLOY path (not createApp), so brownfield/bind apps route too", async () => {
    const transport = scriptedDeployTransport("fly");
    const prov = staticProv(transport);
    await prov.provision(flyGrantWithImage, ctx("acme-web"));
    // createApp must NOT allocate — allocation on createApp would orphan the app on failure
    // and skip reused/`bind()` apps. It happens on triggerDeploy (every deploy path).
    expect(transport.allocateIpRequests()).toHaveLength(0);

    await prov.deploy(flyGrantWithImage, "fly_app_1", source);
    const requests = transport.allocateIpRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.fly.io/graphql");
    // The mutation hits `allocateIpAddress` with an AllocateIPAddressInput whose `appId`
    // is the namespaced app name + `type: "shared_v4"` (verified against Fly's public
    // GraphQL schema — flyctl's gql/schema.graphql).
    expect(requests[0]!.body["query"]).toMatch(/allocateIpAddress/u);
    expect(requests[0]!.body["variables"]).toEqual({ input: { appId: "tanren-acme-web", type: "shared_v4" } });
    // The deploy token is the bearer for the GraphQL call too (never a separate cred).
    expect(transport.bearersSeen).toContain(`Bearer ${TOKEN_VALUE}`);
  });

  it("a duplicate 'already has a shared IPv4' GraphQL error is swallowed (idempotent) → deploy SUCCEEDS", async () => {
    const transport = scriptedDeployTransport("fly");
    transport.scriptAllocateIpResponse({
      status: 200,
      json: { errors: [{ message: "Validation failed: App already has a shared IPv4 address" }] },
    });
    const prov = staticProv(transport);
    await prov.provision(flyGrantWithImage, ctx("acme-web"));
    // shared_v4 is one-per-app: a duplicate-allocation error is the desired end state, so
    // triggerDeploy swallows it and the release proceeds (never a throw).
    await expect(prov.deploy(flyGrantWithImage, "fly_app_1", source)).resolves.toBeDefined();
    expect(transport.allocateIpRequests()).toHaveLength(1);
  });

  it("a QUOTA error that merely contains 'already' + 'allocation' is NOT swallowed → throws", async () => {
    // Regression guard for the over-broad regex: "already reached your IP allocation limit"
    // is a real failure (NO IP allocated) — it lacks a shared-v4 phrase, so it must NOT be
    // mistaken for the idempotent duplicate.
    const transport = scriptedDeployTransport("fly");
    transport.scriptAllocateIpResponse({
      status: 200,
      json: { errors: [{ message: "You have already reached your IP allocation limit for this organization" }] },
    });
    const prov = staticProv(transport);
    await prov.provision(flyGrantWithImage, ctx("acme-web"));
    await expect(prov.deploy(flyGrantWithImage, "fly_app_1", source)).rejects.toThrow(/fly allocate shared IPv4 for/u);
  });

  it("a MIXED error batch (one duplicate + one real error) throws — every-not-some", async () => {
    const transport = scriptedDeployTransport("fly");
    transport.scriptAllocateIpResponse({
      status: 200,
      json: {
        errors: [
          { message: "App already has a shared IPv4 address" },
          { message: "not authorized to access this app" },
        ],
      },
    });
    const prov = staticProv(transport);
    await prov.provision(flyGrantWithImage, ctx("acme-web"));
    // A batch where only SOME errors are duplicates means the allocation did NOT succeed.
    await expect(prov.deploy(flyGrantWithImage, "fly_app_1", source)).rejects.toThrow(/fly allocate shared IPv4 for/u);
  });

  it("a malformed 2xx (no allocateIpAddress, no errors) throws — never an assumed-allocated", async () => {
    const transport = scriptedDeployTransport("fly");
    transport.scriptAllocateIpResponse({ status: 200, json: {} });
    const prov = staticProv(transport);
    await prov.provision(flyGrantWithImage, ctx("acme-web"));
    await expect(prov.deploy(flyGrantWithImage, "fly_app_1", source)).rejects.toThrow(/malformed GraphQL 2xx/u);
  });

  it("a non-2xx from the GraphQL endpoint throws LOUD", async () => {
    const transport = scriptedDeployTransport("fly");
    transport.scriptAllocateIpResponse({ status: 503, json: {}, text: "upstream unavailable" });
    const prov = staticProv(transport);
    await prov.provision(flyGrantWithImage, ctx("acme-web"));
    await expect(prov.deploy(flyGrantWithImage, "fly_app_1", source)).rejects.toThrow(/fly allocate shared IPv4 for/u);
  });

  it("the deploy token VALUE is never interpolated into an allocate error message", async () => {
    // Mirror the file's "only KEYS in errors" discipline: the token is a bearer ONLY; an
    // allocate failure must name the app + the GraphQL error, NEVER the token value.
    const transport = scriptedDeployTransport("fly");
    transport.scriptAllocateIpResponse({
      status: 200,
      json: { errors: [{ message: "forbidden: scope ip:write missing" }] },
    });
    const prov = staticProv(transport);
    await prov.provision(flyGrantWithImage, ctx("acme-web"));
    let message = "";
    try {
      await prov.deploy(flyGrantWithImage, "fly_app_1", source);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/fly allocate shared IPv4 for 'tanren-acme-web'/u);
    expect(message).not.toContain(TOKEN_VALUE);
  });
});
