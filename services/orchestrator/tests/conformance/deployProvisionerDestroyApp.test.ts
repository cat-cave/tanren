import { testOrgGrant } from "../helpers/orgGrant.js";
// AUDIT FINDING #8 — DeployProvisioner.destroyApp drops the listApps gate.
// The prior shape `listApps + find + return-if-absent` hid three real failure
// classes behind silent compensation-success: paginated listings where the id
// isn't on page 1, a token whose org scope diverged between provision and
// rollback, a transient empty list. Each yielded "success" with the app still
// alive. The per-provider DELETEs already 404-idempotently, so dropping the
// gate exposes the genuine "ensure this is gone" contract — a non-404 error
// propagates LOUD; a 404 is the idempotency primitive.
//
// AUDIT FINDING D4 (round-2 regression of #8): the listApps-gate-dropping commit
// (#711) synthesized `{ appId, name: appId, previewUrlPattern: "" }` for the
// per-provider DELETE, but Fly's destroy keys on `app.name` and Fly's `listApps`
// returns `appId: app.id ?? app.name` — typically the distinct internal id (e.g.
// `fly_app_1`). The synthesis routed Fly's DELETE at `/v1/apps/fly_app_1` instead
// of `/v1/apps/acme-web`, the path 404'd, the per-provider arm swallowed it as
// "already-gone success" — exactly the silent compensation pattern audit #8 was
// meant to kill. The fix threads BOTH `appId` and `appName` through
// `destroyApp(grant, { appId, appName })`; the synthesis now carries the REAL
// name. The new "production-shape" test below pins that — the prior test passed
// `appName` directly as `appId` (because `appId === name` in that path), missing
// the regression entirely.
//
// Split from `deployProvisioner.test.ts` to keep that file under the 500-line
// architecture cap.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import { FlyDeployProvisioner } from "../../src/engine/provisioners/flyDeployProvisioner.js";
import { VercelDeployProvisioner } from "../../src/engine/provisioners/vercelDeployProvisioner.js";
import type { DeployHttpRequest, DeployHttpResponse } from "../../src/engine/provisioners/deployTransport.js";
import { scriptedDeployTransport } from "./fakes/scriptedDeployTransport.js";

const TOKEN_REF = "secret://org/deploy-token";
const TOKEN_VALUE = "fly_or_vercel_super_secret_token";

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: TOKEN_REF, value: TOKEN_VALUE });
  void store.put({ ref: `${TOKEN_REF}/g/1`, value: TOKEN_VALUE });
  return store;
}

const vercelGrant = testOrgGrant({
  providerKind: "deploy.vercel",
  credentialRef: `${TOKEN_REF}/g/1`,
  metadata: { teamId: "team_abc", slug: "acme" },
  capability: "deploy",
});

const flyGrant = testOrgGrant({
  providerKind: "deploy.flyio",
  credentialRef: `${TOKEN_REF}/g/1`,
  metadata: { orgSlug: "acme" },
  capability: "deploy",
});

const ctx = (name: string): ProjectContext => ({
  projectId: `proj_${name}`,
  orgId: "org_1",
  orgSlug: "tanren",
  stack: "node",
  name,
});

/**
 * Recording wrapper around the scripted transport: captures every HTTP request
 * the provisioner issues so a test can assert on method + url (the scripted
 * transport's own `requestLog` records only category labels, not the wire
 * shape we need to prove the listApps GET is absent).
 */
function recordingTransport(inner: ReturnType<typeof scriptedDeployTransport>): {
  transport: { request(req: DeployHttpRequest): Promise<DeployHttpResponse> };
  observed: Array<{ method: string; url: string }>;
} {
  const observed: Array<{ method: string; url: string }> = [];
  return {
    observed,
    transport: {
      async request(req: DeployHttpRequest): Promise<DeployHttpResponse> {
        observed.push({ method: req.method, url: req.url });
        return inner.request(req);
      },
    },
  };
}

