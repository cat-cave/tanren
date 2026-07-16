import { testOrgGrant } from "../helpers/orgGrant.js";
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
import type { ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import { FlyDeployProvisioner, flyMachineConfig } from "../../src/engine/provisioners/flyDeployProvisioner.js";
import { scriptedDeployTransport } from "./fakes/scriptedDeployTransport.js";
import { projectIntegrationOperationTarget } from "../../src/engine/contracts/integrationAuthority.js";

const TOKEN_REF = "secret://org/deploy-token";
const TOKEN_VALUE = "fly_or_vercel_super_secret_token";

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: TOKEN_REF, value: TOKEN_VALUE });
  void store.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  void store.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  return store;
}

// `orgSlug: "tanren"` is the test-org slug; task #27 prefixes the created app with it, so
// projectName "acme-web" becomes the real app name "tanren-acme-web".
const ctx = (name: string): ProjectContext => ({
  projectId: `proj_${name}`,
  orgId: "org_1",
  orgSlug: "tanren",
  stack: "node",
  name,
});
const projectCtx = ctx("acme-web");
const source = { repo: "acme/acme-web", ref: "main" };
const metadata = { orgSlug: "acme", image: "registry.fly.io/tanren-acme-web:deadbeefcafe" };

const provisionGrant = () =>
  testOrgGrant({
    providerKind: "deploy.flyio",
    credentialRef: `${TOKEN_REF}/g/1`,
    metadata,
    capability: "deploy",
    operation: "provision",
    target: projectIntegrationOperationTarget(projectCtx),
    orgId: projectCtx.orgId,
    projectId: projectCtx.projectId,
  });

const deployGrant = () =>
  testOrgGrant({
    providerKind: "deploy.flyio",
    credentialRef: `${TOKEN_REF}/g/1`,
    metadata,
    capability: "deploy",
    operation: "deploy",
    target: { resourceId: "fly_app_1", sourceRepo: source.repo, sourceRef: source.ref },
    orgId: projectCtx.orgId,
    projectId: projectCtx.projectId,
  });

async function provisionApp(prov: FlyDeployProvisioner): Promise<void> {
  await prov.provision(await provisionGrant(), projectCtx);
}

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

function staticProv(transport: ReturnType<typeof scriptedDeployTransport>): FlyDeployProvisioner {
  return new FlyDeployProvisioner({ transport, secrets: secrets(), allowFlyStaticDeploy: true });
}

describe("FlyDeployProvisioner — shared-IPv4 allocation (triggerDeploy)", () => {
  it("allocates a shared IPv4 on the DEPLOY path (not createApp), so brownfield/bind apps route too", async () => {
    const transport = scriptedDeployTransport("fly");
    const prov = staticProv(transport);
    await provisionApp(prov);
    // createApp must NOT allocate — allocation on createApp would orphan the app on failure
    // and skip reused/`bind()` apps. It happens on triggerDeploy (every deploy path).
    expect(transport.allocateIpRequests()).toHaveLength(0);

    await prov.deploy(await deployGrant(), "fly_app_1", source);
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
    await provisionApp(prov);
    // shared_v4 is one-per-app: a duplicate-allocation error is the desired end state, so
    // triggerDeploy swallows it and the release proceeds (never a throw).
    await expect(prov.deploy(await deployGrant(), "fly_app_1", source)).resolves.toBeDefined();
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
    await provisionApp(prov);
    await expect(prov.deploy(await deployGrant(), "fly_app_1", source)).rejects.toThrow(
      /fly allocate shared IPv4 for/u,
    );
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
    await provisionApp(prov);
    // A batch where only SOME errors are duplicates means the allocation did NOT succeed.
    await expect(prov.deploy(await deployGrant(), "fly_app_1", source)).rejects.toThrow(
      /fly allocate shared IPv4 for/u,
    );
  });

  it("a malformed 2xx (no allocateIpAddress, no errors) throws — never an assumed-allocated", async () => {
    const transport = scriptedDeployTransport("fly");
    transport.scriptAllocateIpResponse({ status: 200, json: {} });
    const prov = staticProv(transport);
    await provisionApp(prov);
    await expect(prov.deploy(await deployGrant(), "fly_app_1", source)).rejects.toThrow(/malformed GraphQL 2xx/u);
  });

  it("a non-2xx from the GraphQL endpoint throws LOUD", async () => {
    const transport = scriptedDeployTransport("fly");
    transport.scriptAllocateIpResponse({ status: 503, json: {}, text: "upstream unavailable" });
    const prov = staticProv(transport);
    await provisionApp(prov);
    await expect(prov.deploy(await deployGrant(), "fly_app_1", source)).rejects.toThrow(
      /fly allocate shared IPv4 for/u,
    );
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
    await provisionApp(prov);
    let message = "";
    try {
      await prov.deploy(await deployGrant(), "fly_app_1", source);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/fly allocate shared IPv4 for 'tanren-acme-web'/u);
    expect(message).not.toContain(TOKEN_VALUE);
  });
});

