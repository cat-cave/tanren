// AUDIT FINDING #8 — DeployProvisioner.destroyApp drops the listApps gate.
// The prior shape `listApps + find + return-if-absent` hid three real failure
// classes behind silent compensation-success: paginated listings where the id
// isn't on page 1, a token whose org scope diverged between provision and
// rollback, a transient empty list. Each yielded "success" with the app still
// alive. The per-provider DELETEs already 404-idempotently, so dropping the
// gate exposes the genuine "ensure this is gone" contract — a non-404 error
// propagates LOUD; a 404 is the idempotency primitive.
//
// Split from `deployProvisioner.test.ts` to keep that file under the 500-line
// architecture cap.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { OrgGrant, ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import { FlyDeployProvisioner } from "../../src/engine/provisioners/flyDeployProvisioner.js";
import { VercelDeployProvisioner } from "../../src/engine/provisioners/vercelDeployProvisioner.js";
import type { DeployHttpRequest, DeployHttpResponse } from "../../src/engine/provisioners/deployTransport.js";
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

    const baseline = observed.length;
    await prov.destroyApp(vercelGrant, appId);

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
    await prov.provision(flyGrant, ctx("acme-web"));
    // Fly identifies apps by their globally-unique NAME — the appId IS the name.
    const appName = inner.appNames()[0]!;

    const baseline = observed.length;
    await prov.destroyApp(flyGrant, appName);

    const destroyRequests = observed.slice(baseline);
    // ZERO list calls — the listApps gate is dropped.
    expect(destroyRequests.filter((r) => r.method === "GET" && r.url.includes("/v1/apps"))).toEqual([]);
    const deletes = destroyRequests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toContain(`/v1/apps/${encodeURIComponent(appName)}`);
    expect(inner.appNames()).toEqual([]);
  });

  it("Vercel: a missing app yields silent success via the per-provider 404 (the real idempotency primitive)", async () => {
    // No provision — the target id is not on the provider. The DELETE returns 404;
    // the per-provider arm swallows it (the genuine "ensure this is gone" contract).
    // The OLD listApps gate skipped the DELETE entirely AND hid token-scope divergence.
    const inner = scriptedDeployTransport("vercel");
    const { transport, observed } = recordingTransport(inner);
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    await expect(prov.destroyApp(vercelGrant, "prj_already_gone")).resolves.toBeUndefined();
    // The DELETE was actually issued (not skipped) — the genuine idempotency primitive is
    // the per-provider 404 swallow, not the gate.
    expect(observed.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("Fly: a missing app yields silent success via the per-provider 404", async () => {
    const inner = scriptedDeployTransport("fly");
    const { transport, observed } = recordingTransport(inner);
    const prov = new FlyDeployProvisioner({ transport, secrets: secrets() });
    await expect(prov.destroyApp(flyGrant, "already-gone-app")).resolves.toBeUndefined();
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
    await expect(prov.destroyApp(vercelGrant, "prj_outage")).rejects.toThrow(/500|destroy project/u);
  });
});
