// Route tests for the per-project GOVERNANCE surface + gv-1 auditPosture authority:
//   - GET/PUT governance settings via revision CAS
//   - org-admin mutation; member PATCH cannot change auditPosture
//   - actual auditPosture transition emits governance.audit_posture.updated once
//   - rejected / no-op / event-fail paths leave no success fact (and fail closed)

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import { isEventStoreAppend } from "./helpers/routesPoolEvents.js";
import { RoutesPool } from "./helpers/routesPool.js";

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

const STRICT_POSTURE = {
  blockReviewAt: "P3" as const,
  p2p3Handling: "route-to-dag" as const,
  autonomousRemediation: true,
};

const DEFAULT_POSTURE = {
  blockReviewAt: "P1" as const,
  p2p3Handling: "fix-if-idle" as const,
  autonomousRemediation: false,
};

/** Memory-pool that restores config on ROLLBACK so event-append failure is fail-closed. */
class EventFailingRoutesPool extends RoutesPool {
  private configSnapshot: unknown;
  private revisionSnapshot = 1;

  override async query(sql: string, params: unknown[] = []) {
    const trimmed = sql.trim();
    if (trimmed === "BEGIN") {
      const project = this.projects.get("proj_1");
      this.configSnapshot = structuredClone(project?.config);
      this.revisionSnapshot = project?.config_revision ?? 1;
    }
    if (isEventStoreAppend(trimmed)) {
      throw new Error("simulated event append failure");
    }
    const result = await super.query(sql, params);
    if (trimmed === "ROLLBACK") {
      const project = this.projects.get("proj_1");
      if (project !== undefined) {
        project.config = structuredClone(this.configSnapshot);
        project.config_revision = this.revisionSnapshot;
      }
    }
    return result;
  }
}

function buildHarness(boundActor: ActorContext = admin, pool: RoutesPool = new RoutesPool()) {
  pool.seedOrg({ id: "org_acme" });
  pool.seedMembership("org_acme", boundActor.userId, boundActor.scopes.includes("org:admin") ? "admin" : "member");
  if (!pool.projects.has("proj_1")) {
    pool.seedProject({ project_id: "proj_1", org_id: "org_acme", config: { version: 1 } });
  }

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
  app.route("/orgs", createProjectRoutes({ pool: pool.asPgPool(), secrets: {} as never, githubHttp: {} as never }));
  return { app, pool };
}