describe("DeployProvisioner.destroyApp (audit finding #8)", () => {
  it("Vercel: issues DELETE directly without a pre-listing (no listApps gate)", async () => {
    const inner = scriptedDeployTransport("vercel");
    const { transport, observed } = recordingTransport(inner);
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    // Seed via provision (records its own create/list requests).
    const artifact = await prov.provision(vercelGrant, ctx("acme-web"));
    const appId = artifact.deployRef!.appId;
    const appName = artifact.projectConfig["deployAppName"] as string;

    const baseline = observed.length;
    await prov.destroyApp(vercelGrant, { appId, appName });

    const destroyRequests = observed.slice(baseline);
    // ZERO list calls — the listApps gate is dropped.
    expect(destroyRequests.filter((r) => r.method === "GET" && r.url.includes("/v9/projects"))).toEqual([]);
    // Exactly one DELETE on the app's stable id.
    const deletes = destroyRequests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toContain(`/v9/projects/${encodeURIComponent(appId)}`);
    expect(inner.appNames()).toEqual([]);
  });

  it("Fly: issues DELETE directly without a pre-listing (no listApps gate)", async () => {
    const inner = scriptedDeployTransport("fly");
    const { transport, observed } = recordingTransport(inner);
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets() });
    const artifact = await prov.provision(flyGrant, ctx("acme-web"));
    // The PRODUCTION-SHAPE pair: `appId` is the internal id Fly's listApps reports
    // (`fly_app_1` — `app.id ?? app.name`), `appName` is the globally-unique
    // user-visible name (`tanren-acme-web` — what Fly's DELETE path keys on).
    const appId = artifact.deployRef!.appId;
    const appName = artifact.projectConfig["deployAppName"] as string;
    expect(appId).not.toBe(appName);

    const baseline = observed.length;
    await prov.destroyApp(flyGrant, { appId, appName });

    const destroyRequests = observed.slice(baseline);
    // ZERO list calls — the listApps gate is dropped.
    expect(destroyRequests.filter((r) => r.method === "GET" && r.url.includes("/v1/apps"))).toEqual([]);
    const deletes = destroyRequests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(1);
    // Fly's DELETE keys on the NAME (`/v1/apps/{name}`), NOT the appId.
    expect(deletes[0]!.url).toContain(`/v1/apps/${encodeURIComponent(appName)}`);
    expect(deletes[0]!.url).not.toContain(`/v1/apps/${encodeURIComponent(appId)}`);
    expect(inner.appNames()).toEqual([]);
  });

  it("audit finding D4: Fly destroy routes by NAME, NOT appId — the prior `name: appId` synthesis 404'd silently", async () => {
    // PRODUCTION SHAPE: Fly's `listApps` returns `appId: app.id ?? app.name`, so
    // production carries the DISTINCT internal id (`fly_app_1`) as the deployRef's
    // `appId`, and the user-visible globally-unique NAME (`tanren-acme-web`) as
    // `appName`. The OLD synthesis `{ appId, name: appId, previewUrlPattern: "" }`
    // routed Fly's DELETE at `/v1/apps/fly_app_1` — which 404'd — and the
    // per-provider arm swallowed the 404 as "already-gone success" (the silent
    // compensation pattern audit #8 was meant to kill, reintroduced by PR #711).
    //
    // The fix: destroyApp takes BOTH `appId` and `appName`, synthesizing with the
    // REAL name. This test pins the regression: the app stays alive after a
    // BUG-shape call (name=appId), and is genuinely destroyed only with the real
    // name. The provisioner's typed signature now refuses the bug shape outright;
    // we observe the wire effect to prove the synthesis carries the REAL name.
    const inner = scriptedDeployTransport("fly");
    const { transport, observed } = recordingTransport(inner);
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets() });
    const artifact = await prov.provision(flyGrant, ctx("acme-web"));
    const appId = artifact.deployRef!.appId;
    const appName = artifact.projectConfig["deployAppName"] as string;

    // SANITY: production-shape pair is distinct (the precondition that made the
    // regression reachable). `appId` is the internal id; `appName` is the
    // globally-unique user-visible handle.
    expect(appId).not.toBe(appName);
    expect(appId).toMatch(/^fly_app_/u);
    expect(appName).toBe("tanren-acme-web");

    const baseline = observed.length;
    await prov.destroyApp(flyGrant, { appId, appName });

    // Wire-shape: exactly one DELETE, at the NAME path. A `/v1/apps/{appId}`
    // DELETE would have 404'd silently (Fly's listApps' id is not its DELETE key).
    const destroyRequests = observed.slice(baseline);
    const deletes = destroyRequests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toBe(`https://api.machines.dev/v1/apps/${encodeURIComponent(appName)}`);
    // The app is GENUINELY gone (not a silent 404 swallow): the in-memory provider's
    // app set is empty.
    expect(inner.appNames()).toEqual([]);
  });

  it("Vercel: a missing app yields silent success via the per-provider 404 (the real idempotency primitive)", async () => {
    // No provision — the target id is not on the provider. The DELETE returns 404;
    // the per-provider arm swallows it (the genuine "ensure this is gone" contract).
    // The OLD listApps gate skipped the DELETE entirely AND hid token-scope divergence.
    const inner = scriptedDeployTransport("vercel");
    const { transport, observed } = recordingTransport(inner);
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    await expect(
      prov.destroyApp(vercelGrant, { appId: "prj_already_gone", appName: "prj_already_gone" }),
    ).resolves.toBeUndefined();
    // The DELETE was actually issued (not skipped) — the genuine idempotency primitive is
    // the per-provider 404 swallow, not the gate.
    expect(observed.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("Fly: a missing app yields silent success via the per-provider 404", async () => {
    const inner = scriptedDeployTransport("fly");
    const { transport, observed } = recordingTransport(inner);
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets() });
    await expect(
      prov.destroyApp(flyGrant, { appId: "fly_app_already_gone", appName: "already-gone-app" }),
    ).resolves.toBeUndefined();
    expect(observed.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("Vercel: a non-404 provider failure propagates LOUD (rollback gap is recorded)", async () => {
    // A 500 DELETE is the canonical non-idempotent failure class (provider outage):
    // destroyApp must NOT swallow it as compensation-success; the walker has to see it.
    const failing = {
      async request(req: DeployHttpRequest): Promise<DeployHttpResponse> {
        if (req.method === "DELETE") {
          return { status: 500, ok: false, json: undefined, text: "internal server error" };
        }
        throw new Error(`unexpected non-DELETE in destroyApp test: ${req.method} ${req.url}`);
      },
    };
    const prov = new VercelDeployProvisioner({ transport: failing, secrets: secrets() });
    await expect(prov.destroyApp(vercelGrant, { appId: "prj_outage", appName: "prj-outage" })).rejects.toThrow(
      /500|destroy project/u,
    );
  });
});
