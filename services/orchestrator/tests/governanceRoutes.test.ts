// Route tests for the per-project GOVERNANCE surface (apex.md "missing endpoint →
// add it"): the supported way to flip an existing project to autonomous without a
// hand-crafted full-config PATCH. Drives the REAL project route handlers against
// the in-memory RoutesPool (mirrors budgetRoutes.test.ts):
//   - GET  /:orgId/projects/:projectId/governance → reviewPolicy/mergeIntegration/posture;
//   - PUT  sets the three settings (read-back reflects them; omitted keys untouched);
//   - a non-admin actor is rejected with 403 on the MUTATION (org-admin authorized);
//   - an unknown project 404s.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import { RoutesPool } from "./helpers/routesPool.js";
import { isEventStoreAppend } from "./helpers/routesPoolEvents.js";

const admin: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

const memberOnly: ActorContext = {
  userId: "user_bob",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

const otherOrgAdmin: ActorContext = {
  userId: "user_other_admin",
  orgId: "org_other",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function buildHarness(boundActor: ActorContext = admin) {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme" });
  if (boundActor.orgId !== "org_acme") pool.seedOrg({ id: boundActor.orgId });
  pool.seedMembership(
    boundActor.orgId,
    boundActor.userId,
    boundActor.scopes.includes("org:admin") ? "admin" : "member",
  );
  pool.seedProject({ project_id: "proj_1", org_id: "org_acme", config: { version: 1 } });

  return { app: buildApp(pool, boundActor), pool };
}

function buildApp(pool: RoutesPool, boundActor: ActorContext): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return boundActor;
        },
      } as never,
      localDevActor: boundActor,
    }),
  );
  // `secrets`/`githubHttp` are only used by the greenfield create path, never by
  // the governance routes — stubbed for construction only.
  app.route("/orgs", createProjectRoutes({ pool: pool.asPgPool(), secrets: {} as never, githubHttp: {} as never }));
  return app;
}

class InterleavingRoutesPool extends RoutesPool {
  private configReadCount = 0;
  private releaseFirstRead: (() => void) | undefined;
  private firstReadSeen: (() => void) | undefined;
  readonly memberSnapshotRead = new Promise<void>((resolve) => {
    this.firstReadSeen = resolve;
  });
  private readonly memberMayContinue = new Promise<void>((resolve) => {
    this.releaseFirstRead = resolve;
  });

  allowMemberToContinue(): void {
    this.releaseFirstRead?.();
  }

  override async query(sql: string, params: unknown[] = []) {
    const isConfigRead =
      sql.trim().startsWith("SELECT org_id, config FROM projects WHERE project_id = $1") ||
      sql.trim().startsWith("SELECT config FROM projects WHERE project_id = $1");
    if (isConfigRead) {
      this.configReadCount += 1;
      if (this.configReadCount === 1) {
        const result = await super.query(sql, params);
        this.firstReadSeen?.();
        await this.memberMayContinue;
        return result;
      }
    }
    return super.query(sql, params);
  }
}

class EventFailingRoutesPool extends RoutesPool {
  private configSnapshot: unknown;

  override async query(sql: string, params: unknown[] = []) {
    const trimmed = sql.trim();
    if (trimmed === "BEGIN") {
      this.configSnapshot = structuredClone(this.projects.get("proj_1")?.config);
    }
    if (isEventStoreAppend(trimmed)) {
      throw new Error("simulated event append failure");
    }
    const result = await super.query(sql, params);
    if (trimmed === "ROLLBACK") {
      const project = this.projects.get("proj_1");
      if (project !== undefined) project.config = structuredClone(this.configSnapshot);
    }
    return result;
  }
}

