// in-2: HTTP validate + catalog under free /orgs parent (behaviors thin wire).

import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { CasArtifactBytes, CasArtifactRef, CasByteStore, Digest } from "../src/engine/contracts/cas.js";
import { parseDigest } from "../src/engine/contracts/cas.js";
import {
  canonicalRequirementBytes,
  goldenControlNotifyRequirement,
  goldenCrossPlaneForbiddenRequirement,
  goldenProductMessagingRequirement,
} from "../src/engine/contracts/integrationRequirement.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createBehaviorRoutes } from "../src/routes/behaviors/index.js";
import { registerIntegrationContractRoutes } from "../src/routes/integrationContracts/index.js";

const alice: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

class MemoryCas implements CasByteStore {
  readonly store = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  puts = 0;

  async put(input: {
    readonly orgId: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<CasArtifactRef> {
    this.puts += 1;
    const hex = createHash("sha256").update(input.bytes).digest("hex");
    const digest = parseDigest(`sha256:${hex}`);
    this.store.set(`${input.orgId}:${digest}`, { bytes: input.bytes, mediaType: input.mediaType });
    return { digest, byteSize: input.bytes.byteLength, mediaType: input.mediaType };
  }

  async get(orgId: string, digest: Digest): Promise<CasArtifactBytes> {
    const row = this.store.get(`${orgId}:${digest}`);
    if (row === undefined) throw new Error("missing");
    return { digest, bytes: row.bytes, mediaType: row.mediaType };
  }

  async has(orgId: string, digest: Digest): Promise<boolean> {
    return this.store.has(`${orgId}:${digest}`);
  }
}

/** Pool unused by integration-contract routes when casByteStore is injected. */
class EmptyPool {
  async query(): Promise<{ rows: unknown[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }
  async connect(): Promise<{
    query: () => Promise<{ rows: unknown[]; rowCount: number }>;
    release: () => void;
  }> {
    return {
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => {},
    };
  }
  asPgPool(): Pool {
    return this as unknown as Pool;
  }
}

function buildHarness(cas: CasByteStore, actor: ActorContext = alice) {
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actor;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  const contracts = new Hono<ActorContextEnv>();
  registerIntegrationContractRoutes(contracts, {
    pool: new EmptyPool().asPgPool(),
    casByteStore: cas,
  });
  app.route("/orgs", contracts);
  return app;
}

/** Proves the production thin wire on createBehaviorRoutes exposes catalog. */
function buildProductionWireHarness(actor: ActorContext = alice) {
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actor;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  // Catalog does not need CAS; validate on this path would hit PgCasByteStore.
  app.route("/orgs", createBehaviorRoutes({ pool: new EmptyPool().asPgPool() }));
  return app;
}

describe("integration-contracts HTTP (in-2)", () => {
  it("GET catalog returns plane/capability discriminators", async () => {
    const app = buildHarness(new MemoryCas());
    const res = await app.request("/orgs/org_acme/integration-contracts/catalog", {
      headers: { cookie: "tanren_session=dev" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["missionNodeId"]).toBe("in-2");
    expect(body["domainTag"]).toBe("integration_requirement.v1");
    expect(body["planes"]).toEqual(["control", "product"]);
    expect(Array.isArray(body["productCapabilities"])).toBe(true);
    expect(Array.isArray(body["controlBindingKinds"])).toBe(true);
  });

  it("production behaviors thin wire mounts catalog", async () => {
    const app = buildProductionWireHarness();
    const res = await app.request("/orgs/org_acme/integration-contracts/catalog", {
      headers: { cookie: "tanren_session=dev" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["missionNodeId"]).toBe("in-2");
  });

  it("POST validate product messaging persists CAS artifact + digests", async () => {
    const cas = new MemoryCas();
    const app = buildHarness(cas);
    const res = await app.request("/orgs/org_acme/integration-contracts:validate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body: JSON.stringify({ requirement: goldenProductMessagingRequirement() }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["missionNodeId"]).toBe("in-2");
    expect(body["plane"]).toBe("product");
    // R3: real callers default to persisting; state is honestly reported.
    expect(body["persisted"]).toBe(true);
    expect(String(body["requirementDigest"])).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const artifact = body["artifact"] as Record<string, unknown>;
    expect(String(artifact["digest"])).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(artifact["mediaType"]).toBe("application/vnd.tanren.integration-requirement.v1+json");
    expect(cas.puts).toBe(1);
    expect(cas.store.size).toBe(1);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/xoxb-/u);
  });

  it("POST validate default persists exactly once and is idempotent at the identity level", async () => {
    const cas = new MemoryCas();
    const app = buildHarness(cas);
    const body = JSON.stringify({ requirement: goldenProductMessagingRequirement() });
    const first = await app.request("/orgs/org_acme/integration-contracts:validate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body,
    });
    expect(first.status).toBe(200);
    const second = await app.request("/orgs/org_acme/integration-contracts:validate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body,
    });
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { artifact: { digest: string }; persisted: boolean };
    const secondBody = (await second.json()) as { artifact: { digest: string }; persisted: boolean };
    // Both persist (R3: real callers persist every time); identity is stable.
    expect(firstBody.persisted).toBe(true);
    expect(secondBody.persisted).toBe(true);
    expect(secondBody.artifact.digest).toBe(firstBody.artifact.digest);
    // One put per request (MemoryCas does not dedup by conflict, but the SAME
    // canonical key collapses to a single stored entry).
    expect(cas.puts).toBe(2);
    expect(cas.store.size).toBe(1);
  });

  it("POST validate with persist:false performs zero CAS puts and reports persisted:false", async () => {
    const cas = new MemoryCas();
    const app = buildHarness(cas);
    const requirement = goldenProductMessagingRequirement();
    const res = await app.request("/orgs/org_acme/integration-contracts:validate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body: JSON.stringify({ requirement, persist: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["persisted"]).toBe(false);
    // R3: non-persisting mode still runs full parse + both digests.
    expect(String(body["requirementDigest"])).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const artifact = body["artifact"] as Record<string, unknown>;
    expect(String(artifact["digest"])).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // The would-be content digest equals sha256 of the canonical bytes (the same
    // identity CAS would assign on put) — computed, never stored.
    const expectedContent = `sha256:${createHash("sha256").update(canonicalRequirementBytes(requirement)).digest("hex")}`;
    expect(artifact["digest"]).toBe(expectedContent);
    // Zero CAS puts: the read-only sample path never mutates cas_artifacts.
    expect(cas.puts).toBe(0);
    expect(cas.store.size).toBe(0);
  });

  it("POST validate with persist:false still rejects invalid input with 422 and never persists", async () => {
    const cas = new MemoryCas();
    const app = buildHarness(cas);
    const res = await app.request("/orgs/org_acme/integration-contracts:validate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body: JSON.stringify({ requirement: goldenCrossPlaneForbiddenRequirement(), persist: false }),
    });
    expect(res.status).toBe(422);
    expect(cas.puts).toBe(0);
  });

  it("POST validate rejects persist:false with malformed envelope (400, no put)", async () => {
    const cas = new MemoryCas();
    const app = buildHarness(cas);
    const res = await app.request("/orgs/org_acme/integration-contracts:validate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body: JSON.stringify({ requirement: goldenProductMessagingRequirement(), persist: "not-a-bool" }),
    });
    // strict() rejects the non-boolean persist at the envelope schema layer.
    expect(res.status).toBe(400);
    expect(cas.puts).toBe(0);
  });

  it("POST validate control notify succeeds on control plane", async () => {
    const app = buildHarness(new MemoryCas());
    const res = await app.request("/orgs/org_acme/integration-contracts:validate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body: JSON.stringify({ requirement: goldenControlNotifyRequirement() }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["plane"]).toBe("control");
    expect(body["capability"]).toBe("control.notify");
  });

  it("POST validate rejects cross-plane control-as-product with 422", async () => {
    const cas = new MemoryCas();
    const app = buildHarness(cas);
    const res = await app.request("/orgs/org_acme/integration-contracts:validate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body: JSON.stringify({ requirement: goldenCrossPlaneForbiddenRequirement() }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; errors: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors.some((e) => e.code === "binding_plane_mismatch")).toBe(true);
    expect(cas.puts).toBe(0);
  });

  it("denies other-org access with 403", async () => {
    const app = buildHarness(new MemoryCas());
    const res = await app.request("/orgs/org_other/integration-contracts/catalog", {
      headers: { cookie: "tanren_session=dev" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("org_access_denied");
  });

  it("rejects malformed envelope with 400", async () => {
    const app = buildHarness(new MemoryCas());
    const res = await app.request("/orgs/org_acme/integration-contracts:validate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body: JSON.stringify({ notRequirement: true }),
    });
    expect(res.status).toBe(400);
  });
});
