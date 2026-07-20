import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeQueueScheduleRoutes } from "../src/routes/mergeQueue/schedule.js";

class ProjectionPool {
  public queueRows: unknown[] = [];
  public leaseRows: unknown[] = [];
  public mergedRows: unknown[] = [];
  public projectOrg: string | undefined = "org_schedule";

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
    if (sql.includes("FROM merge_queue mq JOIN specs"))
      return { rows: this.queueRows, rowCount: this.queueRows.length };
    if (sql.includes("FROM merge_queue mq LEFT JOIN merge_queue_partitions")) {
      return { rows: this.leaseRows, rowCount: this.leaseRows.length };
    }
    if (sql.includes("SELECT spec_id FROM specs")) return { rows: this.mergedRows, rowCount: this.mergedRows.length };
    return { rows: [], rowCount: 1 };
  }

  public asPgPool(): never {
    return this as never;
  }
}

describe("merge queue semantic schedule projection", () => {
  it("reports unknown persisted facts as a serial all-scopes barrier", async () => {
    const pool = new ProjectionPool();
    pool.queueRows = [
      {
        queue_id: "queue_unknown",
        run_id: "run_unknown",
        spec_id: "spec_unknown",
        depends_on: [],
        scope_fingerprint: null,
      },
      {
        queue_id: "queue_other",
        run_id: "run_other",
        spec_id: "spec_other",
        depends_on: [],
        scope_fingerprint: semanticFingerprint("path:services/worker/src"),
      },
    ];

    const response = await app(pool).request("/org_schedule/projects/project_schedule/merge-queue/schedule");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.schedule.selectedRunIds).toEqual(["run_unknown"]);
    expect(body.schedule.partitions.find((partition) => partition.specId === "spec_unknown")).toMatchObject({
      classes: ["all_scopes"],
      conservative: true,
    });
  });

  it("does not present a candidate whose persisted partition conflicts with a live lease", async () => {
    const pool = new ProjectionPool();
    pool.queueRows = [
      {
        queue_id: "queue_a",
        run_id: "run_a",
        spec_id: "spec_a",
        depends_on: [],
        scope_fingerprint: semanticFingerprint("path:services/worker/src"),
      },
    ];
    pool.leaseRows = [
      {
        partition_id: "partition_a",
        lease_owner: "owner_a",
        lease_epoch: 2,
        generation: 3,
        scope_key: semanticFingerprint("path:services/worker/src"),
      },
    ];

    const response = await app(pool).request("/org_schedule/projects/project_schedule/merge-queue/schedule");

    await expect(response.json()).resolves.toMatchObject({
      schedule: { selectedRunIds: [], blockers: ["leased_partition:spec_a"], activeLeases: [{ leaseEpoch: 2 }] },
    });
  });

  it("hides the projection from an actor outside the organization", async () => {
    await expect(
      app(new ProjectionPool(), { ...platformActor(), orgId: "org_other", scopes: ["org:member"] }).request(
        "/org_schedule/projects/project_schedule/merge-queue/schedule",
      ),
    ).resolves.toMatchObject({ status: 404 });
  });
});

function app(pool: ProjectionPool, actor = platformActor()): Hono<ActorContextEnv> {
  const router = new Hono<ActorContextEnv>();
  router.onError((_error, context) => context.text("schedule projection rejected", 500));
  router.use("*", async (context, next) => {
    context.set("actor", actor);
    await next();
  });
  router.route("/", createMergeQueueScheduleRoutes({ pool: pool.asPgPool() }));
  return router;
}

function platformActor(): ActorContext {
  return { userId: "user_admin", orgId: null, projectId: null, scopes: ["platform:admin"], source: "local_dev" };
}

function semanticFingerprint(scope: string): string {
  return `semantic:v1:${encodeURIComponent(scope)}`;
}
