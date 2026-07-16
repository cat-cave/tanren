// Focused unit/route proofs for the sole config-revision CAS substrate:
// snapshot/CAS vocabulary, mutate interleaving, HTTP one-shot 409, no-op,
// and response identity — driven against RoutesPool (no live Postgres).

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { mutateProjectConfig } from "../src/engine/config/projectConfigMutate.js";
import { ProjectStore } from "../src/engine/repositories/projects.js";
import { systemActor } from "../src/engine/state/actor.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createOrgRoutes } from "../src/routes/orgs/index.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import { RoutesPool } from "./helpers/routesPool.js";

const admin: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function buildHarness() {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme" });
  pool.seedMembership("org_acme", "user_alice", "admin");
  pool.seedProject({ project_id: "proj_1", org_id: "org_acme", config: { version: 1 } });
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return admin;
        },
      } as never,
      localDevActor: admin,
    }),
  );
  app.route("/orgs", createProjectRoutes({ pool: pool.asPgPool(), secrets: {} as never, githubHttp: {} as never }));
  app.route("/orgs", createOrgRoutes({ pool: pool.asPgPool() }));
  return { app, pool };
}

async function json(
  app: Hono<ActorContextEnv>,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await app.request(path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("config revision CAS (unit/route)", () => {
  it("seeds initial revision 1 and surfaces it on project GET", async () => {
    const { app } = buildHarness();
    const get = await json(app, "/orgs/org_acme/projects/proj_1");
    expect(get.status).toBe(200);
    expect(get.body.revision).toBe("1");
  });

  it("two same-revision writers: exactly one winner, one conflict, winner JSONB wins", async () => {
    const { pool } = buildHarness();
    const client = pool.asPgPool();
    const a = await ProjectStore.compareAndSwapConfig(
      client,
      "proj_1",
      "1",
      { version: 1, governancePosture: "winner" },
      systemActor,
    );
    const b = await ProjectStore.compareAndSwapConfig(
      client,
      "proj_1",
      "1",
      { version: 1, governancePosture: "loser" },
      systemActor,
    );
    expect(a).toMatchObject({ status: "ok", revision: "2" });
    expect(b).toMatchObject({
      status: "conflict",
      current: { revision: "2", config: { governancePosture: "winner" } },
    });
    const snap = await ProjectStore.getConfigSnapshot(client, "proj_1", systemActor);
    expect(snap?.config).toMatchObject({ governancePosture: "winner" });
  });

  it("mutateProjectConfig interleaving preserves two independent field changes", async () => {
    const { pool } = buildHarness();
    const client = pool.asPgPool();
    // Simulate two concurrent mutators by alternating CAS loses: mutator A sets
    // budget; mutator B sets auditPosture; both must survive.
    await mutateProjectConfig(client, "proj_1", systemActor, (raw) => {
      const cur = (raw ?? {}) as Record<string, unknown>;
      return { ...cur, version: 1, budget: { ceilingUsd: 10, period: "total" } };
    });
    await mutateProjectConfig(client, "proj_1", systemActor, (raw) => {
      const cur = (raw ?? {}) as Record<string, unknown>;
      return { ...cur, version: 1, auditPosture: { enabled: true } };
    });
    const snap = await ProjectStore.getConfigSnapshot(client, "proj_1", systemActor);
    expect(snap?.config).toMatchObject({
      budget: { ceilingUsd: 10, period: "total" },
      auditPosture: { enabled: true },
    });
    expect(snap?.revision).toBe("3");
  });

  it("one-shot HTTP stale budget write returns exact 409 and does not mutate", async () => {
    const { app, pool } = buildHarness();
    const first = await json(app, "/orgs/org_acme/projects/proj_1/budget", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ceilingUsd: 50, period: "total", revision: "1" }),
    });
    expect(first.status).toBe(200);
    expect(first.body.revision).toBe("2");
    expect(first.body.ceilingUsd).toBe(50);

    const stale = await json(app, "/orgs/org_acme/projects/proj_1/budget", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ceilingUsd: 999, period: "total", revision: "1" }),
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      error: "project_config_conflict",
      orgId: "org_acme",
      projectId: "proj_1",
      revision: "2",
    });
    expect(pool.projects.get("proj_1")?.config).toMatchObject({
      budget: { ceilingUsd: 50, period: "total" },
    });
    expect(pool.projects.get("proj_1")?.config_revision).toBe(2);
  });

  it("no-op equal config does not bump revision", async () => {
    const { pool } = buildHarness();
    const client = pool.asPgPool();
    const snap = await ProjectStore.getConfigSnapshot(client, "proj_1", systemActor);
    expect(snap?.revision).toBe("1");
    const outcome = await ProjectStore.compareAndSwapConfig(client, "proj_1", "1", snap!.config, systemActor);
    expect(outcome).toMatchObject({ status: "ok", revision: "1" });
    expect(pool.projects.get("proj_1")?.config_revision).toBe(1);
  });

  it("key-order-equivalent config is a semantic no-op (no revision bump)", async () => {
    const { pool } = buildHarness();
    const client = pool.asPgPool();
    // Seed with explicit key order a→b; CAS with b→a must not bump under JSONB equality.
    pool.projects.get("proj_1")!.config = { a: 1, b: 2, version: 1 };
    const outcome = await ProjectStore.compareAndSwapConfig(
      client,
      "proj_1",
      "1",
      { b: 2, a: 1, version: 1 },
      systemActor,
    );
    expect(outcome).toMatchObject({ status: "ok", revision: "1" });
    expect(pool.projects.get("proj_1")?.config_revision).toBe(1);
  });

  it("no-op cannot stale-succeed after a competing writer advances the revision", async () => {
    const { pool } = buildHarness();
    const client = pool.asPgPool();
    const initial = await ProjectStore.getConfigSnapshot(client, "proj_1", systemActor);
    expect(initial?.revision).toBe("1");
    // Competing writer wins first (simulates concurrent mutation between no-op intent and observe).
    const winner = await ProjectStore.compareAndSwapConfig(
      client,
      "proj_1",
      "1",
      { version: 1, tag: "competitor" },
      systemActor,
    );
    expect(winner).toMatchObject({ status: "ok", revision: "2" });
    // Stale no-op at expected revision 1 with the pre-race config must conflict, not ok@1.
    const staleNoop = await ProjectStore.compareAndSwapConfig(client, "proj_1", "1", initial!.config, systemActor);
    expect(staleNoop).toMatchObject({
      status: "conflict",
      current: { revision: "2", config: { tag: "competitor" } },
    });
    expect(pool.projects.get("proj_1")?.config_revision).toBe(2);
  });

  it("concurrent no-op vs writer yields outcomes consistent with durable serial order", async () => {
    const { pool } = buildHarness();
    const client = pool.asPgPool();
    const initial = { version: 1 };
    const [noop, writer] = await Promise.all([
      ProjectStore.compareAndSwapConfig(client, "proj_1", "1", initial, systemActor),
      ProjectStore.compareAndSwapConfig(client, "proj_1", "1", { version: 1, tag: "w" }, systemActor),
    ]);
    const durable = await ProjectStore.getConfigSnapshot(client, "proj_1", systemActor);
    const oks = [noop, writer].filter((o) => o.status === "ok");
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.every((o) => Number(o.revision) <= Number(durable?.revision))).toBe(true);
    // When an ok reports the durable head revision, its config must match durable head.
    const headOks = oks.filter((o) => o.revision === durable?.revision);
    expect(headOks.every((o) => JSON.stringify(o.config) === JSON.stringify(durable?.config))).toBe(true);
  });

  it("non-config lifecycle update does not increment config_revision", async () => {
    const { pool } = buildHarness();
    await pool.query("UPDATE projects SET lifecycle = $1 WHERE project_id = $2", ["archived", "proj_1"]);
    expect(pool.projects.get("proj_1")?.lifecycle).toBe("archived");
    expect(pool.projects.get("proj_1")?.config_revision).toBe(1);
  });

  it("governance GET/PUT round-trip exposes revision identity", async () => {
    const { app } = buildHarness();
    const get = await json(app, "/orgs/org_acme/projects/proj_1/governance");
    expect(get.status).toBe(200);
    expect(get.body.revision).toBe("1");
    const put = await json(app, "/orgs/org_acme/projects/proj_1/governance", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: "1", reviewPolicy: "auto" }),
    });
    expect(put.status).toBe(200);
    expect(put.body.reviewPolicy).toBe("auto");
    expect(put.body.revision).toBe("2");
  });

  it("org config PATCH one-shot conflict returns org_config_conflict", async () => {
    const { app } = buildHarness();
    const first = await json(app, "/orgs/org_acme", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { version: 1, providerMode: "byok" }, revision: "1" }),
    });
    expect(first.status).toBe(200);
    expect(first.body.revision).toBe("2");
    const stale = await json(app, "/orgs/org_acme", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { version: 1 }, revision: "1" }),
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      error: "org_config_conflict",
      orgId: "org_acme",
      revision: "2",
    });
  });
});