describe("FlyDeployProvisioner — machine reap (single-instance convergence, triggerDeploy)", () => {
  // apex v96 root cause: Fly `POST /v1/apps/{app}/machines` CREATES a new machine on every
  // deploy and never retires the prior one, so over N deploys an app accumulates N machines —
  // fatal for a single-instance, file-backed app (each machine has its own local store, so the
  // data fragments across machines). `triggerDeploy` now reaps every machine but the newly-
  // created one, converging the app to exactly one machine per release. Driven over the scripted
  // in-memory transport — NO live Fly calls.

  it("reaps every PRIOR machine (force=true) and keeps ONLY the newly-created one", async () => {
    const transport = scriptedDeployTransport("fly");
    const prov = staticProv(transport);
    await provisionApp(prov);
    // Two prior releases each left their own machine behind (Fly never retires them).
    transport.seedMachines("tanren-acme-web", ["m_prior_1", "m_prior_2"]);

    const result = await prov.deploy(await deployGrant(), "fly_app_1", source);
    // The new release created + returned machine `fly_deploy_1` — the one the reap must KEEP.
    expect(result.deploymentId).toBe("fly_deploy_1");

    const deleted = transport.machinesDeleted();
    // The reap DELETEd every PRIOR machine — and NONE for the newly-created (kept) id.
    expect(deleted.map((d) => d.machineId).sort()).toEqual(["m_prior_1", "m_prior_2"]);
    expect(deleted.map((d) => d.machineId)).not.toContain("fly_deploy_1");
    // Every reap DELETE targeted this app and carried ?force=true.
    expect(deleted.every((d) => d.appName === "tanren-acme-web" && d.force)).toBe(true);
    // Convergence: the app is left with exactly the one new machine.
    expect(transport.machineIdsFor("tanren-acme-web")).toEqual(["fly_deploy_1"]);
  });

  it("issues NO reap DELETE when the app has only the newly-created machine (nothing prior)", async () => {
    const transport = scriptedDeployTransport("fly");
    const prov = staticProv(transport);
    await provisionApp(prov);
    // No seeded priors: the only machine after the release is the new one → nothing to reap.
    const result = await prov.deploy(await deployGrant(), "fly_app_1", source);
    expect(result.deploymentId).toBe("fly_deploy_1");
    expect(transport.machinesDeleted()).toHaveLength(0);
    expect(transport.machineIdsFor("tanren-acme-web")).toEqual(["fly_deploy_1"]);
  });

  it("a machines-LIST failure does NOT fail the deploy (reap is best-effort) — deploy still returns", async () => {
    const transport = scriptedDeployTransport("fly");
    transport.seedMachines("tanren-acme-web", ["m_prior_1"]);
    // The reap's `GET /machines` list read fails (non-2xx) → the reap returns early, but the
    // new release is already live, so the deploy STILL succeeds and no machine is deleted.
    transport.scriptMachinesListResponse({ status: 500, json: {}, text: "machines list unavailable" });
    const prov = staticProv(transport);
    await provisionApp(prov);

    const result = await prov.deploy(await deployGrant(), "fly_app_1", source);
    expect(result.deploymentId).toBe("fly_deploy_1");
    expect(transport.machinesDeleted()).toHaveLength(0);
  });

  it("a single reap DELETE rejecting does NOT fail the deploy and does NOT stop the other reaps", async () => {
    const transport = scriptedDeployTransport("fly");
    const prov = staticProv(transport);
    await provisionApp(prov);
    transport.seedMachines("tanren-acme-web", ["m_prior_1", "m_prior_2"]);
    // The DELETE of one prior machine rejects at the transport — best-effort per DELETE, so the
    // deploy still succeeds AND the other prior machine is still reaped.
    transport.throwOnMachineDelete("m_prior_1");

    const result = await prov.deploy(await deployGrant(), "fly_app_1", source);
    expect(result.deploymentId).toBe("fly_deploy_1");
    // The surviving-attempt DELETE (m_prior_2) was still recorded; the rejected one was not.
    expect(transport.machinesDeleted().map((d) => d.machineId)).toEqual(["m_prior_2"]);
  });
});
