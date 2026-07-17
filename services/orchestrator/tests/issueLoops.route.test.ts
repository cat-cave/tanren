import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createIssueLoopRoutes } from "../src/routes/issueLoops/index.js";

const ACTOR: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function missingLoopPool(): pg.Pool {
  const client = {
    async query(sql: string) {
      if (sql === "BEGIN" || sql.startsWith("SET LOCAL") || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM issue_loops")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

function buildHarness() {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ACTOR);
    await next();
  });
  app.route("/orgs", createIssueLoopRoutes({ pool: missingLoopPool() }));
  return app;
}

describe("IssueLoop detail route", () => {
  it("returns 404 when a loop is missing from the addressed org", async () => {
    const response = await buildHarness().request("/orgs/org_acme/projects/project_a/issue-loops/loop_missing");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "issue_loop_not_found",
      message: "issue loop loop_missing not found",
    });
  });
});