async function getJson(
  app: Hono<ActorContextEnv>,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function putJson(
  app: Hono<ActorContextEnv>,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : payload;
  if (body !== null && typeof body === "object" && !Array.isArray(body) && !("revision" in body)) {
    const current = await getJson(app, path);
    if (current.status === 200 && typeof current.body?.revision === "string") {
      (body as Record<string, unknown>).revision = current.body.revision;
    } else {
      (body as Record<string, unknown>).revision = "1";
    }
  }
  const res = await app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function auditPostureEvents(pool: RoutesPool): Array<Record<string, unknown>> {
  return pool.events.filter((event) => event["event_type"] === "governance.audit_posture.updated");
}

describe("project governance routes", () => {
  it("reads the schema defaults when no governance is configured", async () => {
    const { app } = buildHarness();
    const { status, body } = await getJson(app, "/orgs/org_acme/projects/proj_1/governance");
    expect(status).toBe(200);
    expect(body.reviewPolicy).toBe("human");
    expect(body.mergeIntegration).toBe("not_configured");
    expect(body.governancePosture).toBe("strict");
    expect(body.auditPosture).toEqual(DEFAULT_POSTURE);
    expect(body.revision).toBe("1");
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
    expect(put.body.governancePosture).toBe("strict");

    const get = await getJson(app, "/orgs/org_acme/projects/proj_1/governance");
    expect(get.body.reviewPolicy).toBe("auto");
    expect(get.body.mergeIntegration).toBe("native_queue");
    expect(get.body.governancePosture).toBe("strict");
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

  it("an admin PUT changes auditPosture and appends its one typed mutation fact", async () => {
    const { app, pool } = buildHarness();
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", {
      auditPosture: STRICT_POSTURE,
    });
    expect(put.status).toBe(200);
    expect(put.body.auditPosture).toEqual(STRICT_POSTURE);
    expect(put.body.revision).toBe("2");

    const get = await getJson(app, "/orgs/org_acme/projects/proj_1/governance");
    expect(get.body.auditPosture).toEqual(STRICT_POSTURE);
    expect(auditPostureEvents(pool)).toEqual([
      expect.objectContaining({
        org_id: "org_acme",
        project_id: "proj_1",
        event_type: "governance.audit_posture.updated",
        payload: {
          actorUserId: "user_alice",
          previous: DEFAULT_POSTURE,
          current: STRICT_POSTURE,
        },
      }),
    ]);
  });

  it("does not fabricate a mutation fact for an auditPosture no-op", async () => {
    const { app, pool } = buildHarness();
    expect(
      (await putJson(app, "/orgs/org_acme/projects/proj_1/governance", { auditPosture: STRICT_POSTURE })).status,
    ).toBe(200);
    expect(auditPostureEvents(pool)).toHaveLength(1);
    expect(
      (await putJson(app, "/orgs/org_acme/projects/proj_1/governance", { auditPosture: STRICT_POSTURE })).status,
    ).toBe(200);
    expect(auditPostureEvents(pool)).toHaveLength(1);
  });

  it("non-admin PUT cannot mutate posture or fabricate its success event", async () => {
    const { app, pool } = buildHarness(memberOnly);
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", {
      auditPosture: STRICT_POSTURE,
    });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe("org_admin_required");
    expect(pool.projects.get("proj_1")?.config).toEqual({ version: 1 });
    expect(auditPostureEvents(pool)).toEqual([]);
  });

  it("stale revision returns 409 with no event", async () => {
    const { app, pool } = buildHarness();
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", {
      revision: "999",
      auditPosture: STRICT_POSTURE,
    });
    expect(put.status).toBe(409);
    expect(put.body.error).toBe("project_config_conflict");
    expect(pool.projects.get("proj_1")?.config).toEqual({ version: 1 });
    expect(auditPostureEvents(pool)).toEqual([]);
  });

  it("foreign-org path is denied (403) with no event and no write", async () => {
    const { app, pool } = buildHarness();
    const put = await putJson(app, "/orgs/org_other/projects/proj_1/governance", {
      auditPosture: STRICT_POSTURE,
    });
    // actorIsOrgAdmin is org-bound; a different path org is not admin-writable.
    expect(put.status).toBe(403);
    expect(pool.projects.get("proj_1")?.config).toEqual({ version: 1 });
    expect(auditPostureEvents(pool)).toEqual([]);
  });

  it("event-append failure rolls back the posture CAS (no partial write)", async () => {
    const pool = new EventFailingRoutesPool();
    const { app } = buildHarness(admin, pool);
    // Hono surfaces the thrown append failure as 500; the org-scope ROLLBACK
    // must restore both config and revision so no partial write remains.
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", {
      auditPosture: STRICT_POSTURE,
    });
    expect(put.status).toBe(500);
    expect(pool.projects.get("proj_1")?.config).toEqual({ version: 1 });
    expect(pool.projects.get("proj_1")?.config_revision).toBe(1);
    expect(auditPostureEvents(pool)).toEqual([]);
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
    const { app } = buildHarness(memberOnly);
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", { reviewPolicy: "auto" });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe("org_admin_required");
  });

  it("allows a non-admin member to READ governance", async () => {
    const { app } = buildHarness(memberOnly);
    const { status } = await getJson(app, "/orgs/org_acme/projects/proj_1/governance");
    expect(status).toBe(200);
  });

  it("missing revision on governance PUT returns 400 (bypasses helper auto-fill)", async () => {
    const { app, pool } = buildHarness();
    const res = await app.request("/orgs/org_acme/projects/proj_1/governance", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewPolicy: "auto" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeDefined();
    expect(auditPostureEvents(pool)).toEqual([]);
  });
});