async function getJson(app: Hono<ActorContextEnv>, path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function putJson(
  app: Hono<ActorContextEnv>,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("project governance routes", () => {
  it("reads the schema defaults when no governance is configured", async () => {
    const { app } = buildHarness();
    const { status, body } = await getJson(app, "/orgs/org_acme/projects/proj_1/governance");
    expect(status).toBe(200);
    expect(body.reviewPolicy).toBe("human");
    expect(body.mergeIntegration).toBe("not_configured");
    expect(body.governancePosture).toBe("strict");
  });

  it("flips a project to autonomous and the read-back reflects it (round-trip)", async () => {
    const { app } = buildHarness();
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", {
      reviewPolicy: "auto",
      mergeIntegration: "native_queue",
    });
    expect(put.status).toBe(200);
    expect(put.body.reviewPolicy).toBe("auto");
    expect(put.body.mergeIntegration).toBe("native_queue");
    // Unset field keeps its current (default) value.
    expect(put.body.governancePosture).toBe("strict");

    const get = await getJson(app, "/orgs/org_acme/projects/proj_1/governance");
    expect(get.body.reviewPolicy).toBe("auto");
    expect(get.body.mergeIntegration).toBe("native_queue");
    expect(get.body.governancePosture).toBe("strict");
  });

  // gv-1: the org-admin governance PUT is the SOLE supported path to mutate the
  // governance-owned `auditPosture` DORA knob (the member PATCH is now reserved
  // out). The config CAS + typed event append share one transaction.
  it("an admin PUT changes auditPosture and appends its one typed mutation fact", async () => {
    const { app, pool } = buildHarness();
    const before = await getJson(app, "/orgs/org_acme/projects/proj_1/governance");
    expect(before.body.auditPosture).toEqual({
      blockReviewAt: "P1",
      p2p3Handling: "fix-if-idle",
      autonomousRemediation: false,
    });

    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", {
      auditPosture: { blockReviewAt: "P3", p2p3Handling: "route-to-dag", autonomousRemediation: true },
    });
    expect(put.status).toBe(200);
    expect(put.body.auditPosture).toEqual({
      blockReviewAt: "P3",
      p2p3Handling: "route-to-dag",
      autonomousRemediation: true,
    });

    const get = await getJson(app, "/orgs/org_acme/projects/proj_1/governance");
    expect(get.body.auditPosture).toEqual({
      blockReviewAt: "P3",
      p2p3Handling: "route-to-dag",
      autonomousRemediation: true,
    });
    expect(auditPostureEvents(pool)).toEqual([
      expect.objectContaining({
        project_id: "proj_1",
        org_id: "org_acme",
        payload: {
          actorUserId: "user_alice",
          previous: {
            blockReviewAt: "P1",
            p2p3Handling: "fix-if-idle",
            autonomousRemediation: false,
          },
          current: {
            blockReviewAt: "P3",
            p2p3Handling: "route-to-dag",
            autonomousRemediation: true,
          },
        },
      }),
    ]);
  });

  it("does not fabricate a mutation fact for an auditPosture no-op", async () => {
    const { app, pool } = buildHarness();
    const posture = { blockReviewAt: "P3", p2p3Handling: "route-to-dag", autonomousRemediation: true } as const;
    expect((await putJson(app, "/orgs/org_acme/projects/proj_1/governance", { auditPosture: posture })).status).toBe(
      200,
    );
    expect((await putJson(app, "/orgs/org_acme/projects/proj_1/governance", { auditPosture: posture })).status).toBe(
      200,
    );
    expect(auditPostureEvents(pool)).toHaveLength(1);
  });

  it("rolls the config CAS back when its EventStore append fails", async () => {
    const pool = new EventFailingRoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedProject({ project_id: "proj_1", org_id: "org_acme", config: { version: 1 } });
    const app = buildApp(pool, admin);
    const before = structuredClone(pool.projects.get("proj_1")?.config);

    const response = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", {
      auditPosture: { blockReviewAt: "P3", p2p3Handling: "route-to-dag", autonomousRemediation: true },
    });
    expect(response.status).toBe(500);
    expect(pool.projects.get("proj_1")?.config).toEqual(before);
    expect(auditPostureEvents(pool)).toEqual([]);
  });

  it("does not let a stale member PATCH clobber an interleaved admin audit-posture PUT", async () => {
    const pool = new InterleavingRoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedProject({ project_id: "proj_1", org_id: "org_acme", config: { version: 1 } });
    const memberApp = buildApp(pool, memberOnly);
    const adminApp = buildApp(pool, admin);

    // Member reads first; admin wins the write; member CAS fails loud.
    const memberRequest = memberApp.request("/orgs/org_acme/projects/proj_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          version: 1,
          auditPosture: {
            blockReviewAt: "P1",
            p2p3Handling: "fix-if-idle",
            autonomousRemediation: false,
          },
          credentials: { githubCredentialRef: "credential/member-stale" },
        },
      }),
    });
    await pool.memberSnapshotRead;

    const adminPut = await putJson(adminApp, "/orgs/org_acme/projects/proj_1/governance", {
      auditPosture: { blockReviewAt: "P3", p2p3Handling: "route-to-dag", autonomousRemediation: true },
    });
    expect(adminPut.status).toBe(200);

    pool.allowMemberToContinue();
    const memberResponse = await memberRequest;
    expect(memberResponse.status).toBe(409);
    await expect(memberResponse.json()).resolves.toMatchObject({
      error: "project_config_conflict",
    });
    expect(pool.projects.get("proj_1")?.config).toMatchObject({
      auditPosture: { blockReviewAt: "P3", p2p3Handling: "route-to-dag", autonomousRemediation: true },
    });
    expect(pool.projects.get("proj_1")?.config).not.toMatchObject({
      credentials: { githubCredentialRef: "credential/member-stale" },
    });
    expect(auditPostureEvents(pool)).toHaveLength(1);
  });

  // Reverse interleaving: admin reads first, member credential PATCH wins, admin
  // CAS fails loud so a stale admin posture write cannot erase the member field.
  it("does not let a stale admin governance PUT clobber an interleaved member credential PATCH", async () => {
    const pool = new InterleavingRoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedProject({ project_id: "proj_1", org_id: "org_acme", config: { version: 1 } });
    const memberApp = buildApp(pool, memberOnly);
    const adminApp = buildApp(pool, admin);

    const adminRequest = adminApp.request("/orgs/org_acme/projects/proj_1/governance", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        auditPosture: { blockReviewAt: "P3", p2p3Handling: "route-to-dag", autonomousRemediation: true },
      }),
    });
    await pool.memberSnapshotRead;

    const memberPatch = await memberApp.request("/orgs/org_acme/projects/proj_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          version: 1,
          auditPosture: {
            blockReviewAt: "P1",
            p2p3Handling: "fix-if-idle",
            autonomousRemediation: false,
          },
          credentials: { githubCredentialRef: "credential/member-wins" },
        },
      }),
    });
    expect(memberPatch.status).toBe(200);

    pool.allowMemberToContinue();
    const adminResponse = await adminRequest;
    expect(adminResponse.status).toBe(409);
    await expect(adminResponse.json()).resolves.toMatchObject({
      error: "project_config_conflict",
    });
    expect(pool.projects.get("proj_1")?.config).toMatchObject({
      credentials: { githubCredentialRef: "credential/member-wins" },
      auditPosture: {
        blockReviewAt: "P1",
        p2p3Handling: "fix-if-idle",
        autonomousRemediation: false,
      },
    });
    expect(pool.projects.get("proj_1")?.config).not.toMatchObject({
      auditPosture: { blockReviewAt: "P3", p2p3Handling: "route-to-dag", autonomousRemediation: true },
    });
    expect(auditPostureEvents(pool)).toEqual([]);
  });

  it("updates only the named field, leaving the others untouched", async () => {
    const { app } = buildHarness();
    await putJson(app, "/orgs/org_acme/projects/proj_1/governance", {
      reviewPolicy: "simulated",
      mergeIntegration: "native_queue",
    });
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", { governancePosture: "open" });
    expect(put.status).toBe(200);
    expect(put.body.reviewPolicy).toBe("simulated");
    expect(put.body.mergeIntegration).toBe("native_queue");
    expect(put.body.governancePosture).toBe("open");
  });

  it("rejects an unknown reviewPolicy value with 400", async () => {
    const { app, pool } = buildHarness();
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", { reviewPolicy: "nope" });
    expect(put.status).toBe(400);
    expect(auditPostureEvents(pool)).toEqual([]);
  });

  it("404s an unknown project", async () => {
    const { app } = buildHarness();
    const { status } = await getJson(app, "/orgs/org_acme/projects/nope/governance");
    expect(status).toBe(404);
  });

  it("rejects a governance mutation from a non-admin actor with 403", async () => {
    const { app, pool } = buildHarness(memberOnly);
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", { reviewPolicy: "auto" });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe("org_admin_required");
    expect(auditPostureEvents(pool)).toEqual([]);
  });

  it("does not let an admin of another org mutate this project's governance", async () => {
    const { app, pool } = buildHarness(otherOrgAdmin);
    const before = pool.projects.get("proj_1")?.config;
    const put = await putJson(app, "/orgs/org_other/projects/proj_1/governance", {
      auditPosture: { blockReviewAt: "P3", p2p3Handling: "route-to-dag", autonomousRemediation: true },
    });
    expect(put.status).toBe(404);
    expect(put.body.error).toBe("project_not_found");
    expect(pool.projects.get("proj_1")?.config).toEqual(before);
    expect(auditPostureEvents(pool)).toEqual([]);
  });

  it("a reserved member PATCH cannot mutate posture or fabricate its success event", async () => {
    const { app, pool } = buildHarness(memberOnly);
    const before = pool.projects.get("proj_1")?.config;
    const response = await app.request("/orgs/org_acme/projects/proj_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          version: 1,
          auditPosture: {
            blockReviewAt: "P3",
            p2p3Handling: "route-to-dag",
            autonomousRemediation: true,
          },
        },
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "reserved_project_config_patch",
      fields: ["auditPosture"],
    });
    expect(pool.projects.get("proj_1")?.config).toEqual(before);
    expect(auditPostureEvents(pool)).toEqual([]);
  });

  it("allows a non-admin member to READ governance", async () => {
    const { app } = buildHarness(memberOnly);
    const { status } = await getJson(app, "/orgs/org_acme/projects/proj_1/governance");
    expect(status).toBe(200);
  });
});

function auditPostureEvents(pool: RoutesPool): Array<Record<string, unknown>> {
  return pool.events.filter((event) => event["event_type"] === "governance.audit_posture.updated");
}
