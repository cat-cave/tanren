// ds-6 — the DesignDeliveryProofV1 read route, exercised through the REAL mounted Hono app
// (createDesignStudioRoutes) with an injected actor + a fake org-scoped pool. Proves the
// surface is VISIBILITY, not execution: a GET returns the fail-closed trace (a project with
// no live production release yields a `blocked_no_live_release` proof, never a fabricated A4
// ≡ demo), a cross-org request is denied, and the endpoint exposes NO run-command (POST) verb.

import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createDesignStudioRoutes } from "../src/routes/designStudio/reads.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";

const ADMIN: ActorContext = {
  userId: "admin",
  orgId: "org-a",
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};

/** A fake org-scoped pool answering txn control, the project-access gate, and an EMPTY
 * `release_instances` read (no live production delivery → the route returns a blocked trace). */
function fakePool(projectOrgId: string | null): pg.Pool {
  const client = {
    query: vi.fn<(sql: string) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>>(async (sql) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT org_id FROM projects")) {
        return {
          rows: projectOrgId === null ? [] : [{ org_id: projectOrgId }],
          rowCount: projectOrgId === null ? 0 : 1,
        };
      }
      if (sql.includes("FROM project_members")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM release_instances")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    release: vi.fn<() => void>(),
  };
  return { connect: vi.fn<() => Promise<typeof client>>(async () => client) } as unknown as pg.Pool;
}

function harness(actor: ActorContext = ADMIN, projectOrgId = "org-a") {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/v1/orgs", createDesignStudioRoutes({ pool: fakePool(projectOrgId) }));
  return app;
}

describe("ds-6 design-delivery-proof read route (visibility, not execution)", () => {
  it("returns a fail-closed `blocked_no_live_release` trace when no production delivery exists", async () => {
    const res = await harness().request("/v1/orgs/org-a/projects/project-a/design-delivery-proof");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      proof: { equivalence: string; preMerge: unknown; production: unknown; boundKey: unknown };
    };
    expect(body.proof.equivalence).toBe("blocked_no_live_release");
    expect(body.proof.preMerge).toBeNull();
    expect(body.proof.production).toBeNull();
    expect(body.proof.boundKey).toBeNull();
  });

  it("denies a cross-org request (RLS-aligned org access gate)", async () => {
    const res = await harness().request("/v1/orgs/org-b/projects/project-a/design-delivery-proof");
    expect(res.status).toBe(403);
  });

  it("exposes NO run-command verb — a POST to the trace is not a registered route (404)", async () => {
    const res = await harness().request("/v1/orgs/org-a/projects/project-a/design-delivery-proof", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
