import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeQueueEagerBeamRoutes } from "../src/routes/mergeQueue/eagerBeams.js";

const BASE_SHA = "a".repeat(40);
const FRONTIER_SHA = "c".repeat(40);

class ProjectionPool {
  public rows: unknown[] = [];
  public projectOrg: string | undefined = "org_eager";

  public async connect(): Promise<this> {
    return this;
  }

  public release(): void {}

  public async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("SELECT org_id FROM projects")) {
      return this.projectOrg === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ org_id: this.projectOrg }], rowCount: 1 };
    }
    if (sql.includes("FROM merge_eager_beams b")) return { rows: this.rows, rowCount: this.rows.length };
    return { rows: [], rowCount: 1 };
  }

  public asPgPool(): never {
    return this as never;
  }
}

describe("EAGER beam read projection", () => {
  it("admits only the declared beam and node states", async () => {
    const pool = new ProjectionPool();
    const app = eagerBeamApp(pool);

    for (const row of [beamRow("queued", "ready"), beamRow("ready", "merging")]) {
      pool.rows = [row];
      expect((await app.request("/org_eager/projects/project_eager/merge-queue/eager-beams")).status).toBe(500);
    }

    pool.rows = [beamRow("held", null)];
    const accepted = await app.request("/org_eager/projects/project_eager/merge-queue/eager-beams");
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ beams: [{ state: "held", evidenceState: "not_built" }] });
  });

  it("does not leak a projection when the actor is absent, out of org, or denied project access", async () => {
    const pool = new ProjectionPool();
    const missingActor = new Hono<ActorContextEnv>();
    missingActor.onError((_error, context) => context.text("eager beam projection rejected", 500));
    missingActor.route("/", createMergeQueueEagerBeamRoutes({ pool: pool.asPgPool() }));
    expect((await missingActor.request("/org_eager/projects/project_eager/merge-queue/eager-beams")).status).toBe(500);

    const otherOrgApp = eagerBeamApp(pool, { ...platformActor(), orgId: "org_other", scopes: ["org:member"] });
    await expect(
      otherOrgApp.request("/org_eager/projects/project_eager/merge-queue/eager-beams"),
    ).resolves.toMatchObject({
      status: 404,
    });

    pool.projectOrg = "org_other";
    await expect(
      eagerBeamApp(pool).request("/org_eager/projects/project_eager/merge-queue/eager-beams"),
    ).resolves.toMatchObject({
      status: 404,
    });

    pool.projectOrg = undefined;
    await expect(
      eagerBeamApp(pool).request("/org_eager/projects/project_eager/merge-queue/eager-beams"),
    ).resolves.toMatchObject({
      status: 404,
    });
  });
});

function eagerBeamApp(pool: ProjectionPool, actor = platformActor()): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.onError((_error, context) => context.text("eager beam projection rejected", 500));
  app.use("*", async (context, next) => {
    context.set("actor", actor);
    await next();
  });
  app.route("/", createMergeQueueEagerBeamRoutes({ pool: pool.asPgPool() }));
  return app;
}

function platformActor(): ActorContext {
  return {
    userId: "user_admin",
    orgId: null,
    projectId: null,
    scopes: ["platform:admin"],
    source: "local_dev",
  };
}

function beamRow(state: string, nodeStatus: string | null) {
  return {
    id: "beam_eager",
    frontier_run_id: "run_frontier",
    frontier_spec_id: "spec_frontier",
    plan_digest: `sha256:${"d".repeat(64)}`,
    integration_node_id: nodeStatus === null ? null : "node_eager",
    rank: 1,
    generation: 1,
    state,
    stale_reason: null,
    updated_at: new Date("2026-07-20T00:00:00.000Z"),
    base_sha: BASE_SHA,
    members: [{ specId: "spec_frontier", runId: "run_frontier", branch: "feature/frontier", headSha: FRONTIER_SHA }],
    node_status: nodeStatus,
    proof_root: null,
  };
}
